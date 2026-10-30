// Score an answer to the ota-saturation task (task.md) against expected.json.
//
// Claim: meets_spec is the same as the reference (4 points).
// Verdicts: for each corner and requirement, "pass" is the same as the reference (9 points).
// Values: for each corner and requirement, the worst value over the input range is within the tolerance of the
// reference (9 points).
//
// Diagnostics (no points):
// - supported: the reported value appears in a file of the workspace other than answer.json.
// - vcm: the rows whose VCM is within 0.05 V of the VCM where the reference worst value occurs.
// - traps: the rows whose wrong value is the value at VCM = VDD / 2 (the team testbench): team_testbench.
// - claim_of: the variants whose claim is the same as the answer's claim.
//
// Usage: node evals/ota-saturation/score.mjs <workspace>   (prints the score as JSON)

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { numbersIn, readTexts, shown, within } from "../ota-corners/score.mjs";

const here = new URL(".", import.meta.url).pathname;
const METRICS = ["gain_db", "ugf_hz", "pm_deg"];
const VARIANTS = ["team_testbench"];
const VCM_TOLERANCE = 0.05;

export function score(ws, expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"))) {
	const report = { workspace: ws, claim: 0, verdicts: 0, values: 0, max: { claim: 4, verdicts: 9, values: 9 }, meets_spec: null, claim_of: [], rows: {}, supported: 0, vcm: 0, traps: {}, errors: [] };
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
	if (report.meets_spec !== null) report.claim_of = VARIANTS.filter((v) => expected.variant_meets_spec[v] === report.meets_spec);

	// Numbers in the workspace files other than answer.json.
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
			const s = { found: Boolean(r), verdict: false, value: false, vcm: false, supported: false };
			report.rows[key] = s;
			if (!r) continue;
			s.verdict = r.pass === ref.pass[m];
			s.value = within(r.value, ref.values[m], expected.tolerance[m]);
			s.vcm = typeof r.vcm === "number" && Math.abs(r.vcm - ref.vcm[m]) <= VCM_TOLERANCE;
			s.supported = shown(evidence, m, r.value);
			if (!s.value) {
				const from = VARIANTS.filter((v) => within(r.value, ref[v].values[m], expected.tolerance[m]));
				if (from.length) report.traps[key] = from;
			}
			report.verdicts += Number(s.verdict);
			report.values += Number(s.value);
			report.vcm += Number(s.vcm);
			report.supported += Number(s.supported);
		}
	}
	return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (!process.argv[2]) {
		console.error("usage: node evals/ota-saturation/score.mjs <workspace>");
		process.exit(2);
	}
	console.log(JSON.stringify(score(resolve(process.argv[2])), null, 2));
}
