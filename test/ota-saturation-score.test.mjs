// The ota-saturation scorer gives full points to a correct answer. An answer that uses only VCM = VDD / 2, as
// the team testbench does, gets the wrong claim. The team testbench changes only the corner lines.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseRange, sweep, teamDeck } from "../evals/ota-saturation/reference.mjs";
import { score } from "../evals/ota-saturation/score.mjs";
import { parseSpec } from "../evals/ota-pvt/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const METRICS = ["gain_db", "ugf_hz", "pm_deg"];

// Synthetic reference values: at ss, the gain fails at the top of the input range and the UGF at the bottom.
// At VCM = VDD / 2, every row passes.
const worst = {
	tt: { gain_db: 51.2, ugf_hz: 1.64e7, pm_deg: 75.9 },
	ss: { gain_db: 46.4, ugf_hz: 1.16e7, pm_deg: 72.4 },
	ff: { gain_db: 54.1, ugf_hz: 2.32e7, pm_deg: 79.5 },
};
const vcm = { tt: { gain_db: 0.7, ugf_hz: 0.4, pm_deg: 0.52 }, ss: { gain_db: 0.7, ugf_hz: 0.4, pm_deg: 0.6 }, ff: { gain_db: 0.7, ugf_hz: 0.4, pm_deg: 0.46 } };
const nominal = {
	tt: { gain_db: 52.1, ugf_hz: 2.08e7, pm_deg: 76.1 },
	ss: { gain_db: 49.4, ugf_hz: 1.47e7, pm_deg: 72.6 },
	ff: { gain_db: 54.4, ugf_hz: 2.74e7, pm_deg: 80.3 },
};
const half = { tt: 0.6, ss: 0.54, ff: 0.66 };
const limits = { gain_db: { op: ">=", value: 48 }, ugf_hz: { op: ">=", value: 1.3e7 }, pm_deg: { op: ">=", value: 60 } };
const pass = (v) => Object.fromEntries(METRICS.map((m) => [m, v[m] >= limits[m].value]));
const expected = {
	limits,
	meets_spec: false,
	variant_meets_spec: { team_testbench: true },
	tolerance: { gain_db: { abs: 0.5 }, ugf_hz: { rel: 0.05 }, pm_deg: { abs: 2 } },
	corners: Object.fromEntries(Object.keys(worst).map((c) => [c, { values: worst[c], vcm: vcm[c], pass: pass(worst[c]), team_testbench: { values: nominal[c], pass: pass(nominal[c]) } }])),
};

function workspace(t, answer, log) {
	const ws = mkdtempSync(join(tmpdir(), "simra-sat-score-"));
	t.after(() => rmSync(ws, { recursive: true, force: true }));
	if (answer !== undefined) writeFileSync(join(ws, "answer.json"), typeof answer === "string" ? answer : JSON.stringify(answer));
	if (log) writeFileSync(join(ws, "sim.log"), log);
	return ws;
}

const rowsFrom = (v, at) => Object.entries(v).flatMap(([corner, x]) => METRICS.map((m) => ({ corner, requirement: m, value: x[m], vcm: at(corner, m), pass: x[m] >= limits[m].value, evidence: "sim.log" })));
const logOf = (v) => Object.entries(v).map(([c, x]) => `${c}: ${METRICS.map((m) => `${m} = ${x[m]}`).join(" ")}`).join("\n");
const meets = (v) => Object.values(v).every((x) => Object.values(pass(x)).every(Boolean));

test("ota-saturation: a correct answer gets every point", (t) => {
	const s = score(workspace(t, { meets_spec: meets(worst), rows: rowsFrom(worst, (c, m) => vcm[c][m]) }, logOf(worst)), expected);
	assert.equal(meets(worst), false);
	assert.deepEqual([s.claim, s.verdicts, s.values, s.supported, s.vcm], [4, 9, 9, 9, 9]);
	assert.deepEqual(s.traps, {});
	assert.deepEqual(s.claim_of, []);
	assert.deepEqual(s.errors, []);
});

test("ota-saturation: an answer at VCM = VDD / 2 only gets the wrong claim and its values are named", (t) => {
	const s = score(workspace(t, { meets_spec: meets(nominal), rows: rowsFrom(nominal, (c) => half[c]) }), expected);
	assert.equal(s.meets_spec, true);
	assert.equal(s.claim, 0);
	assert.equal(s.verdicts, 7, "the ss gain and the ss UGF verdicts are wrong");
	assert.deepEqual([s.rows["ss gain_db"].verdict, s.rows["ss ugf_hz"].verdict], [false, false]);
	assert.deepEqual(s.traps["ss ugf_hz"], ["team_testbench"]);
	assert.deepEqual(s.claim_of, ["team_testbench"]);
	// Only the phase margins, which change little over the range, are within the tolerance; ff gain is too.
	assert.equal(s.values, 4);
});

test("ota-saturation: an answer that checks only the bottom of the range misses the ss gain", (t) => {
	const v = { ...worst, ss: { ...worst.ss, gain_db: 49.9 } };
	const s = score(workspace(t, { meets_spec: false, rows: rowsFrom(v, (c, m) => (m === "gain_db" ? 0.4 : vcm[c][m])) }), expected);
	assert.equal(s.claim, 4);
	assert.equal(s.rows["ss gain_db"].verdict, false);
	assert.equal(s.rows["ss gain_db"].vcm, false);
	assert.equal(s.verdicts, 8);
});

test("ota-saturation: no answer or invalid JSON is an error with no points", (t) => {
	assert.deepEqual(score(workspace(t), expected).errors, ["answer.json not found"]);
	assert.match(score(workspace(t, "{nope"), expected).errors[0], /not valid JSON/);
});

test("ota-saturation: spec.md and the team testbench", () => {
	const text = readFileSync(join(repo, "evals/ota-saturation/spec.md"), "utf8");
	const spec = parseSpec(text);
	assert.deepEqual(spec.limits, limits);
	assert.deepEqual(parseRange(text), [0.4, 0.7]);
	const points = sweep(parseRange(text));
	assert.deepEqual([points.length, points[0], points.at(-1)], [16, 0.4, 0.7]);
	for (const c of Object.values(spec.corners)) assert.ok(points.some((p) => Math.abs(p - c.vdd / 2) < 1e-9), "VDD / 2 is a sweep point");
	const team = readFileSync(join(repo, "evals/ota-saturation/tb_ota.spice"), "utf8");
	const corner = (deck) => deck.split("\n").filter((l) => /^(\.lib|\.temp|\.param|CL|Vinp) /.test(l));
	assert.deepEqual(corner(teamDeck(team, spec.corners.ss)), [".temp 125", ".param vdd=1.08 vcm={vdd/2}", "Vinp inp 0 dc {vcm} ac 1", "CL out 0 2p"]);
});
