// The em-line-s21 eval: the task layout is the line fixture generator output (600 um), expected.json holds a converged
// reference with distinct traps, and the scorer gives the points to the reference values and names the traps.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { oxideTemDeg } from "../evals/em-line-s21/reference.mjs";
import { degDiff, score } from "../evals/em-line-s21/score.mjs";

const here = new URL("../evals/em-line-s21/", import.meta.url).pathname;
const expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"));

function workspace(t, answer, files = {}) {
	const ws = mkdtempSync(join(tmpdir(), "simra-emline-score-"));
	t.after(() => rmSync(ws, { recursive: true, force: true }));
	if (answer !== undefined) writeFileSync(join(ws, "answer.json"), typeof answer === "string" ? answer : JSON.stringify(answer));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(ws, name), text);
	return ws;
}

test("em-line-s21: expected.json has the reference at 60 GHz and traps away from it", () => {
	assert.equal(expected.f_hz, 60e9);
	assert.ok(expected.s21_db < 0 && expected.s21_db > -3, `s21_db ${expected.s21_db}`);
	assert.equal(expected.traps.oxide_tem.s21_deg, oxideTemDeg());
	// a trap differs from the reference by more than twice the tolerance in magnitude or in phase
	for (const trap of Object.values(expected.traps)) {
		const farDb = Math.abs(trap.s21_db - expected.s21_db) > 2 * expected.tolerance.s21_db.abs;
		const farDeg = Math.abs(degDiff(trap.s21_deg, expected.s21_deg)) > 2 * expected.tolerance.s21_deg.abs;
		assert.ok(farDb || farDeg);
	}
});

test("em-line-s21: degDiff wraps at 180 degrees", () => {
	assert.equal(degDiff(179, -179), -2);
	assert.equal(degDiff(-179, 179), 2);
	assert.equal(degDiff(10, 10), 0);
});

test("em-line-s21: the scorer gives the points to the reference values and names the traps", (t) => {
	const good = { s21_db: expected.s21_db + 0.01, s21_deg: expected.s21_deg + 1, f_hz: 60e9, evidence: "run" };
	const g = score(workspace(t, good, { "log.txt": `S21 ${good.s21_db} dB ${good.s21_deg} deg` }), expected);
	assert.deepEqual([g.magnitude, g.phase, g.supported, g.frequency, g.trap], [2, 2, true, true, null]);
	const trap = score(workspace(t, { s21_db: 0, s21_deg: expected.traps.oxide_tem.s21_deg, f_hz: 60e9 }), expected);
	assert.deepEqual([trap.magnitude, trap.trap], [0, "oxide_tem"]);
	assert.equal(score(workspace(t, undefined), expected).errors[0], "answer.json not found");
	assert.match(score(workspace(t, "{"), expected).errors[0], /not valid JSON/);
});
