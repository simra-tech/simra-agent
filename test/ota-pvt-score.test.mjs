// The ota-pvt scorer gives full points to a correct answer, and finds the answers that use the team testbench as it is.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseSpec } from "../evals/ota-pvt/reference.mjs";
import { score } from "../evals/ota-pvt/score.mjs";

const repo = new URL("../", import.meta.url).pathname;
const METRICS = ["gain_db", "ugf_hz", "pm_deg"];

// Synthetic reference values: ss fails ugf_hz. The team testbench gives tt values at ss and the phase in radians.
const values = { tt: { gain_db: 52, ugf_hz: 2.0e7, pm_deg: 76 }, ss: { gain_db: 51, ugf_hz: 1.4e7, pm_deg: 79 }, ff: { gain_db: 53, ugf_hz: 2.4e7, pm_deg: 73 } };
const team = { tt: { gain_db: 52, ugf_hz: 2.0e7, pm_deg: 178.67 }, ss: { gain_db: 52, ugf_hz: 1.95e7, pm_deg: 178.67 }, ff: { gain_db: 52.8, ugf_hz: 2.1e7, pm_deg: 178.66 } };
const limits = { gain_db: { op: ">=", value: 50 }, ugf_hz: { op: ">=", value: 1.6e7 }, pm_deg: { op: ">=", value: 60 } };
const pass = (v) => Object.fromEntries(METRICS.map((m) => [m, v[m] >= limits[m].value]));
const expected = {
	limits,
	meets_spec: false,
	tolerance: { gain_db: { abs: 0.5 }, ugf_hz: { rel: 0.05 }, pm_deg: { abs: 2 } },
	corners: Object.fromEntries(Object.keys(values).map((c) => [c, { values: values[c], pass: pass(values[c]), team_testbench: { values: team[c] } }])),
};

function workspace(t, answer, log) {
	const ws = mkdtempSync(join(tmpdir(), "simra-pvt-score-"));
	t.after(() => rmSync(ws, { recursive: true, force: true }));
	if (answer !== undefined) writeFileSync(join(ws, "answer.json"), typeof answer === "string" ? answer : JSON.stringify(answer));
	if (log) writeFileSync(join(ws, "sim.log"), log);
	return ws;
}

const rowsFrom = (v) => Object.entries(v).flatMap(([corner, x]) => METRICS.map((m) => ({ corner, requirement: m, value: x[m], pass: x[m] >= limits[m].value, evidence: "sim.log" })));
const logOf = (v) => Object.entries(v).map(([c, x]) => `${c}: ${METRICS.map((m) => `${m} = ${x[m]}`).join(" ")}`).join("\n");

test("a correct answer gets every point", (t) => {
	const ws = workspace(t, { meets_spec: false, rows: rowsFrom(values) }, logOf(values));
	const s = score(ws, expected);
	assert.deepEqual([s.claim, s.verdicts, s.values, s.supported], [4, 9, 9, 9]);
	assert.deepEqual(s.traps, []);
	assert.deepEqual(s.errors, []);
});

test("the team testbench as it is: a wrong claim, the wrong values and the traps named", (t) => {
	const ws = workspace(t, { meets_spec: true, rows: rowsFrom(team) }, logOf(team));
	const s = score(ws, expected);
	assert.equal(s.claim, 0);
	// Only ss ugf_hz changes its verdict; the phase margin passes with both values.
	assert.equal(s.verdicts, 8);
	assert.equal(s.rows["ss ugf_hz"].verdict, false);
	// Correct: tt gain and UGF, ff gain. Wrong: every phase margin, ss gain and UGF, ff UGF.
	assert.equal(s.values, 3);
	assert.deepEqual(s.traps.sort(), ["ff pm_deg", "ff ugf_hz", "ss gain_db", "ss pm_deg", "ss ugf_hz", "tt pm_deg"]);
	assert.equal(s.supported, 9);
});

test("numbers that no file shows are not supported; missing rows and a missing claim get no points", (t) => {
	const rows = rowsFrom(values).filter((r) => r.corner !== "ff");
	const s = score(workspace(t, { rows }), expected);
	assert.deepEqual([s.claim, s.verdicts, s.values, s.supported], [0, 6, 6, 0]);
	assert.equal(s.meets_spec, null);
	assert.equal(s.rows["ff gain_db"].found, false);
});

test("no answer or invalid JSON is an error with no points", (t) => {
	assert.deepEqual(score(workspace(t), expected).errors, ["answer.json not found"]);
	assert.match(score(workspace(t, "{nope"), expected).errors[0], /not valid JSON/);
});

test("the spec parser reads the corners and the limits of spec.md", () => {
	const text = readFileSync(join(repo, "evals/ota-pvt/spec.md"), "utf8");
	const spec = parseSpec(text);
	assert.deepEqual(spec.corners.ss, { section: "mos_ss", vdd: 1.08, temp: 125 });
	assert.deepEqual(spec.corners.ff, { section: "mos_ff", vdd: 1.32, temp: -40 });
	assert.deepEqual(Object.keys(spec.limits).sort(), METRICS.slice().sort());
});
