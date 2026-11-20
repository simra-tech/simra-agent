// Shared parts of the scorers of the digital flow tasks (evals/flow-*).
//
// Each scorer gives points for the parts of its task and the field "pass": the pass condition of the task as one
// boolean, for counts of passes over runs.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** answer.json of the workspace: { answer } or { error }. */
export function readAnswer(ws) {
	const path = join(ws, "answer.json");
	if (!existsSync(path)) return { answer: null, error: "answer.json not found" };
	try {
		const answer = JSON.parse(readFileSync(path, "utf8"));
		if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return { answer: null, error: "answer.json is not an object" };
		return { answer, error: null };
	} catch (err) {
		return { answer: null, error: `answer.json is not valid JSON: ${err.message}` };
	}
}

/** True when value is a number within tol of ref. */
export const near = (value, ref, tol) => typeof value === "number" && Number.isFinite(value) && Math.abs(value - ref) <= tol;

/** The name of the reference in table (name -> { value, tol }) that value is near, or null. */
export function nearestOf(value, table) {
	for (const [name, r] of Object.entries(table ?? {})) if (near(value, r.value, r.tol)) return name;
	return null;
}

/** A status string in lower case with "_" for blanks and "-": "Not run" -> "not_run". */
export const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase().replace(/[\s-]+/g, "_") : null);

/** The files under dir (relative paths), at most limit, without .git and node_modules. */
export function filesUnder(dir, limit = 20000) {
	const out = [];
	const walk = (rel) => {
		if (out.length >= limit) return;
		let entries;
		try {
			entries = readdirSync(join(dir, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === ".git" || e.name === "node_modules") continue;
			const p = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(p);
			else if (out.length < limit) out.push(p);
		}
	};
	walk("");
	return out;
}

/** The text of a file in the workspace, or null (missing, a directory, or larger than maxBytes). */
export function textOf(ws, rel, maxBytes = 8_000_000) {
	if (typeof rel !== "string" || !rel) return null;
	const path = join(ws, rel);
	try {
		const st = statSync(path);
		if (!st.isFile() || st.size > maxBytes) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** An empty report for a scorer: the workspace, zero points for each part of max, pass false, and no errors. */
export function emptyReport(ws, max) {
	return { workspace: ws, ...Object.fromEntries(Object.keys(max).map((k) => [k, 0])), max, pass: false, errors: [] };
}

/**
 * The hold repair tables (repair_timing -hold of OpenROAD) in the text files of the workspace: one entry for each
 * file with a table: { path, endpoints, buffers, wns, tns, errors }. endpoints is the number of end points with hold
 * violations at the start (the largest one of the rounds in the file); buffers, wns and tns are from the row "final" of the last table; errors is the number of
 * [ERROR lines. Files larger than 30 MB and directories named tmp are not read.
 */
export function holdRepairLogs(ws) {
	const out = [];
	for (const rel of filesUnder(ws, 60000)) {
		if (!/\.(log|out|txt|rpt)$/i.test(rel) || /(^|\/)tmp\//.test(rel)) continue;
		const text = textOf(ws, rel, 30_000_000);
		if (!text || !text.includes("endpoints with hold violations")) continue;
		const finals = [...text.matchAll(/^\s*final\s*\|(.*)$/gm)];
		if (finals.length === 0) continue;
		// The header of the repair table: other tables of the log (for example of the placement) have no WNS column.
		const header = (text.match(/^\s*Iter(?:ation)?\s*\|.*$/gm) ?? []).filter((h) => /\bWNS\b/.test(h)).pop() ?? "";
		const names = header.split("|").map((c) => c.trim().toLowerCase());
		const cells = `final|${finals[finals.length - 1][1]}`.split("|").map((c) => c.trim());
		const cell = (name) => {
			const i = names.indexOf(name);
			return i >= 0 ? Number.parseFloat(cells[i]) : Number.NaN;
		};
		// A log can have several repair rounds: the block is the one with the largest number of end points at a start.
		const found = [...text.matchAll(/Found (\d+) endpoints with hold violations/g)].map((m) => Number(m[1]));
		out.push({ path: rel, endpoints: found.length ? Math.max(...found) : null, buffers: cell("buffers"), wns: cell("wns"), tns: cell("tns"), errors: (text.match(/^\[ERROR/gm) ?? []).length });
	}
	return out;
}
