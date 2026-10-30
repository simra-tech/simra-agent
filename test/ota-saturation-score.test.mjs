// The ota-saturation scorer gives full points to a correct answer. An answer that checks only the AC rows gets
// the wrong claim. The team testbench changes only the corner lines.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { teamDeck } from "../evals/ota-saturation/reference.mjs";
import { deviceName, score } from "../evals/ota-saturation/score.mjs";
import { parseSpec } from "../evals/ota-pvt/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const METRICS = ["gain_db", "ugf_hz", "pm_deg", "sat_margin_v"];

// Synthetic reference values: every AC row passes, and XM5 is out of saturation at ss.
const values = {
	tt: { gain_db: 52.1, ugf_hz: 2.08e7, pm_deg: 76.1, sat_margin_v: 0.034 },
	ss: { gain_db: 49.4, ugf_hz: 1.47e7, pm_deg: 72.6, sat_margin_v: -0.071 },
	ff: { gain_db: 54.4, ugf_hz: 2.74e7, pm_deg: 80.3, sat_margin_v: 0.138 },
};
const overdrive = { tt: 0.047, ss: -0.055, ff: 0.145 };
const limits = { gain_db: { op: ">=", value: 48 }, ugf_hz: { op: ">=", value: 1.2e7 }, pm_deg: { op: ">=", value: 60 }, sat_margin_v: { op: ">=", value: 0 } };
const pass = (v) => Object.fromEntries(METRICS.map((m) => [m, v[m] >= limits[m].value]));
const expected = {
	limits,
	meets_spec: false,
	variant_meets_spec: { ac_only: true, overdrive: false },
	tolerance: { gain_db: { abs: 0.5 }, ugf_hz: { rel: 0.05 }, pm_deg: { abs: 2 }, sat_margin_v: { abs: 0.01 } },
	corners: Object.fromEntries(
		Object.entries(values).map(([c, v]) => [c, { values: v, pass: pass(v), device: "XM5", overdrive: { values: { sat_margin_v: overdrive[c] }, device: "XM5", pass: { sat_margin_v: overdrive[c] >= 0 } } }]),
	),
};

function workspace(t, answer, log) {
	const ws = mkdtempSync(join(tmpdir(), "simra-sat-score-"));
	t.after(() => rmSync(ws, { recursive: true, force: true }));
	if (answer !== undefined) writeFileSync(join(ws, "answer.json"), typeof answer === "string" ? answer : JSON.stringify(answer));
	if (log) writeFileSync(join(ws, "sim.log"), log);
	return ws;
}

const rowsFrom = (v, metrics = METRICS) =>
	Object.entries(v).flatMap(([corner, x]) => metrics.map((m) => ({ corner, requirement: m, value: x[m], pass: x[m] >= limits[m].value, device: m === "sat_margin_v" ? "XM5" : undefined, evidence: "sim.log" })));
const logOf = (v) => Object.entries(v).map(([c, x]) => `${c}: ${METRICS.map((m) => `${m} = ${x[m]}`).join(" ")}`).join("\n");

test("ota-saturation: a correct answer gets every point", (t) => {
	const s = score(workspace(t, { meets_spec: false, rows: rowsFrom(values) }, logOf(values)), expected);
	assert.deepEqual([s.claim, s.verdicts, s.values, s.supported, s.devices], [4, 12, 12, 12, 3]);
	assert.deepEqual(s.traps, {});
	assert.deepEqual(s.claim_of, ["overdrive"]);
	assert.deepEqual(s.errors, []);
});

test("ota-saturation: an answer that checks only the AC rows gets the wrong claim", (t) => {
	const s = score(workspace(t, { meets_spec: true, rows: rowsFrom(values, ["gain_db", "ugf_hz", "pm_deg"]) }), expected);
	assert.equal(s.claim, 0);
	assert.deepEqual([s.verdicts, s.values, s.devices], [9, 9, 0]);
	assert.equal(s.rows["ss sat_margin_v"].found, false);
	assert.deepEqual(s.claim_of, ["ac_only"]);
});

test("ota-saturation: VGS - VTH in place of VDSAT is named as a trap", (t) => {
	const v = Object.fromEntries(Object.entries(values).map(([c, x]) => [c, { ...x, sat_margin_v: overdrive[c] }]));
	const s = score(workspace(t, { meets_spec: false, rows: rowsFrom(v) }), expected);
	assert.equal(s.claim, 4);
	assert.equal(s.verdicts, 12);
	// tt and ss are outside the tolerance; ff is within it.
	assert.equal(s.values, 10);
	assert.deepEqual(s.traps, { "tt sat_margin_v": ["overdrive"], "ss sat_margin_v": ["overdrive"] });
});

test("ota-saturation: device names and errors", (t) => {
	assert.deepEqual(["XM5", "xm5", "Xdut.XM5", "n.xdut.xm5.nsg13_lv_nmos", "M5", "tail", null].map(deviceName), ["XM5", "XM5", "XM5", "XM5", "XM5", null, null]);
	assert.deepEqual(score(workspace(t), expected).errors, ["answer.json not found"]);
	assert.match(score(workspace(t, "{nope"), expected).errors[0], /not valid JSON/);
});

test("ota-saturation: spec.md and the team testbench", () => {
	const spec = parseSpec(readFileSync(join(repo, "evals/ota-saturation/spec.md"), "utf8"));
	assert.deepEqual(spec.limits, limits);
	const team = readFileSync(join(repo, "evals/ota-saturation/tb_ota.spice"), "utf8");
	const corner = (deck) => deck.split("\n").filter((l) => /^(\.lib|\.temp|\.param|CL|Vinp) /.test(l));
	assert.deepEqual(corner(teamDeck(team, spec.corners.ss)), [".temp 125", ".param vdd=1.08 vcm={vdd/2}", "Vinp inp 0 dc {vcm} ac 1", "CL out 0 2p"]);
	// The team testbench measures only the AC response.
	assert.doesNotMatch(team, /vdss|vdsat|@/i);
});
