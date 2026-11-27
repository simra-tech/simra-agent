// Timing step check: did a shell command that ran a timing step leave a timing result behind? A timing tool that
// cannot read or link its design prints an error and no slack; a script that does not check the exit code of the tool
// ends with exit code 0. The check reads the files that changed during the command. It runs no tool.
//
// A finding means: the command wrote the log of a timing step, and no file that the command wrote has a slack line of
// this run (a complete slack line of a path report, or a wns, tns or worst slack line). Such a step is "not run". The openroad adapter (operation timing) makes the record of one log.

import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";
import { errorLines, filesChangedSince } from "./commandcheck.ts";

export interface TimingStepFinding {
	/** The logs of the timing step, relative to the directory of the command. */
	logs: string[];
	/** The first error line of these logs, or null. */
	problem: { path: string; line: number; text: string } | null;
	/** true: a log has slack lines of an older run, before the part that this command wrote. */
	stale?: boolean;
}

const TEXT_FILE = /\.(log|out|txt|rpt|err)$/i;
/** A file name of a timing step: sta.log, opensta.out, timing.rpt, pre_place_timing.log. */
const TIMING_NAME = /(^|[^a-z])(sta|opensta|timing)([^a-z]|$)/i;
/** A command, a banner or a link error of a timing tool in the text. */
const TIMING_TEXT = /\b(report_checks|report_wns|report_tns|report_worst_slack|link_design|read_sdc|create_clock)\b|\bOpenSTA\b|is not a verilog module|no network has been linked/;
const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
/**
 * A timing result: a complete slack line of a path report, or a complete line of report_wns, report_tns or
 * report_worst_slack. A 'Startpoint:' line alone is not a result: a path report without its slack line is not complete.
 * The openroad adapter (openroad_log.py) uses the same two line forms.
 */
const TIMING_RESULT = new RegExp(String.raw`^\s*${NUMBER}\s+slack \((?:MET|VIOLATED)\)\s*$|^\s*(?:wns|tns|worst slack)\s+(?:(?:max|min)\s+)?${NUMBER}\s*$`, "m");
const NO_DESIGN = /syntax error|is not a verilog module|no network has been linked/i;
const FLOW_STEP_DIR = /(^|\/)runs\/[^/]+\/\d+-[^/]+\//;
const MAX_BYTES = 4 * 1024 * 1024;

/** true when the text has a timing result (a complete slack line, or a wns, tns or worst slack line). */
export function hasTimingResult(text: string): boolean {
	return TIMING_RESULT.test(text);
}

/**
 * true when the last run in the text has a timing result: the text has a result line, and no line after the last
 * result line says that the tool had no design (a log that a script appends to can have the slack of an older run).
 */
function lastRunHasResult(lines: string[]): boolean {
	let last = -1;
	for (let k = lines.length - 1; k >= 0 && last < 0; k--) if (TIMING_RESULT.test(lines[k])) last = k;
	return last >= 0 && !lines.slice(last + 1).some((l) => NO_DESIGN.test(l));
}

const checked = (path: string) => TEXT_FILE.test(path) && !FLOW_STEP_DIR.test(path);

/**
 * The sizes of the text files of root, for a call before a command. timingStepFinding then reads only the part
 * that the command appended to a file.
 */
export function timingLogSizes(root: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const file of filesChangedSince(root, 0)) if (checked(relative(root, file.path))) out.set(file.path, file.size);
	return out;
}

/**
 * The finding for a command that started at sinceMs in root and ended with exit code 0, or null: null when the command
 * wrote no log of a timing step, or when a file that it wrote has a timing result of this command. `before` has the
 * file sizes from before the command (timingLogSizes): for a file that grew, only the new part counts.
 */
export function timingStepFinding(root: string, sinceMs: number, before?: Map<string, number>): TimingStepFinding | null {
	const logs: string[] = [];
	let problem: TimingStepFinding["problem"] = null;
	let stale = false;
	for (const file of filesChangedSince(root, sinceMs)) {
		const path = relative(root, file.path);
		// The step directories of a LibreLane run are read by the librelane adapter (operation read), not here.
		if (!checked(path) || file.size > MAX_BYTES) continue;
		let data: Buffer;
		try {
			data = readFileSync(file.path);
		} catch {
			continue;
		}
		if (data.includes(0)) continue;
		const old = before?.get(file.path) ?? 0;
		const appended = old > 0 && data.length > old;
		const whole = data.toString("utf8");
		const head = appended ? data.subarray(0, old).toString("utf8") : "";
		const text = appended ? data.subarray(old).toString("utf8") : whole;
		const lines = text.split("\n");
		if (lastRunHasResult(lines)) return null;
		if (!TIMING_NAME.test(basename(path)) && !TIMING_TEXT.test(whole)) continue;
		logs.push(path);
		if (hasTimingResult(whole)) stale = true;
		if (!problem) {
			let last = -1;
			for (let k = lines.length - 1; k >= 0 && last < 0; k--) if (TIMING_RESULT.test(lines[k])) last = k;
			const tail = lines.slice(last + 1);
			const at = tail.findIndex((l) => NO_DESIGN.test(l));
			const first = at >= 0 ? { line: at + 1, text: tail[at].trim().slice(0, 200) } : errorLines(tail.join("\n"))[0];
			const offset = last + 1 + (head ? head.split("\n").length - 1 : 0);
			if (first) problem = { path, line: first.line + offset, text: first.text };
		}
	}
	return logs.length ? { logs: logs.sort(), problem, ...(stale ? { stale: true } : {}) } : null;
}

/** The note for the agent. */
export function formatTimingStepFinding(f: TimingStepFinding): string {
	const rows = ["", `Simra timing check: not run. The command ended with exit code 0 and wrote the log of a timing step (${f.logs.slice(0, 4).join(", ")}), but no file that it wrote has a slack line of this run.`];
	if (f.problem) rows.push(`- ${f.problem.path}:${f.problem.line}: ${f.problem.text}`);
	if (f.stale) rows.push("- The slack lines in the log are from an older run: the last run in the log has none.");
	rows.push("Record this timing step as not run, not as passed. Timing reports in the tree are from an earlier run. Find why the tool had no design (the netlist that it read, the name of the top module), run the step again, and check that the new log has slack lines. The openroad adapter, operation timing, makes the record of a timing log.");
	return rows.join("\n");
}
