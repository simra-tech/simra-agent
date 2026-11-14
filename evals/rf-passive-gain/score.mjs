// Score an answer to the rf-passive-gain task (task.md) against expected.json.
//
// Gain: gain_db is within the tolerance of the reference (4 points).
// Diagnostics (no points):
// - supported: the reported value appears in a file of the workspace other than answer.json.
// - trap: the trap whose value is within the tolerance of the answer: without_network (the amplifier into 50 ohm,
//   without the network) or lossless_network (the network with R = 0).
// - frequency: f0_hz of the answer is 10 GHz.
//
// Usage: node evals/rf-passive-gain/score.mjs <workspace>   (prints the score as JSON)

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { numbersIn, readTexts, within } from "../ota-corners/score.mjs";

const here = new URL(".", import.meta.url).pathname;

export function score(ws, expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"))) {
	const report = { workspace: ws, gain: 0, max: { gain: 4 }, value: null, supported: false, trap: null, frequency: null, errors: [] };
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
	report.value = typeof answer.gain_db === "number" ? answer.gain_db : null;
	if (report.value === null) report.errors.push("gain_db is not a number");
	if (within(report.value, expected.gain_db, expected.tolerance.gain_db)) report.gain = 4;
	report.frequency = typeof answer.f0_hz === "number" ? Math.abs(answer.f0_hz - expected.f0_hz) < 1 : null;
	for (const [name, value] of Object.entries(expected.traps)) {
		if (!report.gain && within(report.value, value, expected.tolerance.gain_db)) report.trap = name;
	}
	const numbers = readTexts(ws).filter((f) => resolve(f.path) !== resolve(path)).flatMap((f) => numbersIn(f.text));
	report.supported = report.value !== null && numbers.some((n) => Math.abs(n - report.value) <= 1e-3 * Math.max(1, Math.abs(report.value)));
	return report;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(score(resolve(process.argv[2] ?? ".")), null, 2));
