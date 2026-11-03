// The design record: for each file of record (an input file of an experiment, in the design root), its current hash
// and the experiments that used it. An experiment is current for a file when the hash that it recorded equals the
// current hash of the file, else it is stale. The record is read from the experiment records only; it runs no tool.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { type ExperimentRecord, type FileHash, listExperiments, type ResultRecord } from "./records.ts";
import { sha256File } from "./runner.ts";

/** The roles of input files that are not files of record: the tool's deck, the technology pack, the model files. */
export const NOT_OF_RECORD = new Set(["deck", "technology", "model"]);

/** A file of record: an input file in the design root, with a role that is not in NOT_OF_RECORD. */
export function ofRecord(f: FileHash): boolean {
	return !NOT_OF_RECORD.has(f.role ?? "") && !isAbsolute(f.path) && !normalize(f.path).startsWith("..");
}

/** The current sha256 of a file relative to the design root, or "missing". */
export function currentHash(root: string, path: string, cache?: Map<string, string>): string {
	const cached = cache?.get(path);
	if (cached) return cached;
	const full = join(root, path);
	let hash = "missing";
	try {
		if (statSync(full).isFile()) hash = sha256File(full);
	} catch {}
	cache?.set(path, hash);
	return hash;
}

export interface StaleInput {
	path: string;
	role: string | null;
	/** The sha256 that the experiment recorded. */
	recorded: string;
	/** The current sha256, or "missing". */
	current: string;
}

/** The files of record of one experiment whose current sha256 differs from the recorded one. */
export function staleInputs(root: string, _experiment: ExperimentRecord, result: ResultRecord, cache?: Map<string, string>): StaleInput[] {
	const out: StaleInput[] = [];
	for (const f of result.input_files?.files ?? []) {
		if (!ofRecord(f)) continue;
		const current = currentHash(root, f.path, cache);
		if (current !== f.sha256) out.push({ path: f.path, role: f.role ?? null, recorded: f.sha256, current });
	}
	return out;
}

/** `STALE: layout block.gds changed after this run (now sha256:<12 chars>)`. */
export function formatStale(s: StaleInput): string {
	const now = s.current === "missing" ? "now missing" : `now sha256:${s.current.slice(0, 12)}`;
	return `STALE: ${s.role ?? "file"} ${s.path} changed after this run (${now})`;
}

export interface RecordEntry {
	id: string;
	created_at: string;
	/** The sha256 of the file that the experiment recorded. */
	sha256: string;
	adapter: string;
	operation: string;
	rule_set: string | null;
	purpose: string | null;
	status: ResultRecord["status"];
	/** The key measurements: the first measurements of the result, without runtimes. */
	measurements: Record<string, number | null>;
	current: boolean;
}

export interface RecordFile {
	path: string;
	/** The role of the file in its most recent experiment (null for a requested file without experiments). */
	role: string | null;
	/** The current sha256, or "missing". */
	sha256: string;
	/** The last commit of the file, when git tracks it; dirty: the file differs from that commit. */
	git: { commit: string; subject: string; dirty: boolean } | null;
	/** Current experiments first, then stale ones; most recent first in each group. */
	experiments: RecordEntry[];
}

export interface DesignRecord {
	root: string;
	files: RecordFile[];
}

const KEY_MEASUREMENTS = 3;

function keyMeasurements(result: ResultRecord): Record<string, number | null> {
	const out: Record<string, number | null> = {};
	for (const [name, m] of Object.entries(result.measurements)) {
		if (/(^|\.)runtime_s$/.test(name)) continue;
		if (Object.keys(out).length === KEY_MEASUREMENTS) break;
		out[name] = m.status === "measured" ? m.value : null;
	}
	return out;
}

/** The last commit of a file and whether the file differs from it, or null (no git, or the file is not tracked). */
export function fileCommit(root: string, path: string): RecordFile["git"] {
	const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		const line = git(["log", "-1", "--format=%H%x09%s", "--", path]);
		if (!line) return null;
		const [commit, ...subject] = line.split("\t");
		const dirty = git(["status", "--porcelain", "--", path]) !== "";
		return { commit, subject: subject.join("\t"), dirty };
	} catch {
		return null;
	}
}

/** A path relative to the design root; an absolute path is made relative. */
export function recordPath(root: string, path: string): string {
	return normalize(isAbsolute(path) ? relative(resolve(root), path) : path);
}

/**
 * The design record of the design root: one entry per file of record of every experiment with a result. With paths,
 * only these files (relative to the root), also when no experiment used them.
 */
export function designRecord(root: string, paths?: string[]): DesignRecord {
	const cache = new Map<string, string>();
	const files = new Map<string, RecordFile>();
	const wanted = paths?.length ? new Set(paths.map((p) => recordPath(root, p))) : null;
	for (const p of wanted ?? []) files.set(p, { path: p, role: null, sha256: currentHash(root, p, cache), git: null, experiments: [] });
	let experiments: ReturnType<typeof listExperiments> = [];
	try {
		experiments = listExperiments(root);
	} catch {}
	for (const { id, experiment, result } of experiments) {
		if (!result?.input_files) continue;
		for (const f of result.input_files.files) {
			if (!ofRecord(f)) continue;
			const path = normalize(f.path);
			if (wanted && !wanted.has(path)) continue;
			let file = files.get(path);
			if (!file) {
				file = { path, role: null, sha256: currentHash(root, path, cache), git: null, experiments: [] };
				files.set(path, file);
			}
			file.role = f.role ?? null;
			const rule = experiment.inputs.rule_set;
			file.experiments.push({
				id,
				created_at: experiment.created_at,
				sha256: f.sha256,
				adapter: experiment.adapter.name,
				operation: experiment.operation,
				rule_set: rule === undefined || rule === null ? null : String(rule),
				purpose: experiment.purpose,
				status: result.status,
				measurements: keyMeasurements(result),
				current: f.sha256 === file.sha256,
			});
		}
	}
	const out = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
	for (const file of out) {
		file.git = existsSync(join(root, file.path)) || file.experiments.length ? fileCommit(root, file.path) : null;
		// Current first; in each group the most recent first (the ids sort by time).
		file.experiments.sort((a, b) => Number(b.current) - Number(a.current) || b.id.localeCompare(a.id));
	}
	return { root, files: out };
}

const num = (x: number) => Number(x.toPrecision(6)).toString();

/** One line per experiment: `<id> <adapter> <operation> [<rule set>] <status> <measurements>`, then the stale note. */
export function formatRecordEntry(e: RecordEntry): string {
	const values = Object.entries(e.measurements).map(([k, v]) => `${k}=${v === null ? "FAILED" : num(v)}`);
	const parts = [e.id, e.adapter, e.operation, ...(e.rule_set === null ? [] : [`[${e.rule_set}]`]), e.status, ...values];
	return `${parts.join(" ")}${e.current ? "" : ` (stale: ran on sha256:${e.sha256.slice(0, 12)})`}`;
}

/**
 * One block per file of record: the path and current hash, the last commit of the file, then one line per experiment
 * (current first, most recent first), at most maxLines lines per file.
 */
export function formatDesignRecord(record: DesignRecord, maxLines = 6): string {
	if (record.files.length === 0) return "design record: no experiment with input files in simra/experiments";
	const blocks: string[] = [];
	for (const f of record.files) {
		const lines: string[] = [];
		const hash = f.sha256 === "missing" ? "missing" : `sha256:${f.sha256.slice(0, 12)}`;
		lines.push(`${f.role ?? "file"} ${f.path} ${hash}`);
		if (f.git) lines.push(`  git ${f.git.commit.slice(0, 12)} ${f.git.subject}${f.git.dirty ? " (the file has changes after this commit)" : ""}`);
		const current = f.experiments.filter((e) => e.current);
		if (current.length === 0) lines.push("  no check on the current file");
		const shown = f.experiments.slice(0, maxLines);
		for (const e of shown) lines.push(`  ${formatRecordEntry(e)}`);
		const rest = f.experiments.slice(shown.length);
		if (rest.length) {
			const stale = rest.filter((e) => !e.current).length;
			lines.push(`  ... ${rest.length} more run${rest.length === 1 ? "" : "s"} (${rest.length - stale} current, ${stale} stale)`);
		}
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n");
}
