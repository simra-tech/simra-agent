// The rf-passive-gain eval: the task file is the output of generate.mjs, the reference agrees with the closed form,
// and the scorer gives the points to the reference value and names the traps.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ampS21, db, F0, touchstoneText } from "../evals/rf-passive-gain/network.mjs";
import { traps } from "../evals/rf-passive-gain/reference.mjs";
import { score } from "../evals/rf-passive-gain/score.mjs";

const here = new URL("../evals/rf-passive-gain/", import.meta.url).pathname;
const expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"));

function workspace(t, answer, files = {}) {
	const ws = mkdtempSync(join(tmpdir(), "simra-rfgain-score-"));
	t.after(() => rmSync(ws, { recursive: true, force: true }));
	if (answer !== undefined) writeFileSync(join(ws, "answer.json"), typeof answer === "string" ? answer : JSON.stringify(answer));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(ws, name), text);
	return ws;
}

test("rf-passive-gain: match.s2p is the output of generate.mjs", () => {
	assert.equal(readFileSync(join(here, "match.s2p"), "utf8"), touchstoneText());
});

test("rf-passive-gain: expected.json agrees with the closed form and the traps", () => {
	assert.ok(Math.abs(expected.gain_db - db(ampS21(F0))) < 0.05);
	assert.equal(expected.cross_check.closed_form_gain_db, db(ampS21(F0)));
	assert.deepEqual(expected.traps, traps());
	for (const v of Object.values(expected.traps)) assert.ok(Math.abs(v - expected.gain_db) > 2 * expected.tolerance.gain_db.abs);
});

test("rf-passive-gain: the scorer gives the points to the reference value and names the traps", (t) => {
	const good = score(workspace(t, { gain_db: 14.92, f0_hz: 10e9, evidence: "run" }, { "log.txt": "S21 = 14.92 dB" }), expected);
	assert.equal(good.gain, 4);
	assert.equal(good.supported, true);
	assert.equal(good.frequency, true);
	const trap = score(workspace(t, { gain_db: 13.35, f0_hz: 1e10 }), expected);
	assert.equal(trap.gain, 0);
	assert.equal(trap.trap, "without_network");
	assert.equal(trap.supported, false);
	assert.equal(score(workspace(t, { gain_db: 15.13 }), expected).trap, "lossless_network");
	assert.deepEqual(score(workspace(t, undefined), expected).errors, ["answer.json not found"]);
	assert.match(score(workspace(t, "{"), expected).errors[0], /not valid JSON/);
});
