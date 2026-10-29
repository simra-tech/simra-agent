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

// Synthetic reference values: every row passes. The team testbench (a shunt resistor at each node, no PVT
// conditions) gives a lower gain at every corner.
const values = { tt: { gain_db: 52.1, ugf_hz: 2.08e7, pm_deg: 76.1 }, ss: { gain_db: 49.4, ugf_hz: 1.47e7, pm_deg: 72.6 }, ff: { gain_db: 54.4, ugf_hz: 2.74e7, pm_deg: 80.3 } };
const team = { tt: { gain_db: 46.1, ugf_hz: 1.6e7, pm_deg: 74.7 }, ss: { gain_db: 45.9, ugf_hz: 1.51e7, pm_deg: 74.3 }, ff: { gain_db: 46.4, ugf_hz: 1.7e7, pm_deg: 75.2 } };
const limits = { gain_db: { op: ">=", value: 48 }, ugf_hz: { op: ">=", value: 1.3e7 }, pm_deg: { op: ">=", value: 60 } };
const pass = (v) => Object.fromEntries(METRICS.map((m) => [m, v[m] >= limits[m].value]));
const expected = {
	limits,
	meets_spec: true,
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
	const ws = workspace(t, { meets_spec: true, rows: rowsFrom(values) }, logOf(values));
	const s = score(ws, expected);
	assert.deepEqual([s.claim, s.verdicts, s.values, s.supported], [4, 9, 9, 9]);
	assert.deepEqual(s.traps, []);
	assert.deepEqual(s.errors, []);
});

test("the team testbench as it is: a wrong claim, the wrong values and the traps named", (t) => {
	const ws = workspace(t, { meets_spec: false, rows: rowsFrom(team) }, logOf(team));
	const s = score(ws, expected);
	assert.equal(s.claim, 0);
	// The gain fails at every corner; the UGF and the phase margin pass with both values.
	assert.equal(s.verdicts, 6);
	assert.deepEqual(["tt", "ss", "ff"].map((c) => s.rows[`${c} gain_db`].verdict), [false, false, false]);
	// Within the tolerance by chance: tt and ss phase margin, ss UGF. The other rows have the team values.
	assert.equal(s.values, 3);
	assert.deepEqual(s.traps.sort(), ["ff gain_db", "ff pm_deg", "ff ugf_hz", "ss gain_db", "tt gain_db", "tt ugf_hz"]);
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
