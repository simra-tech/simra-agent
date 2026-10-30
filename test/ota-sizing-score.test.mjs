// The ota-sizing scorer checks the topology and the design limits of the final ota.spice, and scores the answer
// against its own verification. Here a fake verifier gives the recorded sweeps of expected.json, so the test
// needs no container. reference.mjs makes these sweeps with ngspice; test/ota-sizing-verify.test.mjs checks
// that the verification reproduces them.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FIXES, resize } from "../evals/ota-sizing/reference.mjs";
import { validateRequirements } from "@simra-tech/kernel";
import { checkTopology, gateArea, loadTask, METRICS, scoreSizing, sweep } from "../evals/ota-sizing/sizing.mjs";

const repo = new URL("../", import.meta.url).pathname;
const TASKS = { sg13cmos5l: { area: 30, fix_area: 50, range: [0.4, 0.7], points: 16 }, sky130: { area: 42, fix_area: 58, range: [0.8, 1.2], points: 21 } };
const taskDir = (name) => join(repo, "evals/ota-sizing", name);
const expectedOf = (name) => JSON.parse(readFileSync(join(taskDir(name), "expected.json"), "utf8"));

/** A verifier that gives the recorded sweep of the original or of the reference fix, and counts its calls. */
function fakeVerifier(name) {
	const { original } = loadTask(taskDir(name));
	const e = expectedOf(name);
	const calls = [];
	const verifier = async (_dir, design) => {
		calls.push(design);
		const which = design === original ? e.original : design === resize(original, FIXES[name]) ? e.fix : null;
		if (!which) throw new Error("fake verifier: unknown design");
		return Object.fromEntries(Object.entries(which.corners).map(([c, v]) => [c, { experiment: v.experiment, points: v.sweep, worst: v.worst }]));
	};
	return { verifier, calls };
}

function workspace(t, name, design, answer) {
	const ws = mkdtempSync(join(tmpdir(), "simra-sizing-score-"));
	t.after(() => rmSync(ws, { recursive: true, force: true }));
	cpSync(join(taskDir(name), "spec.md"), join(ws, "spec.md"));
	if (design !== undefined) writeFileSync(join(ws, "ota.spice"), design);
	if (answer !== undefined) writeFileSync(join(ws, "answer.json"), JSON.stringify(answer));
	return ws;
}

/** An answer with the worst values of a recorded result, and a log file that shows them. */
const answerOf = (result, meets = result.meets_spec) => ({
	meets_spec: meets,
	rows: Object.entries(result.corners).flatMap(([corner, v]) => METRICS.map((m) => ({ corner, requirement: m, value: v.worst[m].value, vcm: v.worst[m].vcm, pass: v.worst[m].pass, evidence: "sim.log" }))),
});

for (const [name, facts] of Object.entries(TASKS)) {
	test(`ota-sizing ${name}: spec.md, the original and the reference fix`, () => {
		const { task, spec, original } = loadTask(taskDir(name));
		assert.deepEqual(spec.range, facts.range);
		assert.equal(sweep(spec.range).length, facts.points);
		assert.deepEqual(Object.keys(spec.corners), ["tt", "ss", "ff"]);
		assert.deepEqual(checkTopology(original, original), []);
		assert.equal(gateArea(original, task.length_unit_m), facts.area);
		const fixed = resize(original, FIXES[name]);
		assert.deepEqual(checkTopology(original, fixed), []);
		assert.equal(gateArea(fixed, task.length_unit_m), facts.fix_area);
		assert.ok(facts.fix_area <= spec.design.area_um2);
		const e = expectedOf(name);
		assert.equal(e.original.meets_spec, false);
		assert.equal(e.fix.meets_spec, true);
		// The original fails at ss: the gain at the top of the range and the UGF at the bottom.
		assert.deepEqual([e.original.corners.ss.worst.gain_db.pass, e.original.corners.ss.worst.gain_db.vcm], [false, facts.range[1]]);
		assert.deepEqual([e.original.corners.ss.worst.ugf_hz.pass, e.original.corners.ss.worst.ugf_hz.vcm], [false, facts.range[0]]);
	});

	test(`ota-sizing ${name}: the reference fix with a correct answer gets every point`, async (t) => {
		const { original } = loadTask(taskDir(name));
		const e = expectedOf(name);
		const { verifier, calls } = fakeVerifier(name);
		const ws = workspace(t, name, resize(original, FIXES[name]), answerOf(e.fix));
		writeFileSync(join(ws, "sim.log"), JSON.stringify(e.fix.corners));
		const s = await scoreSizing(ws, taskDir(name), { verifier });
		assert.deepEqual(s.errors, []);
		assert.deepEqual([s.topology, s.limits, s.requirements, s.claim, s.values, s.supported], [1, 1, 12, 4, 12, 12]);
		assert.equal(s.verified_meets_spec, true);
		assert.equal(s.area_um2, TASKS[name].fix_area);
		assert.equal(calls.length, 1);
	});

	test(`ota-sizing ${name}: the original with the claim that it meets the spec`, async (t) => {
		const { original } = loadTask(taskDir(name));
		const e = expectedOf(name);
		const { verifier } = fakeVerifier(name);
		const s = await scoreSizing(workspace(t, name, original, answerOf(e.original, true)), taskDir(name), { verifier });
		assert.equal(s.verified_meets_spec, false);
		assert.equal(s.claim, 0);
		assert.equal(s.requirements, 10, "the ss gain and the ss UGF fail");
		assert.equal(s.values, 12, "the values are correct, only the claim is wrong");
		assert.deepEqual(s.changed, {});
	});
}

test("ota-sizing: a changed topology gets no design points and no verification", async (t) => {
	const name = "sg13cmos5l";
	const { original } = loadTask(taskDir(name));
	const { verifier, calls } = fakeVerifier(name);
	const cases = {
		"XM1: parameter names changed": original.replace("XM1 x inn tail vss sg13_lv_nmos w=4u", "XM1 x inn tail vss sg13_lv_nmos w=4u m=2"),
		"XM5: nets changed": original.replace("XM5 tail ibias vss vss", "XM5 tail ibias vss vdd"),
		"XM9 added": original.replace(".ends ota", "XM9 out ibias vss vss sg13_lv_nmos w=1u l=1u ng=1\n.ends ota"),
		"RZ removed": original.replace(/^Rz .*\n/m, ""),
		"XM6: w={wp} is not a positive number": original.replace("w=16u", "w={wp}"),
	};
	for (const [error, design] of Object.entries(cases)) {
		const s = await scoreSizing(workspace(t, name, design, { meets_spec: false, rows: [] }), taskDir(name), { verifier });
		assert.ok(s.errors.includes(`ota.spice: ${error}`), `${error}: ${s.errors}`);
		assert.deepEqual([s.topology, s.limits, s.requirements, s.values], [0, 0, 0, 0]);
		assert.equal(s.claim, 4, "the claim false is correct");
	}
	assert.equal(calls.length, 0);
});

test("ota-sizing: a design over the area limit does not meet the spec", async (t) => {
	const name = "sky130";
	const { original } = loadTask(taskDir(name));
	const big = original.replace("XM6 out y vdd vdd sky130_fd_pr__pfet_01v8 w=32", "XM6 out y vdd vdd sky130_fd_pr__pfet_01v8 w=120");
	const verifier = async () => fakeVerifier(name).verifier(null, resize(original, FIXES[name]));
	const s = await scoreSizing(workspace(t, name, big, answerOf(expectedOf(name).fix)), taskDir(name), { verifier });
	assert.equal(s.area_um2, 86);
	assert.deepEqual([s.topology, s.limits, s.requirements], [1, 0, 12]);
	assert.equal(s.verified_meets_spec, false);
	assert.equal(s.claim, 0);
	assert.match(s.errors.join(), /design limits: area 86 µm² \(limit 80\)/);
});

for (const name of Object.keys(TASKS)) {
	test(`ota-sizing ${name}: verify.spice and requirements.json say the same as spec.md`, () => {
		const { spec } = loadTask(taskDir(name));
		const bench = readFileSync(join(taskDir(name), "verify.spice"), "utf8");
		const req = JSON.parse(readFileSync(join(taskDir(name), "requirements.json"), "utf8"));
		assert.deepEqual(validateRequirements(req), []);
		// The bench sweeps the VCM range of the spec and prints one ROW line per point. The corner gives the model
		// library, VDD and the temperature, so the bench has no .lib line and only defaults for vdd and .temp.
		assert.match(bench, new RegExp(`^foreach vcm ${sweep(spec.range).join(" ")}$`, "m"));
		assert.match(bench, /^\s*echo ROW vcm=\$vcm idd_a=.* gain_db=.* ugf_hz=.* pm_deg=/m);
		assert.doesNotMatch(bench, /^\.lib/im);
		assert.match(bench, new RegExp(`^\\.param vdd=${spec.corners.tt.vdd}$`, "m"));
		assert.match(bench, new RegExp(`^\\.temp ${spec.corners.tt.temp}$`, "m"));
		// Each corner of the spec is a condition: its library section, VDD and temperature.
		assert.deepEqual(Object.keys(req.conditions), Object.keys(spec.corners));
		for (const [c, k] of Object.entries(spec.corners)) {
			assert.deepEqual(req.conditions[c].inputs, { libs: [{ path: spec.lib, section: k.section }], params: { vdd: k.vdd }, temp_c: k.temp });
		}
		// One sweep experiment with the bench, and each requirement of the spec with its limit at every corner.
		assert.equal(req.experiments.sweep.inputs.deck, "verify.spice");
		assert.deepEqual(Object.keys(req.experiments.sweep.inputs.measurements), METRICS);
		for (const m of METRICS) {
			const r = req.requirements.find((x) => x.id === m);
			assert.deepEqual([r.measurement, r.unit, r.op, r.conditions], [m, req.experiments.sweep.inputs.measurements[m], spec.limits[m].op, Object.keys(spec.corners)]);
			assert.ok(Math.abs(r.limit / spec.limits[m].value - 1) < 1e-12, `${m}: limit ${r.limit}, spec ${spec.limits[m].value}`);
		}
	});
}
