// The comparator-synthesis scorer (scoreSynthesis of ota-synthesis with the tolerance of the task) reads the design
// part of the verdict and scores the answer against its own verification. Here a fake verifier gives the recorded
// results of expected.json, so the test needs no container. reference.mjs makes these results with ngspice;
// test/comparator-synthesis-verify.test.mjs checks that the verification reproduces them.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerOf, designs, LIMIT_FACTOR } from "../evals/comparator-synthesis/reference.mjs";
import { loadTask, METRICS, scoreComparator } from "../evals/comparator-synthesis/synthesis.mjs";
import { assertBenchMatchesSpec } from "./ota-bench-consistency.mjs";

const repo = new URL("../", import.meta.url).pathname;
const TASKS = {
	sg13cmos5l: { technology: "ihp-sg13", reference_area: 20.39, known_fail_area: 18.39 },
	sky130: { technology: "sky130", reference_area: 22.45, known_fail_area: 20.45 },
};
const ROWS = 3 * METRICS.length;
const taskDir = (name) => join(repo, "evals/comparator-synthesis", name);
const expectedOf = (name) => JSON.parse(readFileSync(join(taskDir(name), "expected.json"), "utf8"));
const failedRows = (result) => Object.entries(result.corners).flatMap(([c, v]) => METRICS.filter((m) => !v.worst[m].pass).map((m) => `${c} ${m}`));

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
	const ws = mkdtempSync(join(tmpdir(), "simra-comparator-score-"));
	t.after(() => rmSync(ws, { recursive: true, force: true }));
	if (design !== undefined) writeFileSync(join(ws, "cmp.spice"), design);
	if (answer !== undefined) writeFileSync(join(ws, "answer.json"), JSON.stringify(answer));
	return ws;
}

const parts = (s) => [s.design, s.requirements, s.claim, s.values];

for (const [name, facts] of Object.entries(TASKS)) {
	test(`comparator-synthesis ${name}: the recorded reference results`, () => {
		const e = expectedOf(name);
		assert.deepEqual([e.reference.design_check.status, e.reference.design_check.gate_area_um2, e.reference.design_check.mos_count, e.reference.meets_spec], ["pass", facts.reference_area, 10, true]);
		// Each sweep has the 5 VCM points of the spec.
		for (const r of [e.reference, e.known_fail, e.cheat]) for (const c of Object.values(r.corners)) assert.deepEqual(c.sweep.map((p) => p.vcm), e.spec.points);
		// The known fail (the tail current source at half its width) passes the design part and fails at least 2 rows
		// at one corner.
		assert.deepEqual([e.known_fail.design_check.status, e.known_fail.design_check.gate_area_um2, e.known_fail.meets_spec], ["pass", facts.known_fail_area, false]);
		const perCorner = Object.keys(e.known_fail.corners).map((c) => failedRows(e.known_fail).filter((k) => k.startsWith(`${c} `)).length);
		assert.ok(Math.max(...perCorner) >= 2, `known fail: ${failedRows(e.known_fail)}`);
		// The cheat passes every row of the simulation, but not the design part.
		assert.deepEqual([e.cheat.design_check.status, e.cheat.rows_pass, e.cheat.meets_spec, e.cheat.design_check.mos_count], ["fail", true, false, 0]);
		assert.deepEqual(
			e.cheat.design_check.errors.map((x) => x.source),
			["cmp.spice:3", "cmp.spice:5"],
		);
		assert.match(e.cheat.design_check.errors[0].message, /B1: a behavioural source \(B\) is not allowed/);
		assert.match(e.cheat.design_check.errors[1].message, /Rb: node 0 is the global ground/);
		assert.deepEqual([e.cheat_score.design, e.cheat_score.requirements], [0, 0]);
		// The limits of the spec are at least LIMIT_FACTOR times the worst value of the reference.
		assert.deepEqual(Object.keys(e.limit_margins), ["tpd_r_s", "tpd_f_s", "idd_a", "gate_area_um2"]);
		for (const [k, v] of Object.entries(e.limit_margins)) assert.ok(v.limit >= LIMIT_FACTOR * v.worst, `${k}: limit ${v.limit}, reference ${v.worst}`);
	});

	test(`comparator-synthesis ${name}: the reference with a correct answer gets every point`, async (t) => {
		const e = expectedOf(name);
		const { verifier, calls } = fakeVerifier(name);
		const ws = workspace(t, designs(name).reference, answerOf(e.reference));
		writeFileSync(join(ws, "sim.log"), JSON.stringify(e.reference.corners));
		const s = await scoreComparator(ws, taskDir(name), { verifier });
		assert.deepEqual(s.errors, []);
		assert.deepEqual(s.max, { design: 2, requirements: ROWS, claim: 4, values: ROWS });
		assert.deepEqual([...parts(s), s.supported], [2, ROWS, 4, ROWS, ROWS]);
		assert.deepEqual([s.verified_meets_spec, s.design_status, s.area_um2, s.mos_count, s.design_errors], [true, "pass", facts.reference_area, 10, []]);
		assert.deepEqual(Object.keys(s.rows), ["tt", "ss", "ff"].flatMap((c) => METRICS.map((m) => `${c} ${m}`)));
		assert.equal(calls.length, 1);
	});

	test(`comparator-synthesis ${name}: the known fail with the claim that it meets the spec`, async (t) => {
		const e = expectedOf(name);
		const { verifier } = fakeVerifier(name);
		const s = await scoreComparator(workspace(t, designs(name).known_fail, answerOf(e.known_fail, true)), taskDir(name), { verifier });
		const failed = failedRows(e.known_fail);
		assert.equal(s.verified_meets_spec, false);
		assert.deepEqual(parts(s), [2, ROWS - failed.length, 0, ROWS], `${failed} fail; the values are correct, only the claim is wrong`);
		assert.deepEqual(Object.entries(s.rows).filter(([, r]) => !r.pass).map(([k]) => k), failed);
		assert.equal(s.supported, 0, "no workspace file shows the values");
	});

	test(`comparator-synthesis ${name}: a design that breaks the rules gets no requirement points`, async (t) => {
		const e = expectedOf(name);
		const { verifier } = fakeVerifier(name);
		const s = await scoreComparator(workspace(t, designs(name).cheat, answerOf(e.cheat, true)), taskDir(name), { verifier });
		assert.deepEqual(parts(s), [0, 0, 0, ROWS], "the simulation passes, but the design part fails");
		assert.equal(Object.values(s.rows).filter((r) => r.pass).length, ROWS);
		assert.deepEqual([s.verified_meets_spec, s.design_status, s.mos_count, s.design_errors.length], [false, "fail", 0, 2]);
		assert.match(s.errors.join("\n"), /^cmp\.spice:3: B1: a behavioural source \(B\)/m);
		// The claim false is correct.
		const honest = await scoreComparator(workspace(t, designs(name).cheat, answerOf(e.cheat, false)), taskDir(name), { verifier });
		assert.deepEqual(parts(honest), [0, 0, 4, ROWS]);
	});
}

test("comparator-synthesis: values outside the tolerance and a missing row get no value points", async (t) => {
	const name = "sg13cmos5l";
	const e = expectedOf(name);
	const { verifier } = fakeVerifier(name);
	const answer = answerOf(e.reference);
	const row = (c, m) => answer.rows.find((r) => r.corner === c && r.requirement === m);
	row("tt", "tpd_r_s").value *= 1.04; // inside ±5 %
	row("ss", "tpd_f_s").value *= 1.06; // outside
	row("tt", "vos_v").value += 0.00009; // inside ±0.1 mV
	row("ff", "vos_v").value += 0.00011; // outside
	row("ss", "hyst_v").value += 0.00011; // outside ±0.1 mV
	row("tt", "voh_rel").value -= 0.009; // inside ±0.01
	row("tt", "idd_a").value *= 1.03; // outside ±2 %
	answer.rows = answer.rows.filter((r) => !(r.corner === "ff" && r.requirement === "vol_rel"));
	const s = await scoreComparator(workspace(t, designs(name).reference, answer), taskDir(name), { verifier });
	assert.deepEqual(parts(s), [2, ROWS, 4, ROWS - 5]);
	const value = (k) => s.rows[k].value;
	assert.deepEqual(
		["tt tpd_r_s", "ss tpd_f_s", "tt vos_v", "ff vos_v", "ss hyst_v", "tt voh_rel", "tt idd_a"].map(value),
		[true, false, true, false, false, true, false],
	);
	assert.equal(s.rows["ff vol_rel"].reported, null);
});

test("comparator-synthesis: answer.json or cmp.spice missing", async (t) => {
	const name = "sky130";
	const { verifier, calls } = fakeVerifier(name);
	const noAnswer = await scoreComparator(workspace(t, designs(name).reference), taskDir(name), { verifier });
	assert.ok(noAnswer.errors.includes("answer.json not found"));
	assert.deepEqual(parts(noAnswer), [2, ROWS, 0, 0], "no claim: the claim point needs meets_spec");
	assert.equal(noAnswer.meets_spec, null);
	const bad = workspace(t, designs(name).reference);
	writeFileSync(join(bad, "answer.json"), "{ not json");
	assert.match((await scoreComparator(bad, taskDir(name), { verifier })).errors.join(), /answer\.json is not valid JSON/);
	assert.equal(calls.length, 2);
	const noDesign = await scoreComparator(workspace(t, undefined, { meets_spec: false, rows: [] }), taskDir(name), { verifier });
	assert.equal(calls.length, 2, "no design, no verification");
	assert.ok(noDesign.errors.includes("cmp.spice not found"));
	assert.deepEqual([...parts(noDesign), noDesign.design_status], [0, 0, 4, 0, "not_run"]);
	// An ota.spice is not the design of this task.
	const ota = workspace(t, undefined, { meets_spec: false, rows: [] });
	writeFileSync(join(ota, "ota.spice"), designs(name).reference);
	assert.ok((await scoreComparator(ota, taskDir(name), { verifier })).errors.includes("cmp.spice not found"));
});

for (const [name, facts] of Object.entries(TASKS)) {
	test(`comparator-synthesis ${name}: spec.md, requirements.json, verify.spice and task.json say the same`, () => {
		const { task, spec } = loadTask(taskDir(name));
		const bench = readFileSync(join(taskDir(name), "verify.spice"), "utf8");
		const req = JSON.parse(readFileSync(join(taskDir(name), "requirements.json"), "utf8"));
		// 5 VCM points: both ends of the range and 3 inside, with the same step.
		assert.equal(spec.points.length, 5);
		for (let i = 1; i < 5; i++) assert.ok(Math.abs(spec.points[i] - spec.points[i - 1] - (spec.range[1] - spec.range[0]) / 4) < 1e-9);
		const row = new RegExp(`^\\s*echo ROW vcm=\\$vcm ${METRICS.map((m) => `${m}=\\$&${m}`).join(" ")}$`, "m");
		assertBenchMatchesSpec(spec, bench, req, { points: spec.points, metrics: METRICS, row });
		assert.deepEqual(Object.keys(spec.limits), METRICS);
		assert.deepEqual(
			METRICS.map((m) => spec.limits[m].op),
			["<=", "<=", ">=", "<=", "between", "between", "<="],
		);
		assert.deepEqual([spec.limits.voh_rel.value, spec.limits.vol_rel.value, spec.limits.vos_v.value, spec.limits.hyst_v.value], [0.9, 0.1, [-0.005, 0.005], [0, 0.02]]);
		// The bench: the load, the bias, the common mode on inn, the differential source from inn to inp with steps of
		// ±10 mV and a slow ramp, one transient analysis per point with a fixed maximum time step, and no uic.
		assert.match(bench, /^CL out 0 50f$/m);
		assert.match(bench, /^Ib vdd ibias 10u$/m);
		assert.match(bench, /^Vcm inn 0 dc [\d.]+$/m);
		assert.match(bench, /^Vd inp inn dc 0 pwl\(0 -10m 100n -10m 100\.1n 10m 600n 10m 600\.1n -10m 1\.1u -10m 1\.2u -50m 11\.2u 50m 21\.2u -50m\)$/m);
		assert.match(bench, /^Xdut inp inn out vdd vss ibias cmp$/m);
		assert.match(bench, /^\.include "cmp\.spice"$/m);
		assert.match(bench, /^\s*alter vcm dc = \$vcm$/m);
		assert.deepEqual(bench.match(/^\s*tran .*$/gm).map((l) => l.trim()), ["tran 0.1n 21.2u 0 0.5n"]);
		assert.doesNotMatch(bench, /\buic\b/i);
		// The same corners, design limits for R and C, devices and environment as ota-synthesis.
		const ota = JSON.parse(readFileSync(join(repo, "evals/ota-synthesis", name, "requirements.json"), "utf8"));
		assert.deepEqual(req.conditions, ota.conditions);
		assert.deepEqual({ ...req.design, file: null, subckt: null, limits: { ...req.design.limits, gate_area_um2: null } }, { ...ota.design, file: null, subckt: null, limits: { ...ota.design.limits, gate_area_um2: null } });
		assert.equal(readFileSync(join(taskDir(name), "simra.config.json"), "utf8"), readFileSync(join(repo, "evals/ota-synthesis", name, "simra.config.json"), "utf8"));
		// The design contract: the file, the pins in their order, the element kinds, the devices and the limits of spec.md.
		const d = spec.design;
		assert.deepEqual([d.file, d.subckt, d.pins], ["cmp.spice", "cmp", ["inp", "inn", "out", "vdd", "vss", "ibias"]]);
		assert.deepEqual([req.design.file, req.design.subckt, req.design.pins, req.design.elements], [d.file, d.subckt, d.pins, ["mos", "r", "c"]]);
		assert.deepEqual(req.design.devices, d.devices);
		assert.deepEqual(req.design.limits, { gate_area_um2: d.area_um2, r_ohm: d.r_ohm, c_f: d.c_f });
		assert.deepEqual([req.design.technology, req.design.environment], [facts.technology, task.environment]);
		// The devices of spec.md are devices of the technology pack, with the minimum sizes of the pack.
		const pack = JSON.parse(readFileSync(join(repo, "technologies", facts.technology, "technology.json"), "utf8")).ngspice;
		const text = readFileSync(join(taskDir(name), "spec.md"), "utf8");
		const um = (x) => Number((x * 1e6).toFixed(3));
		for (const model of d.devices) {
			const p = pack.devices[model];
			assert.ok(p, `${model} is not in the technology pack ${facts.technology}`);
			if (pack.size_unit_m === 1) {
				assert.ok(text.includes(`W / ng >= ${um(p.params.w.min)} µm and L >= ${um(p.params.l.min)} µm`), `${model}: minimum sizes`);
			} else {
				const line = new RegExp(`^\\s*\\| \`${model}\` \\| ${um(p.params.w.min)} µm \\| ${um(p.params.l.min)} µm \\|$`, "m");
				assert.match(text, line, `${model}: minimum sizes`);
			}
		}
		if (name === "sky130") assert.deepEqual(d.devices, Object.keys(pack.devices), "sky130: every MOS device of the pack");
		else assert.deepEqual(d.devices, ["sg13_lv_nmos", "sg13_lv_pmos"], "sg13cmos5l: the devices of cornerMOSlv.lib");
		// The reference designs use only the devices of the spec.
		for (const [k, design] of Object.entries(designs(name))) {
			for (const m of design.matchAll(/^X\S+(?:\s+\S+){4}\s+(\S+)/gm)) assert.ok(d.devices.includes(m[1]), `${k}: ${m[1]}`);
		}
		// The task gives no netlist, and no answer is a task file.
		assert.deepEqual(Object.keys(task.files).sort(), ["requirements.json", "simra.config.json", "simra.local.json", "spec.md", "verify.spice"]);
		for (const [f, src] of Object.entries(task.files)) if (f !== "simra.local.json") assert.ok(existsSync(join(taskDir(name), src)), `${f} exists`);
		assert.equal(task.files["simra.local.json"], "../../../examples/ota-sg13g2/simra.local.json");
		assert.equal(existsSync(join(taskDir(name), "cmp.spice")), false);
	});
}
