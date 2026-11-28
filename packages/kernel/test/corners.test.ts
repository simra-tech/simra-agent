// The required-corner gate (gates.corners): a block declares the corners that it must pass. A requirement of the gate
// without a result at a required corner gives a gate row that is not run: never omitted, and never passed by the
// typical corner. On the fake adapter; the corner names are those of the public IHP SG13G2 flow.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cornersGateRows, formatVerdict, runCheck, validateRequirements, type RequirementsFile, type VerdictRow } from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const TYP = "nom_typ_1p20V_25C";
const SLOW = "nom_slow_1p08V_125C";
const FAST = "nom_fast_1p32V_m40C";

function designRoot(t: { after: (fn: () => void) => void }, requirements: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "simra-corners-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	writeFileSync(join(root, "requirements.json"), JSON.stringify(requirements));
	return root;
}

/** An amplifier with one experiment per corner: the gain passes at the three corners, the noise is checked at the typical corner only. */
const amplifier = (noiseAt: string[] = [TYP]) => ({
	schema: "simra.requirements/0",
	conditions: {
		[TYP]: { inputs: { values: { gain_db: 62, noise_nv: 4 } } },
		[SLOW]: { inputs: { values: { gain_db: 59, noise_nv: 6 } } },
		[FAST]: { inputs: { values: { gain_db: 64, noise_nv: 3 } } },
	},
	experiments: { ac: { adapter: "fake", operation: "run", inputs: { mode: "values", units: { gain_db: "dB", noise_nv: "nV" } } } },
	requirements: [
		{ id: "gain", experiment: "ac", measurement: "gain_db", unit: "dB", op: ">=", limit: 58, conditions: [TYP, SLOW, FAST] },
		{ id: "noise", experiment: "ac", measurement: "noise_nv", unit: "nV", op: "<=", limit: 5, conditions: noiseAt },
	],
	gates: { corners: { required: [TYP, SLOW, FAST] } },
});

/** A digital block: one read of the flow gives one slack per corner. The flow analysed the corners in "analysed". */
const digital = (analysed: Record<string, number>) => ({
	schema: "simra.requirements/0",
	conditions: { [TYP]: {}, [SLOW]: {}, [FAST]: {} },
	experiments: {
		flow: { adapter: "fake", operation: "run", inputs: { mode: "values", values: Object.fromEntries(Object.entries(analysed).map(([c, v]) => [`setup_ws_ns@${c}`, v])), units: Object.fromEntries(Object.keys(analysed).map((c) => [`setup_ws_ns@${c}`, "ns"])) } },
	},
	requirements: [{ id: "setup", experiment: "flow", measurement: "setup_ws_ns@{condition}", unit: "ns", op: ">=", limit: 0, conditions: [TYP, SLOW, FAST] }],
	gates: { corners: { required: [TYP, SLOW, FAST] } },
});

const gateRow = (rows: VerdictRow[], requirement: string, condition: string) =>
	rows.find((r) => r.gate?.name === "corners" && r.gate.stage === requirement && r.condition === condition) as VerdictRow;

test("every required corner has a result: the gate rows take the status of the rows, and the check passes", async (t) => {
	const root = designRoot(t, amplifier([TYP, SLOW, FAST]));
	const { verdict } = await runCheck({ root });
	// noise fails at the slow corner (6 nV > 5 nV): the gate row is a fail, not a not run.
	assert.equal(verdict.status, "fail");
	assert.deepEqual(verdict.counts, { pass: 10, fail: 2, not_measured: 0, not_run: 0 });
	const slow = gateRow(verdict.rows, "noise", SLOW);
	assert.deepEqual([slow.status, slow.value, slow.reason, slow.requirement], ["fail", 6, "from requirement noise", "gate corners noise"]);
	const typ = gateRow(verdict.rows, "gain", TYP);
	assert.deepEqual([typ.status, typ.value, typ.margin, typ.gate], ["pass", 62, 4, { name: "corners", stage: "gain", covered_by: ["gain"] }]);
	assert.equal(typ.experiment, verdict.rows.find((r) => r.requirement === "gain" && r.condition === TYP)?.experiment);

	// Negative control: with a noise limit that every corner meets, the check passes with the gate.
	const ok = amplifier([TYP, SLOW, FAST]);
	ok.requirements[1].limit = 7;
	const passed = await runCheck({ root: designRoot(t, ok) });
	assert.equal(passed.verdict.status, "pass");
	assert.deepEqual(passed.verdict.counts, { pass: 12, fail: 0, not_measured: 0, not_run: 0 });
});

test("a requirement that is checked at the typical corner only: the other required corners are not run, and the check cannot pass", async (t) => {
	const root = designRoot(t, amplifier([TYP]));
	const { verdict } = await runCheck({ root });
	// Every row that exists passes: without the gate this check is a pass.
	assert.ok(verdict.rows.filter((r) => !r.gate).every((r) => r.status === "pass"));
	assert.equal(verdict.status, "incomplete");
	assert.deepEqual(verdict.counts, { pass: 8, fail: 0, not_measured: 0, not_run: 2 });
	for (const c of [SLOW, FAST]) {
		const row = gateRow(verdict.rows, "noise", c);
		assert.equal(row.status, "not_run");
		assert.equal(row.value, null);
		assert.equal(row.reason, `requirement noise has no row at the required corner ${c} (its conditions are ${TYP}). A pass at another corner does not cover it.`);
		assert.deepEqual(row.gate, { name: "corners", stage: "noise", covered_by: [] });
	}
	assert.equal(gateRow(verdict.rows, "noise", TYP).status, "pass");
	const text = formatVerdict(root, verdict);
	assert.match(text, /^check \S+: INCOMPLETE \(8 pass, 0 fail, 0 not measured, 2 not run; 3 experiments\)$/m);
	assert.match(text, new RegExp(`^  NOT_RUN      gate corners noise @ ${SLOW}: -, limit <= 5 \\(requirement noise has no row at the required corner`, "m"));
	// Negative control: the same file without the gate passes.
	const { gates: _gates, ...noGate } = amplifier([TYP]);
	assert.equal((await runCheck({ root: designRoot(t, noGate) })).verdict.status, "pass");
});

test("a corner that is only reported, a row that is not selected and a run that failed do not cover a required corner", async (t) => {
	const reported = amplifier([TYP]) as RequirementsFile;
	reported.requirements[1].reported = { conditions: [SLOW], reason: "the noise model has no slow corner" };
	const first = await runCheck({ root: designRoot(t, reported) });
	assert.equal(gateRow(first.verdict.rows, "noise", SLOW).reason, `requirement noise reports the required corner ${SLOW} and does not score it (the noise model has no slow corner). A reported row does not cover a required corner.`);
	assert.equal(first.verdict.status, "incomplete");

	// A check of the typical corner alone: the gate rows of the other corners are in the verdict and in the summary.
	const root = designRoot(t, amplifier([TYP, SLOW, FAST]));
	const partial = await runCheck({ root, conditions: [TYP] });
	const row = gateRow(partial.verdict.rows, "gain", SLOW);
	assert.deepEqual([row.status, row.reason], ["not_run", `no result at the required corner ${SLOW}: not selected in this check`]);
	assert.match(formatVerdict(root, partial.verdict), new RegExp(`^  NOT_RUN      gate corners gain @ ${FAST}: -, limit >= 58 \\(no result at the required corner ${FAST}: not selected in this check\\)$`, "m"));

	// The experiment of the slow corner fails: its rows are not run, and so is the gate row.
	const failed = amplifier([TYP, SLOW, FAST]) as RequirementsFile;
	failed.conditions[SLOW].inputs = { mode: "failed" };
	const third = await runCheck({ root: designRoot(t, failed) });
	assert.match(gateRow(third.verdict.rows, "gain", SLOW).reason ?? "", new RegExp(`^no result at the required corner ${SLOW}: experiment \\S+ ended with status failed$`));
	assert.equal(gateRow(third.verdict.rows, "gain", SLOW).status, "not_run");
	assert.equal(gateRow(third.verdict.rows, "gain", FAST).status, "pass");
});

test("one result with one measurement per corner: a corner that the flow did not analyse is not run, not omitted", async (t) => {
	// The flow analysed the typical corner only. Its slack is positive.
	const root = designRoot(t, digital({ [TYP]: 0.41 }));
	const { verdict } = await runCheck({ root });
	const typ = verdict.rows.find((r) => r.requirement === "setup" && r.condition === TYP) as VerdictRow;
	assert.deepEqual([typ.status, typ.value, typ.measurement], ["pass", 0.41, `setup_ws_ns@${TYP}`]);
	for (const c of [SLOW, FAST]) {
		const own = verdict.rows.find((r) => r.requirement === "setup" && r.condition === c) as VerdictRow;
		assert.equal(own.status, "not_measured");
		const gate = gateRow(verdict.rows, "setup", c);
		assert.equal(gate.status, "not_run");
		assert.equal(gate.measurement, `setup_ws_ns@${c}`);
		assert.match(gate.reason ?? "", new RegExp(`^no result at the required corner ${c}: experiment \\S+ gave no value for setup_ws_ns@${c}$`));
	}
	assert.equal(verdict.status, "incomplete");
	assert.deepEqual(verdict.counts, { pass: 2, fail: 0, not_measured: 2, not_run: 2 });

	// Negative control: the flow analysed the three corners. The slow corner fails, and the gate says fail.
	const all = await runCheck({ root: designRoot(t, digital({ [TYP]: 0.41, [SLOW]: -0.2, [FAST]: 1.1 })) });
	assert.deepEqual([TYP, SLOW, FAST].map((c) => gateRow(all.verdict.rows, "setup", c).status), ["pass", "fail", "pass"]);
	assert.equal(all.verdict.status, "fail");
	const pass = await runCheck({ root: designRoot(t, digital({ [TYP]: 0.41, [SLOW]: 0.02, [FAST]: 1.1 })) });
	assert.equal(pass.verdict.status, "pass");
});

test("gates.corners.requirements names the requirements of the gate; a named requirement without conditions is not run", async (t) => {
	const file = amplifier([TYP]) as RequirementsFile;
	file.gates = { corners: { required: [TYP, SLOW, FAST], requirements: ["gain"] } };
	const only = await runCheck({ root: designRoot(t, file) });
	assert.equal(only.verdict.status, "pass", "noise is not in the gate");
	assert.equal(only.verdict.rows.filter((r) => r.gate?.name === "corners").length, 3);

	const area = amplifier([TYP, SLOW, FAST]) as RequirementsFile;
	area.experiments.size = { adapter: "fake", operation: "run", inputs: { mode: "values", values: { area_um2: 700 } } };
	area.requirements.push({ id: "area", experiment: "size", measurement: "area_um2", op: "<=", limit: 800 });
	// By default a requirement without conditions is not in the gate.
	assert.equal(cornersGateRows(area, []).filter((r) => r.gate?.stage === "area").length, 0);
	area.gates = { corners: { required: [TYP, SLOW], requirements: ["area"] } };
	const rows = cornersGateRows(area, []);
	assert.deepEqual(rows.map((r) => [r.condition, r.status, r.limit]), [[TYP, "not_run", 800], [SLOW, "not_run", 800]]);
	assert.match(rows[0].reason ?? "", /^requirement area has no row at the required corner nom_typ_1p20V_25C \(it has no conditions\)/);
});

test("an invalid corner gate names every problem", () => {
	const errors = (gate: unknown, change: (f: RequirementsFile) => void = () => {}) => {
		const file = amplifier() as RequirementsFile;
		(file.gates as Record<string, unknown>).corners = gate;
		change(file);
		return validateRequirements(file);
	};
	assert.deepEqual(errors({ required: [TYP, "ss"] }), ['gates.corners: required corner "ss" is not defined in conditions']);
	assert.deepEqual(errors({ required: [] }), ["gates.corners: required must list the corners that the block must pass (names of conditions)"]);
	assert.deepEqual(errors({ required: [TYP, TYP] }), ["gates.corners: a required corner is listed more than once"]);
	assert.deepEqual(errors({ required: [TYP], typical: TYP }), ["gates.corners.typical: unknown field; the fields are required and requirements"]);
	assert.deepEqual(errors({ required: [TYP], requirements: ["speed"] }), ['gates.corners: requirement "speed" is not defined']);
	assert.deepEqual(errors({ required: [TYP], requirements: [] }), ["gates.corners: requirements must list requirement ids (or leave the field out: every requirement that has conditions)"]);
	assert.deepEqual(errors(null), ["gates.corners: must be an object with required (the corners that the block must pass)"]);
	assert.deepEqual(
		errors({ required: [TYP] }, (f) => {
			f.requirements = [{ id: "area", experiment: "ac", measurement: "gain_db", op: "<=", limit: 800 }];
		}),
		["gates.corners: no requirement has conditions, so the gate has no requirement. Give the requirements their conditions, or name them in gates.corners.requirements"],
	);
	assert.deepEqual(
		errors({ required: [TYP] }, (f) => {
			f.requirements.push({ id: "setup", experiment: "ac", measurement: "setup_ws_ns@{condition}", op: ">=", limit: 0 });
		}),
		['requirement "setup": measurement uses {condition}, so the requirement needs conditions'],
	);
	assert.deepEqual(errors({ required: [TYP, SLOW, FAST] }), []);
});

test("simra check: a block that passes at the typical corner only exits with 1, and the summary names each corner without a result", (t) => {
	const root = designRoot(t, digital({ [TYP]: 0.41 }));
	const r = spawnSync("node", [cli, "--root", root, "check"], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stdout, /^check \S+: INCOMPLETE \(2 pass, 0 fail, 2 not measured, 2 not run; 3 experiments\)$/m);
	assert.match(r.stdout, /^Not every part of the check passed or ran, so this check does not show that the design meets its requirements\.$/m);
	for (const c of [SLOW, FAST]) assert.match(r.stdout, new RegExp(`^  NOT_RUN      gate corners setup @ ${c}: -, limit >= 0 \\[\\S+\\] \\(no result at the required corner ${c}: `, "m"));
	assert.match(r.stdout, new RegExp(`^  PASS         gate corners setup @ ${TYP}: 0\\.41 ns, limit >= 0 `, "m"));
});
