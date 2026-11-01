// The ota-synthesis scorer reads the design part of the verdict and scores the answer against its own
// verification. Here a fake verifier gives the recorded results of expected.json, so the test needs no container.
// reference.mjs makes these results with ngspice; test/ota-synthesis-verify.test.mjs checks that the verification
// reproduces them.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerOf, designs } from "../evals/ota-synthesis/reference.mjs";
import { loadTask, METRICS, scoreSynthesis } from "../evals/ota-synthesis/synthesis.mjs";
import { assertBenchMatchesSpec, assertPassiveRule, passiveArea, variantDirs } from "./ota-bench-consistency.mjs";

const repo = new URL("../", import.meta.url).pathname;
const TASKS = {
	sg13cmos5l: { technology: "ihp-sg13", pdk: "ihp-sg13cmos5l", fix_area: 50, original_area: 30 },
	sky130: { technology: "sky130", pdk: "sky130A", fix_area: 58, original_area: 42 },
};
/** The least factors limit / worst iin_a of a gate input, and least iin_a of input_load / limit. */
const GATE_FACTOR = 100;
const INPUT_LOAD_FACTOR = 1e4;
/** The R and C of the fix and the original (Rz 5k, Cc 1p), and of the cheat (Ro 1meg, Rb 10k, Co 2p). */
const FIX_RC = { r: [5e3], c: [1e-12] };
const CHEAT_RC = { r: [1e6, 10e3], c: [2e-12] };
/** The areas of a design check: [area_um2, gate_area_um2, passive_area_um2]. */
const areas = (d) => [d.area_um2, d.gate_area_um2, d.passive_area_um2];
const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
const taskDir = (name) => join(repo, "evals/ota-synthesis", name);
const expectedOf = (name) => JSON.parse(readFileSync(join(taskDir(name), "expected.json"), "utf8"));

/** A verifier that gives the recorded result of a reference design, in the form of verify(), and counts its calls. */
function fakeVerifier(name) {
	const e = expectedOf(name);
	const known = Object.entries(designs(name));
	const calls = [];
	const verifier = async (_dir, design) => {
		calls.push(design);
		const which = known.find(([, d]) => d === design)?.[0];
		if (!which) throw new Error("fake verifier: unknown design");
		const r = e[which];
		const corners = Object.entries(r.corners).map(([c, v]) => [c, { experiment: v.experiment, status: "completed", errors: [], points: v.sweep, worst: v.worst }]);
		return { ...Object.fromEntries(corners), design: { experiment: "fake", ...r.design_check } };
	};
	return { verifier, calls };
}

function workspace(t, design, answer) {
	const ws = mkdtempSync(join(tmpdir(), "simra-synthesis-score-"));
	t.after(() => rmSync(ws, { recursive: true, force: true }));
	if (design !== undefined) writeFileSync(join(ws, "ota.spice"), design);
	if (answer !== undefined) writeFileSync(join(ws, "answer.json"), JSON.stringify(answer));
	return ws;
}

/** The lines of the bench that measure iin_a (after idd_a, at the DC operating point). */
const IIN_LINES = "  let iinp = abs(i(vinp))\n  let iinn = abs(i(lfb))\n  let iin = (iinp + iinn + abs(iinp - iinn)) / 2\n  set iinv = $&iin\n";
/** The bench of ota-sizing: the bench without the lines and the comment of iin_a. */
const withoutIin = (bench) =>
	bench
		.replace(IIN_LINES, "")
		.replace(" iin_a=$iinv", "")
		.replace(/^\* The DC operating point gives idd_a and iin_a.*\n\* and into inn.*\n/m, "");

const parts = (s) => [s.design, s.requirements, s.claim, s.values];

for (const [name, facts] of Object.entries(TASKS)) {
	test(`ota-synthesis ${name}: the recorded reference results`, () => {
		const e = expectedOf(name);
		assert.deepEqual([e.fix.design_check.status, e.fix.design_check.gate_area_um2, e.fix.meets_spec], ["pass", facts.fix_area, true]);
		assert.deepEqual([e.original.design_check.status, e.original.design_check.gate_area_um2, e.original.meets_spec], ["pass", facts.original_area, false]);
		// The area is the gate area plus the area of the R and C, from the facts of the PDK in the technology pack.
		const rc = passiveArea(facts.technology, facts.pdk, FIX_RC);
		for (const [k, gate] of [["fix", facts.fix_area], ["original", facts.original_area]]) {
			const [area, g, passive] = areas(e[k].design_check);
			assert.ok(g === gate && near(passive, rc) && near(area, gate + rc), `${k}: areas ${area}, ${g}, ${passive}; R and C ${rc}`);
			assert.ok(area <= e.spec.design.area_um2, `${k}: area ${area} µm²`);
		}
		// The original fails at ss, as in ota-sizing: the gain at the top of the range and the UGF at the bottom.
		const failed = Object.entries(e.original.corners).flatMap(([c, v]) => METRICS.filter((m) => !v.worst[m].pass).map((m) => `${c} ${m}`));
		assert.deepEqual(failed, ["ss gain_db", "ss ugf_hz"]);
		// The cheat passes every row of the simulation, but not the design part.
		assert.deepEqual([e.cheat.design_check.status, e.cheat.rows_pass, e.cheat.meets_spec, e.cheat.design_check.mos_count], ["fail", true, false, 0]);
		assert.deepEqual(
			e.cheat.design_check.errors.map((x) => x.source),
			["ota.spice:3", "ota.spice:5"],
		);
		// The R and C of the cheat (1 MΩ, 10 kΩ and 2 pF) are above the area limit without a MOS device: the area row fails.
		const cheatRc = passiveArea(facts.technology, facts.pdk, CHEAT_RC);
		assert.ok(near(e.cheat.design_check.area_um2, cheatRc) && cheatRc > e.spec.design.area_um2, `cheat: area ${e.cheat.design_check.area_um2}`);
		assert.match(e.cheat.design_check.errors[0].message, /E1: a controlled source \(E\) is not allowed/);
		assert.match(e.cheat.design_check.errors[1].message, /Co: node 0 is the global ground/);
		assert.deepEqual([e.cheat_score.design, e.cheat_score.requirements], [0, 0]);
		// input_load: the fix with a divider on each input passes the design part and every row but iin_a, which it
		// fails at every corner by more than INPUT_LOAD_FACTOR. The fix (gate inputs) passes iin_a by more than
		// GATE_FACTOR.
		assert.deepEqual([e.input_load.design_check.status, e.input_load.design_check.gate_area_um2, e.input_load.meets_spec], ["pass", facts.fix_area, false]);
		const loadFailed = Object.entries(e.input_load.corners).flatMap(([c, v]) => METRICS.filter((m) => !v.worst[m].pass).map((m) => `${c} ${m}`));
		assert.deepEqual(loadFailed, ["tt iin_a", "ss iin_a", "ff iin_a"]);
		assert.ok(Math.abs(e.input_current.limit / 2e-9 - 1) < 1e-12, "iin_a <= 2 nA");
		assert.ok(e.input_current.reference_worst * GATE_FACTOR < e.input_current.limit, `the fix: ${e.input_current.reference_worst} A`);
		assert.ok(e.input_current.input_load_factor > INPUT_LOAD_FACTOR, `input_load: ${e.input_current.input_load_least} A`);
	});

	test(`ota-synthesis ${name}: the reference fix with a correct answer gets every point`, async (t) => {
		const e = expectedOf(name);
		const { verifier, calls } = fakeVerifier(name);
		const ws = workspace(t, designs(name).fix, answerOf(e.fix));
		writeFileSync(join(ws, "sim.log"), JSON.stringify(e.fix.corners));
		const s = await scoreSynthesis(ws, taskDir(name), { verifier });
		assert.deepEqual(s.errors, []);
		assert.deepEqual([...parts(s), s.supported], [2, 15, 4, 15, 15]);
		assert.deepEqual([s.verified_meets_spec, s.design_status, s.gate_area_um2, s.mos_count, s.design_errors], [true, "pass", facts.fix_area, 8, []]);
		assert.deepEqual([s.area_um2, s.passive_area_um2], [e.fix.design_check.area_um2, e.fix.design_check.passive_area_um2]);
		assert.equal(calls.length, 1);
	});

	test(`ota-synthesis ${name}: the original with the claim that it meets the spec`, async (t) => {
		const { verifier } = fakeVerifier(name);
		const s = await scoreSynthesis(workspace(t, designs(name).original, answerOf(expectedOf(name).original, true)), taskDir(name), { verifier });
		assert.equal(s.verified_meets_spec, false);
		assert.deepEqual(parts(s), [2, 13, 0, 15], "the ss gain and the ss UGF fail; the values are correct, only the claim is wrong");
		assert.equal(s.supported, 0, "no workspace file shows the values");
	});

	test(`ota-synthesis ${name}: a design that breaks the rules gets no requirement points`, async (t) => {
		const e = expectedOf(name);
		const { verifier } = fakeVerifier(name);
		const s = await scoreSynthesis(workspace(t, designs(name).cheat, answerOf(e.cheat, true)), taskDir(name), { verifier });
		assert.deepEqual(parts(s), [0, 0, 0, 15], "the simulation passes, but the design part fails");
		assert.equal(Object.values(s.rows).filter((r) => r.pass).length, 15);
		assert.deepEqual([s.verified_meets_spec, s.design_status, s.mos_count, s.design_errors.length], [false, "fail", 0, 2]);
		assert.match(s.errors.join("\n"), /^ota\.spice:3: E1: a controlled source \(E\)/m);
		// The claim false is correct.
		const honest = await scoreSynthesis(workspace(t, designs(name).cheat, answerOf(e.cheat, false)), taskDir(name), { verifier });
		assert.deepEqual(parts(honest), [0, 0, 4, 15]);
	});
}

test("ota-synthesis: values outside the tolerance and a missing row get no value points", async (t) => {
	const name = "sg13cmos5l";
	const e = expectedOf(name);
	const { verifier } = fakeVerifier(name);
	const answer = answerOf(e.fix);
	const row = (c, m) => answer.rows.find((r) => r.corner === c && r.requirement === m);
	row("tt", "gain_db").value += 0.4; // inside ±0.5 dB
	row("ss", "gain_db").value += 0.6; // outside
	row("ff", "ugf_hz").value *= 1.06; // outside ±5 %
	row("tt", "idd_a").value *= 1.01; // inside ±2 %
	answer.rows = answer.rows.filter((r) => !(r.corner === "ss" && r.requirement === "pm_deg"));
	const s = await scoreSynthesis(workspace(t, designs(name).fix, answer), taskDir(name), { verifier });
	assert.deepEqual(parts(s), [2, 15, 4, 12]);
	assert.deepEqual([s.rows["tt gain_db"].value, s.rows["ss gain_db"].value, s.rows["ff ugf_hz"].value, s.rows["ss pm_deg"].reported], [true, false, false, null]);
});

test("ota-synthesis: answer.json or ota.spice missing", async (t) => {
	const name = "sky130";
	const { verifier, calls } = fakeVerifier(name);
	const noAnswer = await scoreSynthesis(workspace(t, designs(name).fix), taskDir(name), { verifier });
	assert.ok(noAnswer.errors.includes("answer.json not found"));
	assert.deepEqual(parts(noAnswer), [2, 15, 0, 0], "no claim: the claim point needs meets_spec");
	assert.equal(noAnswer.meets_spec, null);
	const bad = workspace(t, designs(name).fix);
	writeFileSync(join(bad, "answer.json"), "{ not json");
	assert.match((await scoreSynthesis(bad, taskDir(name), { verifier })).errors.join(), /answer\.json is not valid JSON/);
	assert.equal(calls.length, 2);
	const noDesign = await scoreSynthesis(workspace(t, undefined, { meets_spec: false, rows: [] }), taskDir(name), { verifier });
	assert.equal(calls.length, 2, "no design, no verification");
	assert.ok(noDesign.errors.includes("ota.spice not found"));
	assert.deepEqual([...parts(noDesign), noDesign.design_status], [0, 0, 4, 0, "not_run"]);
});

// The committed variants (evals/synthesis-family.mjs) have the same consistency, with their own limits.
for (const [name, facts] of Object.entries(TASKS)) {
	for (const dir of [name, ...variantDirs(join(repo, "evals/ota-synthesis"), name)]) {
		test(`ota-synthesis ${dir}: spec.md, requirements.json, verify.spice and task.json say the same`, () => {
			const { task, spec } = loadTask(taskDir(dir));
			const bench = readFileSync(join(taskDir(dir), "verify.spice"), "utf8");
			const req = JSON.parse(readFileSync(join(taskDir(dir), "requirements.json"), "utf8"));
			assertBenchMatchesSpec(spec, bench, req, { metrics: METRICS, row: /^\s*echo ROW vcm=\$vcm idd_a=.* gain_db=.* ugf_hz=.* pm_deg=.* iin_a=\$iinv$/m });
			// The bench and requirements of ota-sizing with iin_a; only the design rows (the area in place of the gate area),
			// the design limits (r_ohm is added) and the devices differ. A variant also has its own requirement limits
			// (assertBenchMatchesSpec checks them against its spec.md).
			const sizingDir = join(repo, "evals/ota-sizing", name);
			assert.equal(withoutIin(bench), readFileSync(join(sizingDir, "verify.spice"), "utf8"));
			assert.ok(bench.includes(IIN_LINES), "the bench measures iin_a at the DC operating point");
			const sizing = JSON.parse(readFileSync(join(sizingDir, "requirements.json"), "utf8"));
			const iin = req.requirements.find((r) => r.id === "iin_a");
			assert.deepEqual([iin.measurement, iin.unit, iin.op, iin.limit, iin.conditions, req.experiments.sweep.inputs.measurements.iin_a], ["iin_a", "A", "<=", 2e-9, ["tt", "ss", "ff"], "A"]);
			const base = (r) => {
				const { iin_a, ...measurements } = r.experiments.sweep.inputs.measurements;
				const sweep = { ...r.experiments.sweep, inputs: { ...r.experiments.sweep.inputs, measurements } };
				const design = { ...r.experiments.design, inputs: { ...r.experiments.design.inputs, limits: null, devices: null } };
				const requirements = r.requirements.filter((x) => x.id !== "iin_a" && x.conditions).map((x) => (dir === name ? x : { ...x, limit: null }));
				return { ...r, experiments: { ...r.experiments, design, sweep }, requirements };
			};
			assert.deepEqual(base(req), base(sizing));
			assert.deepEqual(readFileSync(join(taskDir(dir), "simra.config.json"), "utf8"), readFileSync(join(sizingDir, "simra.config.json"), "utf8"));
			// The design contract: the file, the pins in their order, the element kinds, the devices and the limits of spec.md.
			const d = spec.design;
			assert.deepEqual([d.file, d.subckt, d.pins], ["ota.spice", "ota", ["inp", "inn", "out", "vdd", "vss", "ibias"]]);
			const design = req.experiments.design;
			assert.deepEqual([design.inputs.file, design.inputs.subckt, design.inputs.pins, design.inputs.elements], [d.file, d.subckt, d.pins, ["mos", "r", "c"]]);
			assert.deepEqual(design.inputs.devices, d.devices);
			assert.deepEqual(design.inputs.limits, { r_ohm: d.r_ohm, c_f: d.c_f });
			assert.deepEqual([design.adapter, design.operation, design.inputs.technology, design.environment], ["ngspice", "check_design", facts.technology, task.environment]);
			const rows = req.requirements.filter((r) => r.experiment === "design").map((r) => [r.id, r.experiment, r.measurement, r.op, r.limit]);
			assert.deepEqual(rows, [["design_errors", "design", "design_errors", "<=", 0], ["area_um2", "design", "area_um2", "<=", d.area_um2]]);
			assertPassiveRule(readFileSync(join(taskDir(dir), "spec.md"), "utf8"), facts.technology, facts.pdk);
			// The devices of spec.md are devices of the technology pack, with the minimum sizes of the pack.
			const pack = JSON.parse(readFileSync(join(repo, "technologies", facts.technology, "technology.json"), "utf8")).ngspice;
			const text = readFileSync(join(taskDir(dir), "spec.md"), "utf8");
			for (const model of d.devices) {
				const p = pack.devices[model];
				assert.ok(p, `${model} is not in the technology pack ${facts.technology}`);
				const um = (x) => Number((x * 1e6).toFixed(3));
				if (pack.size_unit_m === 1) {
					assert.ok(p.params.w.per_finger && p.params.ng, `${model}: W per finger and ng`);
					assert.ok(text.includes(`W / ng >= ${um(p.params.w.min)} µm and L >= ${um(p.params.l.min)} µm`), `${model}: minimum sizes`);
					assert.match(text, /`w=2u l=0\.5u`/);
				} else {
					const row = new RegExp(`^\\s*\\| \`${model}\` \\| ${um(p.params.w.min)} µm \\| ${um(p.params.l.min)} µm \\|$`, "m");
					assert.match(text, row, `${model}: minimum sizes`);
					assert.match(text, /`\.option scale=1\.0u`/);
					assert.equal(pack.size_unit_m, 1e-6);
				}
			}
			if (name === "sky130") assert.deepEqual(d.devices, Object.keys(pack.devices), "sky130: every MOS device of the pack");
			else assert.deepEqual(d.devices, ["sg13_lv_nmos", "sg13_lv_pmos"], "sg13cmos5l: the devices of cornerMOSlv.lib");
			// The task gives no netlist, and no answer is a task file.
			assert.deepEqual(Object.keys(task.files).sort(), ["requirements.json", "simra.config.json", "simra.local.json", "spec.md", "verify.spice"]);
			for (const [f, src] of Object.entries(task.files)) if (f !== "simra.local.json") assert.ok(existsSync(join(taskDir(dir), src)), `${f} exists`);
			assert.equal(existsSync(join(taskDir(dir), "ota.spice")), false);
		});
	}
}
