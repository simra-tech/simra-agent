// Score an answer to the flow-step-replay task (task.md) against expected.json.
//
// Parts:
// - cause: the name of the cause is the reference (the maximum buffer count of the hold repair).
// - shown: step_ends is true, and a log in the workspace has a hold repair table of the block (the same number of
//   violating end points at the start as the run of record) that ends without an error line. The log of the run of
//   record does not count: it has an error.
// - number: hold_buffers and hold_ws_ns agree with the last row of such a log.
// pass: all three parts have full points.
//
// Usage: node evals/flow-step-replay/score.mjs <workspace>   (prints the score as JSON)

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emptyReport, holdRepairLogs, near, norm, readAnswer } from "../flow-score.mjs";

const here = new URL(".", import.meta.url).pathname;

export function score(ws, expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"))) {
	const max = { cause: 3, shown: 5, number: 4 };
	const report = { ...emptyReport(ws, max), cause_given: null, good_logs: [] };
	const { answer, error } = readAnswer(ws);
	if (!answer) {
		report.errors.push(error);
		return report;
	}
	report.cause_given = norm(answer.cause);
	if (report.cause_given === expected.cause) report.cause = max.cause;
	const good = holdRepairLogs(ws).filter((l) => l.errors === 0 && l.endpoints === expected.endpoints && l.buffers > expected.buffers_of_record);
	report.good_logs = good.map((l) => l.path).slice(0, 5);
	if (answer.step_ends === true && good.length) report.shown = max.shown;
	if (good.some((l) => near(answer.hold_buffers, l.buffers, expected.tol_buffers) && near(answer.hold_ws_ns, l.wns, expected.tol_ns))) report.number = max.number;
	report.pass = report.cause === max.cause && report.shown === max.shown && report.number === max.number;
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(here, "score.mjs")) {
	console.log(JSON.stringify(score(resolve(process.argv[2] ?? ".")), null, 2));
}
