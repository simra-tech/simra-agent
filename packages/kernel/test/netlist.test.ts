import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkNetlist, deckAnalyses, fitBandFindings, fittedModels, instanceParamClasses, type NetlistRules, spiceValue } from "../src/index.ts";

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
});
