import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkNetlist, deckAnalyses, deviceCheckGateRows, fitBandFindings, fittedModels, instanceParamClasses, netlistGateRows, type NetlistRules, type RequirementsFile, type ResultRecord, spiceValue, validateRequirements } from "../src/index.ts";

const packs = new URL("../../../technologies/", import.meta.url).pathname;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function root(t: { after: (fn: () => void) => void }): string {
	const r = mkdtempSync(join(tmpdir(), "simra-netlist-"));
	t.after(() => rmSync(r, { recursive: true, force: true }));
	writeFileSync(join(r, "simra.config.json"), JSON.stringify({ technology_dirs: [packs] }));
	return r;
}

const RULES: NetlistRules = {
	file: "cell.spice",
	subckt: "cell",
	pins: ["a", "b"],
	devices: ["npn13G2", "cap_cmim", "rppd"],
	given: { tm2_w6: { params: { len: { min: 1e-9, max: 1e-3, required: true } } } },
	wiring: { r_ohm: 50, l_h: 50e-12, c_f: 50e-15 },
	fitted: true,
	technology: "ihp-sg13",
};

test("netlist: spice values and .param expressions", () => {
	assert.equal(spiceValue("2meg"), 2e6);
	assert.equal(spiceValue("{w*2}", { w: 1e-6 }), 2e-6);
	assert.ok(Number.isNaN(spiceValue("{nope}")));
});

test("netlist: a physics parameter of a PDK device is rejected unless the rules allow it by name", (t) => {
	const r = root(t);
	const classes = instanceParamClasses(r, "ihp-sg13");
	assert.ok(Object.keys(classes).includes("hbt"));
	const text = ".param n=2\n.subckt cell a b\nxq a b 0 0 npn13G2 Nx={n} selft=0\nxc a 0 cap_cmim w=1u l=1u mm_ok=0\nxl a b tm2_w6 len=100u\nr1 a b 10\n.ends\n";
	const res = checkNetlist(text, RULES, { classes });
	assert.equal(res.errors.length, 2);
	assert.match(res.errors[0].message, /^xq: selft=0 on npn13g2: .*a parameter that changes the device physics/);
	assert.equal(res.errors[0].line, 3);
	assert.match(res.errors[1].message, /^xc: mm_ok=0 on cap_cmim/);
	const allowed = checkNetlist(text, { ...RULES, allow_params: { npn13g2: ["selft"], cap_cmim: ["mm_ok"] } }, { classes });
	assert.deepEqual(allowed.errors, []);
});

test("netlist: a declared setting (sw_nqs=1) is allowed with its value only, and can be required", (t) => {
	const r = root(t);
	const classes = instanceParamClasses(r, "ihp-sg13");
	const rules = { ...RULES, allow_params: { npn13g2: { sw_nqs: [1] } }, require_params: { npn13g2: { sw_nqs: 1 } } };
	const ok = ".subckt cell a b\nxq a b 0 0 npn13G2 Nx=2 sw_nqs=1\nr1 a b 10\n.ends\n";
	assert.deepEqual(checkNetlist(ok, rules, { classes }).errors, []);
	const zero = checkNetlist(ok.replace("sw_nqs=1", "sw_nqs=0"), rules, { classes }).errors.map((e) => e.message);
	assert.ok(zero.some((m) => /the rules require sw_nqs=1/.test(m)) && zero.some((m) => /allow only sw_nqs=1/.test(m)), zero.join("; "));
	const missing = checkNetlist(ok.replace(" sw_nqs=1", ""), rules, { classes }).errors.map((e) => e.message);
	assert.deepEqual(missing, ["xq: npn13g2 needs sw_nqs=1 (a required setting of the rules)"]);
	// another physics switch stays an error
	const other = checkNetlist(ok.replace("sw_nqs=1", "sw_nqs=1 selft=0"), rules, { classes }).errors.map((e) => e.message);
	assert.equal(other.length, 1);
	assert.match(other[0], /selft=0 on npn13g2: .*a parameter that changes the device physics/);
	// allowed but not required: absent is fine
	assert.deepEqual(checkNetlist(ok.replace(" sw_nqs=1", ""), { ...RULES, allow_params: { npn13g2: { sw_nqs: [1] } } }, { classes }).errors, []);
});

test("netlist: pins, ideal elements, given subcircuits and sources", () => {
	const text = ".subckt cell b a\nv1 a 0 1\nr1 a b 1k\nxl a b tm2_w6\n.ends\n.include x.lib\n";
	const msgs = checkNetlist(text, RULES).errors.map((e) => e.message);
	assert.deepEqual(msgs, [
		"v1: no sources in the design (block cell is not a fitted model of a fit_to_spice record)",
		"r1: ideal R 1k is above 50 (wiring models only)",
		"xl: tm2_w6 needs len=<value>",
		".include: only .subckt, .ends, .param and .end lines are allowed",
		'cell pins are "b a", expected "a b"',
	]);
});

test("netlist: a fitted model of a record may hold sources; the fit band gate checks its band of use", (t) => {
	const r = root(t);
	const fit = "* simra-fit\n.subckt em_net p1 p2\nvsense1 p1 n1 0\ng1 n1 0 n1 0 1e-3\nr2 n1 p2 1\n.ends em_net\n";
	const s2p = "# Hz S RI R 50\n";
	const rec = (id: string, adapter: string, operation: string, inputs: unknown, result: unknown) => {
		const d = join(r, "simra", "experiments", id);
		mkdirSync(join(d, "work"), { recursive: true });
		writeFileSync(join(d, "experiment.json"), JSON.stringify({ id, adapter: { name: adapter }, operation, inputs }));
		writeFileSync(join(d, "result.json"), JSON.stringify({ status: "completed", ...(result as object) }));
		return d;
	};
	rec("e1", "openems", "merge", {}, { outputs: [{ path: "m.s2p", sha256: sha(s2p), role: "touchstone" }] });
	const d = rec("e2", "touchstone", "fit_to_spice", { uses: { band_hz: [60e9, 180e9] } }, { input_files: { files: [{ sha256: sha(s2p) }] }, outputs: [{ path: "simra/experiments/e2/work/em.lib", sha256: sha(fit), role: "subckt" }] });
	writeFileSync(join(d, "work", "em.lib"), fit);
	const fits = fittedModels(r).found;
	assert.deepEqual(fits.map((f) => [f.name, f.fit, f.em, f.band_hz]), [["em_net", "e2", "e1", [60e9, 180e9]]]);
	const cell = `.subckt cell a b\nxm a b em_net\n.ends\n${fit}`;
	const res = checkNetlist(cell, { ...RULES, em_passives_min: 1 }, { fits });
	assert.deepEqual(res.errors, []);
	assert.deepEqual(res.fitted_used, [{ subckt: "em_net", fit: "e2", em: "e1" }]);
	// a changed copy is not the fitted model: its source breaks the rules, and no EM passive is left
	const changed = checkNetlist(cell.replace("1e-3", "2e-3"), { ...RULES, em_passives_min: 1 }, { fits }).errors.map((e) => e.message);
	assert.ok(changed.some((m) => /^vsense1: no sources/.test(m)));
	assert.ok(changed.some((m) => /uses 0 EM passive/.test(m)));
	writeFileSync(join(r, "cell.spice"), cell);
	writeFileSync(join(r, "sp.spice"), ".include cell.spice\n.param fmax=300g\n.control\nsp lin 300 1g {fmax}\n.endc\n");
	assert.deepEqual(deckAnalyses(".param f=2g\n.ac dec 10 1k {f}\n.tran 1n 1u\n").map((a) => [a.kind, a.f_hz]), [["ac", [1e3, 2e9]], ["tran", null]]);
	const out = fitBandFindings(r, "sp.spice", fits);
	assert.equal(out.length, 1);
	assert.equal(out[0].pass, false);
	assert.match(out[0].reason, /sweeps 1000000000 Hz to 300000000000 Hz; the fit is for 60000000000 Hz to 180000000000 Hz/);
	writeFileSync(join(r, "nf.spice"), ".include cell.spice\n.noise v(b) v1 lin 3 122g 123g\n");
	const nf = fitBandFindings(r, "nf.spice", fits);
	assert.equal(nf[0].pass, false);
	assert.match(nf[0].reason, /no port noise \(give uses.noise_band_hz/);
	// harmonic balance (an xyce hb experiment): the deck has no analysis; the gate gives the band of the harmonics
	writeFileSync(join(r, "hb.cir"), ".include cell.spice\n");
	assert.deepEqual(fitBandFindings(r, "hb.cir", fits), [{ subckt: "em_net", fit: "e2", pass: true, reason: "in band (60000000000 Hz to 180000000000 Hz)" }]);
	const hb = (h: number) => fitBandFindings(r, "hb.cir", fits, [{ kind: "hb", f_hz: [61e9, 61e9 * h], text: `hb tones 61e9 Hz, harmonics ${h}` }]);
	assert.equal(hb(2)[0].pass, true);
	assert.equal(hb(3)[0].pass, false);
	assert.match(hb(3)[0].reason, /hb tones 61e9 Hz, harmonics 3" sweeps 61000000000 Hz to 183000000000 Hz/);
});

test("netlist gate: fit_checks needs a fitted model with a band-of-use check of the kind, band and tolerance", (t) => {
	const r = root(t);
	const fit = "* simra-fit\n.subckt tank p1 p2\nvsense1 p1 n1 0\ng1 n1 0 n1 0 1e-3\nr2 n1 p2 1\n.ends tank\n";
	const record = (checks: unknown) => {
		const d = join(r, "simra", "experiments", "e1");
		mkdirSync(join(d, "work"), { recursive: true });
		writeFileSync(join(d, "experiment.json"), JSON.stringify({ id: "e1", adapter: { name: "touchstone" }, operation: "fit_to_spice", inputs: { uses: { band_hz: [1e9, 130e9] }, ...(checks ? { checks } : {}) } }));
		writeFileSync(join(d, "result.json"), JSON.stringify({ status: "completed", outputs: [{ path: "simra/experiments/e1/work/tank.lib", sha256: sha(fit), role: "subckt" }] }));
		writeFileSync(join(d, "work", "tank.lib"), fit);
	};
	writeFileSync(join(r, "cell.spice"), `.subckt cell a b\nxm a b tank\n.ends\n${fit}`);
	const file = { gates: { netlist: { ...RULES, fit_checks: [{ kind: "q", band_hz: [58e9, 64e9], tol_rel_max: 0.05 }] } } } as unknown as RequirementsFile;
	record(null);
	let row = netlistGateRows(file, r)[0];
	assert.equal(row.status, "fail");
	assert.match(row.reason ?? "", /0 of the fitted models of cell has a Q check from 58 GHz to 64 GHz/);
	// a check with a wide tolerance, or in another band, does not count
	record([{ name: "q", kind: "q", ports: [1, 2], band_hz: [60e9, 62e9], tol_rel: 0.2 }]);
	assert.equal(netlistGateRows(file, r)[0].status, "fail");
	record([{ name: "q", kind: "q", ports: [1, 2], band_hz: [100e9, 120e9], tol_rel: 0.05 }]);
	assert.equal(netlistGateRows(file, r)[0].status, "fail");
	record([{ name: "q", kind: "q", ports: [1, 2], band_hz: [60e9, 62e9], tol_rel: 0.05 }]);
	row = netlistGateRows(file, r)[0];
	assert.equal(row.status, "pass", row.reason ?? "");
});

test("device-check gate: validation and rows", () => {
	const file = {
		schema: "simra.requirements/0",
		conditions: { tt: {} },
		experiments: { sp: { adapter: "ngspice", operation: "simulate", inputs: {} }, hb: { adapter: "xyce", operation: "hb", inputs: {} } },
		requirements: [{ id: "x", experiment: "sp", measurement: "m", op: "<=", limit: 1, conditions: ["tt"], limit_source: { kind: "task", ref: "test" } }],
		gates: { device_check: { ngspice_experiment: "sp", xyce_experiment: "hbx", conditions: ["cold"], devices: [{ name: "q", cell: "npn13G2", pins: ["p2", "p1", "0", "0"] }], freqs_hz: [] } },
	};
	const errors = validateRequirements(file).join("\n");
	assert.match(errors, /gates\.device_check\.xyce_experiment: experiment "hbx" is not defined/);
	assert.match(errors, /gates\.device_check: condition "cold" is not defined/);
	assert.match(errors, /gates\.device_check: freqs_hz must list the frequencies/);
	assert.match(errors, /gates\.device_check\.devices "q": name, cell, pins and bias_v/);
	const bad = validateRequirements({ ...file, gates: { netlist: { ...RULES, fit_checks: [{ kind: "q", band_hz: [58e9, 64e9], tol_rel_max: 0.05 }, { kind: "x", band_hz: [1], tol_rel_max: 0 }] } } } as unknown as RequirementsFile).join("\n");
	assert.match(bad, /gates\.netlist\.fit_checks\[1\]: kind/);
	assert.doesNotMatch(bad, /fit_checks\[0\]/);

	const result = (findings: number, diagnostics: { severity: string; message: string }[] = []) =>
		({ status: "completed", measurements: { findings: { value: findings, unit: null }, dc_rel_max: { value: 0.0002, unit: null }, y_rel_max: { value: findings ? 0.137 : 0.012, unit: null } }, diagnostics }) as unknown as ResultRecord;
	const rows = deviceCheckGateRows([
		{ device: "q", condition: "tt", id: "e1", result: result(0) },
		{ device: "q", condition: "hot", id: "e2", result: result(1, [{ severity: "warning", message: "finding: y21 at 122.5 GHz: ngspice 60.9 mS, Xyce 62.97 mS, difference 13.7 % (tolerance 2 %)" }]) },
		{ device: "q", condition: "cold", id: "e3", result: { status: "failed", measurements: {}, diagnostics: [] } as unknown as ResultRecord },
		{ device: "q", condition: "x", id: null, result: null, why: "not selected in this check" },
		{ device: "q", condition: "hot_ok", id: "e4", result: result(0, [{ severity: "warning", message: "temperature finding: y21 at 122.5 GHz at 125 C: ngspice 50 mS, Xyce 48 mS, difference 4.2 % (tolerance 2 %)" }]) },
	]);
	const hotOk = rows.find((x) => x.condition === "hot_ok");
	assert.equal(hotOk?.status, "pass");
	assert.match(hotOk?.reason ?? "", /1 temperature finding \(the simulators agree at the reference temperature, so this is a finding and not an error\): y21 at 122.5 GHz at 125 C/);
	assert.deepEqual(rows.map((x) => [x.requirement, x.condition, x.status, x.value]), [
		["gate device_check q", "tt", "pass", 0],
		["gate device_check q", "hot", "fail", 1],
		["gate device_check q", "cold", "not_run", null],
		["gate device_check q", "x", "not_run", null],
		["gate device_check q", "hot_ok", "pass", 0],
	]);
	assert.match(rows[0].reason ?? "", /largest difference: DC 0\.02 %, y 1\.20 %/);
	assert.match(rows[1].reason ?? "", /y21 at 122\.5 GHz.*the simulators do not agree/);
	assert.equal(rows[3].reason, "not selected in this check");
});
