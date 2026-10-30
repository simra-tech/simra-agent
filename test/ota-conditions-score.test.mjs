// The ota-conditions scorer gives full points to a correct answer, and names the testbench variant of each wrong
// value. The team testbench variants change only the conditions lines.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { teamDeck, VARIANTS } from "../evals/ota-conditions/reference.mjs";
import { score } from "../evals/ota-conditions/score.mjs";
import { parseSpec } from "../evals/ota-pvt/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const METRICS = ["gain_db", "ugf_hz", "pm_deg"];

// Synthetic reference values: the phase margin fails at ss. The team testbench (VCM = 0.4 V, CL = 0.5 pF) passes
// every row. With only CL corrected, the ss phase margin passes and the ss UGF fails: the claim is correct for the
// wrong reason.
const values = { tt: { gain_db: 52.1, ugf_hz: 2.08e7, pm_deg: 76.1 }, ss: { gain_db: 49.4, ugf_hz: 1.47e7, pm_deg: 72.6 }, ff: { gain_db: 54.4, ugf_hz: 2.74e7, pm_deg: 80.3 } };
const variants = {
	team_testbench: { tt: { gain_db: 53.1, ugf_hz: 1.85e7, pm_deg: 96.6 }, ss: { gain_db: 49.93, ugf_hz: 1.27e7, pm_deg: 91.3 }, ff: { gain_db: 55.6, ugf_hz: 2.76e7, pm_deg: 103.5 } },
	cl_fixed_only: { tt: { gain_db: 53.1, ugf_hz: 1.64e7, pm_deg: 77.3 }, ss: { gain_db: 49.93, ugf_hz: 1.16e7, pm_deg: 75.1 }, ff: { gain_db: 55.6, ugf_hz: 2.32e7, pm_deg: 79.8 } },
	vcm_fixed_only: { tt: { gain_db: 52.1, ugf_hz: 2.48e7, pm_deg: 99.2 }, ss: { gain_db: 49.4, ugf_hz: 1.69e7, pm_deg: 92.1 }, ff: { gain_db: 54.4, ugf_hz: 3.48e7, pm_deg: 106.9 } },
};
const limits = { gain_db: { op: ">=", value: 48 }, ugf_hz: { op: ">=", value: 1.2e7 }, pm_deg: { op: ">=", value: 75 } };
const pass = (v) => Object.fromEntries(METRICS.map((m) => [m, v[m] >= limits[m].value]));
const meets = (byCorner) => Object.values(byCorner).every((v) => Object.values(pass(v)).every(Boolean));
const expected = {
	limits,
	meets_spec: meets(values),
	variant_meets_spec: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, meets(v)])),
	tolerance: { gain_db: { abs: 0.5 }, ugf_hz: { rel: 0.05 }, pm_deg: { abs: 2 } },
	corners: Object.fromEntries(Object.keys(values).map((c) => [c, { values: values[c], pass: pass(values[c]), ...Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, { values: v[c], pass: pass(v[c]) }])) }])),
};

function workspace(t, answer, log) {
	const ws = mkdtempSync(join(tmpdir(), "simra-cond-score-"));
	t.after(() => rmSync(ws, { recursive: true, force: true }));
	if (answer !== undefined) writeFileSync(join(ws, "answer.json"), typeof answer === "string" ? answer : JSON.stringify(answer));
	if (log) writeFileSync(join(ws, "sim.log"), log);
	return ws;
}

const rowsFrom = (v) => Object.entries(v).flatMap(([corner, x]) => METRICS.map((m) => ({ corner, requirement: m, value: x[m], pass: x[m] >= limits[m].value, evidence: "sim.log" })));
const logOf = (v) => Object.entries(v).map(([c, x]) => `${c}: ${METRICS.map((m) => `${m} = ${x[m]}`).join(" ")}`).join("\n");
const answerFrom = (v) => ({ meets_spec: meets(v), rows: rowsFrom(v) });

test("ota-conditions: a correct answer gets every point", (t) => {
	assert.equal(expected.meets_spec, false);
	const s = score(workspace(t, answerFrom(values), logOf(values)), expected);
	assert.deepEqual([s.claim, s.verdicts, s.values, s.supported], [4, 9, 9, 9]);
	assert.deepEqual(s.traps, {});
	assert.deepEqual(s.claim_of, ["cl_fixed_only"], "only the CL-corrected variant also fails");
	assert.deepEqual(s.errors, []);
});

test("ota-conditions: the team testbench as it is gives the wrong claim and its values are named", (t) => {
	const v = variants.team_testbench;
	const s = score(workspace(t, answerFrom(v), logOf(v)), expected);
	assert.equal(s.meets_spec, true);
	assert.equal(s.claim, 0);
	assert.equal(s.verdicts, 8, "only the ss phase margin verdict is wrong");
	assert.equal(s.rows["ss pm_deg"].verdict, false);
	// Only the ff UGF is within the tolerance (by chance). The other rows are wrong.
	assert.equal(s.values, 1);
	// At ss, the team testbench and the VCM-only variant give phase margins within the tolerance of each other.
	assert.deepEqual(s.traps["ss pm_deg"], ["team_testbench", "vcm_fixed_only"]);
	assert.deepEqual(s.traps["tt ugf_hz"], ["team_testbench"]);
	assert.deepEqual(s.claim_of, ["team_testbench", "vcm_fixed_only"]);
});

test("ota-conditions: one fault corrected, the other kept", (t) => {
	const cl = score(workspace(t, answerFrom(variants.cl_fixed_only)), expected);
	assert.equal(cl.meets_spec, false);
	assert.equal(cl.claim, 4, "the correct claim, for the wrong reason");
	assert.deepEqual([cl.rows["ss ugf_hz"].verdict, cl.rows["ss pm_deg"].verdict], [false, false]);
	assert.equal(cl.verdicts, 7);
	assert.deepEqual(cl.traps["ss pm_deg"], ["cl_fixed_only"]);
	const vcm = score(workspace(t, answerFrom(variants.vcm_fixed_only)), expected);
	assert.equal(vcm.claim, 0);
	assert.deepEqual(vcm.traps["tt pm_deg"], ["vcm_fixed_only"]);
	assert.equal(vcm.rows["tt gain_db"].value, true, "the gain does not depend on CL");
});

test("ota-conditions: no answer or invalid JSON is an error with no points", (t) => {
	assert.deepEqual(score(workspace(t), expected).errors, ["answer.json not found"]);
	assert.match(score(workspace(t, "{nope"), expected).errors[0], /not valid JSON/);
});

test("ota-conditions: spec.md and the team testbench variants", () => {
	const spec = parseSpec(readFileSync(join(repo, "evals/ota-conditions/spec.md"), "utf8"));
	assert.deepEqual(spec.limits, limits);
	assert.deepEqual(spec.corners.ss, { section: "mos_ss", vdd: 1.08, temp: 125 });
	const team = readFileSync(join(repo, "evals/ota-conditions/tb_ota.spice"), "utf8");
	const lines = (deck) => deck.split("\n").filter((l) => /^(\.lib|\.temp|\.param|CL) /.test(l));
	assert.deepEqual(lines(teamDeck(team, spec.corners.ss, VARIANTS.team_testbench)), [".temp 125", ".param vdd=1.08 vcm=0.4", "CL out 0 0.5p"]);
	assert.deepEqual(lines(teamDeck(team, spec.corners.ss, VARIANTS.cl_fixed_only)), [".temp 125", ".param vdd=1.08 vcm=0.4", "CL out 0 2p"]);
	assert.deepEqual(lines(teamDeck(team, spec.corners.ss, ["cl", "vcm"])), [".temp 125", ".param vdd=1.08 vcm=0.54", "CL out 0 2p"]);
	// The rest of the testbench does not change.
	const rest = (deck) => deck.split("\n").filter((l) => !/^(\.lib|\.temp|\.param|CL) /.test(l));
	assert.deepEqual(rest(teamDeck(team, spec.corners.ff, ["cl", "vcm"])), rest(team));
});
