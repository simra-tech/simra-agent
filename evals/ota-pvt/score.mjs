// Score an answer to the ota-pvt task (task.md) against expected.json.
//
// Claim: meets_spec is the same as the reference (4 points).
// Verdicts: for each corner and requirement, "pass" is the same as the reference (9 points).
// Values: for each corner and requirement, the value is within the tolerance of the reference (9 points).
//
// Diagnostics (no points):
// - supported: the reported value appears in a file of the workspace other than answer.json.
// - traps: the value is the value of the team testbench as it is (the spec conditions are not applied,
//   or the phase is in radians), and not the reference value.
//
// Usage: node evals/ota-pvt/score.mjs <workspace>   (prints the score as JSON)

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { numbersIn, readTexts, shown, within } from "../ota-corners/score.mjs";

const here = new URL(".", import.meta.url).pathname;
const METRICS = ["gain_db", "ugf_hz", "pm_deg"];

export function score(ws, expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"))) {
	const report = { workspace: ws, claim: 0, verdicts: 0, values: 0, max: { claim: 4, verdicts: 9, values: 9 }, meets_spec: null, rows: {}, supported: 0, traps: [], errors: [] };
	const answerPath = join(ws, "answer.json");
	if (!existsSync(answerPath)) {
		report.errors.push("answer.json not found");
		return report;
	}
	let answer;
	try {
		answer = JSON.parse(readFileSync(answerPath, "utf8"));
	} catch (err) {
		report.errors.push(`answer.json is not valid JSON: ${err.message}`);
		return report;
	}

	report.meets_spec = typeof answer.meets_spec === "boolean" ? answer.meets_spec : null;
	if (report.meets_spec === expected.meets_spec) report.claim = 4;

	// Numbers in the workspace files other than answer.json and the task files.
	const evidence = numbersIn(
		readTexts(ws)
			.filter((f) => relative(ws, f.path) !== "answer.json")
			.map((f) => f.text)
			.join("\n"),
	);
	const rows = Array.isArray(answer.rows) ? answer.rows : [];
	for (const [corner, ref] of Object.entries(expected.corners)) {
		for (const m of METRICS) {
			const key = `${corner} ${m}`;
			const r = rows.find((x) => x?.corner === corner && x?.requirement === m);
			const s = { found: Boolean(r), verdict: false, value: false, supported: false };
			report.rows[key] = s;
			if (!r) continue;
			s.verdict = r.pass === ref.pass[m];
			s.value = within(r.value, ref.values[m], expected.tolerance[m]);
			s.supported = shown(evidence, m, r.value);
			const team = ref.team_testbench.values[m];
			if (!s.value && within(r.value, team, expected.tolerance[m])) report.traps.push(key);
			report.verdicts += Number(s.verdict);
			report.values += Number(s.value);
			report.supported += Number(s.supported);
		}
	}
	return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (!process.argv[2]) {
		console.error("usage: node evals/ota-pvt/score.mjs <workspace>");
		process.exit(2);
	}
	console.log(JSON.stringify(score(resolve(process.argv[2])), null, 2));
}
