// Score an answer to the flow-setting-effect task (task.md) against expected.json.
//
// The seeded variant: the flow accepts the setting and its result does not change (the same netlist after the clock
// tree synthesis, to the last digit). The old run in the workspace (runs/base) is from an earlier revision of the RTL,
// so its numbers differ from the new run for another reason. The control variant: the setting changes the clock tree.
//
// Parts:
// - effect (6): setting_changed_result agrees with the reference.
// - before (3): the three "before" values are those of a run without the setting on the current RTL.
// - after (3): the three "after" values are those of the run with the setting.
// pass: setting_changed_result agrees with the reference.
// Diagnostics: old_run_as_before (the "before" values are those of runs/base, the run of the earlier RTL).
//
// Usage: node evals/flow-setting-effect/score.mjs <workspace>   (prints the score as JSON)

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emptyReport, near, readAnswer } from "../flow-score.mjs";

const here = new URL(".", import.meta.url).pathname;

/** True when row has the three values of ref within the tolerances. */
function rowIs(row, ref, tol) {
	return !!row && row.clock_buffers === ref.clock_buffers && near(row.hold_ws_ns, ref.hold_ws_ns, tol.hold_ws_ns) && near(row.setup_ws_ns, ref.setup_ws_ns, tol.setup_ws_ns);
}

export function score(ws, expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8"))) {
	const max = { effect: 6, before: 3, after: 3 };
	const report = { ...emptyReport(ws, max), old_run_as_before: false, answer: null };
	const { answer, error } = readAnswer(ws);
	if (!answer) {
		report.errors.push(error);
		return report;
	}
	const changed = answer.setting_changed_result;
	report.answer = { setting_changed_result: changed ?? null, before: answer.before ?? null, after: answer.after ?? null };
	if (typeof changed !== "boolean") report.errors.push("setting_changed_result must be true or false");
	if (changed === expected.setting_changed_result) report.effect = 6;
	if (rowIs(answer.before, expected.before, expected.tol)) report.before = 3;
	if (rowIs(answer.after, expected.after, expected.tol)) report.after = 3;
	report.old_run_as_before = rowIs(answer.before, expected.old_run, expected.tol);
	report.pass = changed === expected.setting_changed_result;
	return report;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(score(resolve(process.argv[2] ?? ".")), null, 2));
