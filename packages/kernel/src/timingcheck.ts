// Timing step check: did a shell command that ran a timing step leave a timing result behind? A timing tool that
// cannot read or link its design prints an error and no slack; a script that does not check the exit code of the tool
// ends with exit code 0. The check reads the files that changed during the command. It runs no tool.
//
// A finding means: the command wrote the log of a timing step, and no file that the command wrote has a slack line or
// a path report. Such a step is "not run". The openroad adapter (operation timing) makes the record of one log.

import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { errorLines, filesChangedSince } from "./commandcheck.ts";

export interface TimingStepFinding {
	/** The logs of the timing step, relative to the directory of the command. */
	logs: string[];
	/** The first error line of these logs, or null. */
	problem: { path: string; line: number; text: string } | null;
}

const TEXT_FILE = /\.(log|out|txt|rpt|err)$/i;
/** A file name of a timing step: sta.log, opensta.out, timing.rpt, pre_place_timing.log. */
const TIMING_NAME = /(^|[^a-z])(sta|opensta|timing)([^a-z]|$)/i;
/** A command, a banner or a link error of a timing tool in the text. */
const TIMING_TEXT = /\b(report_checks|report_wns|report_tns|report_worst_slack|link_design|read_sdc|create_clock)\b|\bOpenSTA\b|is not a verilog module|no network has been linked/;
/** A timing result: a slack line of a path report, a path report, or a line of report_wns, report_tns or report_worst_slack. */
const TIMING_RESULT = /^\s*[-+]?\d+(\.\d+)?\s+slack \((MET|VIOLATED)\)|^Startpoint:|^\s*(wns|tns|worst slack)\s+((max|min)\s+)?[-+]?\d/m;
const NO_DESIGN = /syntax error|is not a verilog module|no network has been linked/i;
const FLOW_STEP_DIR = /(^|\/)runs\/[^/]+\/\d+-[^/]+\//;
const MAX_BYTES = 4 * 1024 * 1024;

/** true when the text has a timing result (a slack line, a path report, or a wns, tns or worst slack line). */
export function hasTimingResult(text: string): boolean {
	return TIMING_RESULT.test(text);
}

/**
 * The finding for a command that started at sinceMs in root and ended with exit code 0, or null: null when the command
 * wrote no log of a timing step, or when a file that it wrote has a timing result.
 */
export function timingStepFinding(root: string, sinceMs: number): TimingStepFinding | null {
	const logs: string[] = [];
	let problem: TimingStepFinding["problem"] = null;
	for (const file of filesChangedSince(root, sinceMs)) {
		const path = relative(root, file.path);
		// The step directories of a LibreLane run are read by the librelane adapter (operation read), not here.
		if (!TEXT_FILE.test(path) || file.size > MAX_BYTES || FLOW_STEP_DIR.test(path)) continue;
		let text = "";
		try {
			text = readFileSync(file.path, "utf8");
		} catch {
			continue;
		}
		if (text.includes("\0")) continue;
		if (hasTimingResult(text)) return null;
		if (!TIMING_NAME.test(basename(path)) && !TIMING_TEXT.test(text)) continue;
		logs.push(path);
		if (!problem) {
			const lines = text.split("\n");
			const at = lines.findIndex((l) => NO_DESIGN.test(l));
			const first = at >= 0 ? { line: at + 1, text: lines[at].trim().slice(0, 200) } : errorLines(text)[0];
			if (first) problem = { path, line: first.line, text: first.text };
		}
	}
	return logs.length ? { logs: logs.sort(), problem } : null;
}

/** The note for the agent. */
export function formatTimingStepFinding(f: TimingStepFinding): string {
	const rows = ["", `Simra timing check: not run. The command ended with exit code 0 and wrote the log of a timing step (${f.logs.slice(0, 4).join(", ")}), but no file that it wrote has a slack line or a path report.`];
	if (f.problem) rows.push(`- ${f.problem.path}:${f.problem.line}: ${f.problem.text}`);
	rows.push("Record this timing step as not run, not as passed. Timing reports in the tree are from an earlier run. Find why the tool had no design (the netlist that it read, the name of the top module), run the step again, and check that the new log has slack lines. The openroad adapter, operation timing, makes the record of a timing log.");
	return rows.join("\n");
}
