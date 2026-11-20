// Command check: what a shell command that ended with exit code 0 left behind. It reads the files that changed during
// the command and reports two facts that an exit code does not show: a log with error lines, and an empty result file.
// It reads files only; it knows no tool.

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface CommandFinding {
	kind: "error_lines" | "empty_file";
	/** The file, relative to the directory of the command. */
	path: string;
	/** For error_lines: the first lines with an error (at most 3, each at most 200 characters), with line numbers. */
	lines?: string[];
	/** For error_lines: the number of lines with an error. */
	count?: number;
}

const SKIP_DIRS = new Set([".git", "node_modules", "simra", "__pycache__", ".venv", "tmp"]);
const LOG_FILE = /\.(log|out|txt|rpt|err)$/i;
// A log, a report or an error file can be empty in a good run; these kinds cannot.
const RESULT_FILE = /\.(txt|csv|json|v|sv|vcd|raw|sdf|spef|def|gds|lib|dat|prn)$/i;
const ERROR_LINE =
	/^\s*(\[(ERROR|CRITICAL|FATAL)\b|(ERROR|Error|FATAL|Fatal)\b\s*[:\]-]|%Error)|\bsyntax error\b|\bUnable to open\b|\b[Cc]annot open\b|\bNo such file or directory\b|^Traceback \(most recent call last\)|\bSegmentation fault\b|\bcommand not found\b|\bcore dumped\b/;
const NOT_AN_ERROR = /\b(0|no|zero)\s+(errors?|failures?)\b|\berrors?\s*[:=]\s*0\b|\berror(s)?\s+(count|clear)\b|\bclear\.$/i;
const MAX_FILES = 6000;
const MAX_DEPTH = 6;
const MAX_LOG_BYTES = 4 * 1024 * 1024;

/** The files under root that changed at or after sinceMs (at most MAX_FILES entries are visited, MAX_DEPTH levels). */
export function filesChangedSince(root: string, sinceMs: number): { path: string; size: number }[] {
	const out: { path: string; size: number }[] = [];
	let visited = 0;
	const walk = (dir: string, depth: number): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (++visited > MAX_FILES) return;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) walk(path, depth + 1);
			} else if (entry.isFile()) {
				try {
					const st = statSync(path);
					if (st.mtimeMs >= sinceMs) out.push({ path, size: st.size });
				} catch {
					// the file went away
				}
			}
		}
	};
	walk(root, 0);
	return out;
}

/** The error lines of a log text: lines that state an error, without the lines that state a count of zero. */
export function errorLines(text: string): { line: number; text: string }[] {
	const out: { line: number; text: string }[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.length > 2000 || !ERROR_LINE.test(line) || NOT_AN_ERROR.test(line)) continue;
		out.push({ line: i + 1, text: line.trim().slice(0, 200) });
	}
	return out;
}

/**
 * The findings for a command that started at sinceMs in root and ended with exit code 0: each changed log with error
 * lines, and each changed result file that is empty. An empty list means that the check found nothing.
 */
export function commandFindings(root: string, sinceMs: number): CommandFinding[] {
	const findings: CommandFinding[] = [];
	for (const file of filesChangedSince(root, sinceMs)) {
		const path = relative(root, file.path);
		if (file.size === 0) {
			if (RESULT_FILE.test(path)) findings.push({ kind: "empty_file", path });
			continue;
		}
		if (!LOG_FILE.test(path) || file.size > MAX_LOG_BYTES) continue;
		let text: string;
		try {
			text = readFileSync(file.path, "utf8");
		} catch {
			continue;
		}
		if (text.includes("\0")) continue;
		const found = errorLines(text);
		if (found.length) findings.push({ kind: "error_lines", path, count: found.length, lines: found.slice(0, 3).map((l) => `${l.line}: ${l.text}`) });
	}
	return findings.sort((a, b) => a.path.localeCompare(b.path));
}

/** The note for the agent, or null when there is no finding. */
export function formatCommandFindings(findings: CommandFinding[]): string | null {
	if (findings.length === 0) return null;
	const rows: string[] = ["", "Simra command check: the command ended with exit code 0, but the files that it wrote show a problem."];
	for (const f of findings.slice(0, 6)) {
		if (f.kind === "empty_file") rows.push(`- ${f.path} is empty (0 bytes).`);
		else rows.push(`- ${f.path} has ${f.count} error line${f.count === 1 ? "" : "s"}: ${(f.lines ?? []).join(" | ")}`);
	}
	if (findings.length > 6) rows.push(`- and ${findings.length - 6} more files.`);
	rows.push("A printed result or an exit code 0 is not a result when a step before it failed or wrote nothing. Find out which step did not do its work, and whether the printed result comes from this run or from old files, before you use it.");
	return rows.join("\n");
}
