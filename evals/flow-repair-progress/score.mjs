// Score an answer to the flow-repair-progress task (task.md) against expected.json.
//
// Parts:
// - cause: the name of the cause is the reference (the repair made one pass for each violating end point).
// - shown: repair_can_close is true, and a log in the workspace has a hold repair table whose last row has no
//   negative slack (the run that shows it). The log of the run of record does not count.
// - number: hold_ws_ns is near the worst slack of the last row of such a log.
// pass: cause and shown have full points.
//
// Usage: node evals/flow-repair-progress/score.mjs <workspace>   (prints the score as JSON)

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emptyReport, holdRepairLogs, near, norm, readAnswer } from "../flow-score.mjs";

const here = new URL(".", import.meta.url).pathname;

export function score(ws, expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"))) {
	const max = { cause: 4, shown: 5, number: 3 };
	const report = { ...emptyReport(ws, max), cause_given: null, closing_logs: [] };
	const { answer, error } = readAnswer(ws);
	if (!answer) {
		report.errors.push(error);
		return report;
	}
	report.cause_given = norm(answer.cause);
	if (report.cause_given === expected.cause) report.cause = max.cause;
	const closing = holdRepairLogs(ws).filter((l) => l.errors === 0 && l.wns >= 0 && l.tns === 0 && l.endpoints >= expected.min_endpoints);
	report.closing_logs = closing.map((l) => l.path).slice(0, 5);
	if (answer.repair_can_close === true && closing.length) report.shown = max.shown;
	if (closing.some((l) => near(answer.hold_ws_ns, l.wns, expected.tol_ns))) report.number = max.number;
	report.pass = report.cause === max.cause && report.shown === max.shown;
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(here, "score.mjs")) {
	console.log(JSON.stringify(score(resolve(process.argv[2] ?? ".")), null, 2));
}
