// Score an answer to the em-line-s21 task (task.md) against expected.json.
//
// Magnitude: s21_db within the tolerance of the reference (2 points). Phase: s21_deg within the tolerance, modulo
// 360 degrees (2 points).
// Diagnostics (no points):
// - supported: both reported values appear in a file of the workspace other than answer.json.
// - trap: the trap whose magnitude and phase are both within the tolerance of the answer, when the answer misses a
//   point: oxide_tem (an ideal TEM line in SiO2: 0 dB, a phase near the reference).
// - frequency: f_hz of the answer is 60 GHz.
//
// Usage: node evals/em-line-s21/score.mjs <workspace>   (prints the score as JSON)

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { numbersIn, readTexts } from "../ota-corners/score.mjs";

const here = new URL(".", import.meta.url).pathname;

/** The difference a - b in degrees, from -180 to 180. */
export function degDiff(a, b) {
	return ((((a - b + 180) % 360) + 360) % 360) - 180;
}

export function score(ws, expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"))) {
	const report = { workspace: ws, magnitude: 0, phase: 0, max: { magnitude: 2, phase: 2 }, value: null, supported: false, trap: null, frequency: null, errors: [] };
	const path = join(ws, "answer.json");
	if (!existsSync(path)) {
		report.errors.push("answer.json not found");
		return report;
	}
	let answer;
	try {
		answer = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		report.errors.push(`answer.json is not valid JSON: ${err.message}`);
		return report;
	}
	const db = typeof answer.s21_db === "number" ? answer.s21_db : null;
	const deg = typeof answer.s21_deg === "number" ? answer.s21_deg : null;
	report.value = { s21_db: db, s21_deg: deg };
	if (db === null) report.errors.push("s21_db is not a number");
	if (deg === null) report.errors.push("s21_deg is not a number");
	if (db !== null && Math.abs(db - expected.s21_db) <= expected.tolerance.s21_db.abs) report.magnitude = 2;
	if (deg !== null && Math.abs(degDiff(deg, expected.s21_deg)) <= expected.tolerance.s21_deg.abs) report.phase = 2;
	report.frequency = typeof answer.f_hz === "number" ? Math.abs(answer.f_hz - expected.f_hz) < 1 : null;
	if ((!report.phase || !report.magnitude) && db !== null && deg !== null) {
		for (const [name, trap] of Object.entries(expected.traps)) {
			const nearDb = Math.abs(db - trap.s21_db) <= expected.tolerance.s21_db.abs;
			if (nearDb && Math.abs(degDiff(deg, trap.s21_deg)) <= expected.tolerance.s21_deg.abs) report.trap = name;
		}
	}
	const numbers = readTexts(ws).filter((f) => resolve(f.path) !== resolve(path)).flatMap((f) => numbersIn(f.text));
	const near = (v) => v !== null && numbers.some((n) => Math.abs(n - v) <= 1e-3 * Math.max(1, Math.abs(v)) + 0.005);
	report.supported = near(db) && near(deg);
	return report;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(score(resolve(process.argv[2] ?? ".")), null, 2));
