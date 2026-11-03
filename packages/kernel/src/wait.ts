// Wait for experiments: a detached run (or a blocking run in another process) ends when its result.json exists.
// A run whose process is gone without result.json is recorded as "error" by the wait.

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import {
	type ExecutionStatus,
	experimentDir,
	type ExperimentRecord,
	finishStatus,
	readJson,
	readStatus,
	RESULT_SCHEMA,
	type ResultRecord,
	type StatusRecord,
	writeJsonAtomic,
} from "./records.ts";

export interface WaitOptions {
	/** Return after this many seconds, with the status "running" for the runs that did not end (default 3600). */
	timeoutS?: number;
	/** Abort returns at once, as a timeout does. The runs continue. */
	signal?: AbortSignal;
}

export interface WaitOutcome {
	id: string;
	experiment: ExperimentRecord;
	/** The result status, or "running" when the run did not end before the wait returned. */
	status: ExecutionStatus | "running";
	result: ResultRecord | null;
}

const POLL_MS = 1000;

/** true when the process exists (also when it belongs to another user). */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Write the error result of a run whose process ended before it wrote result.json. */
function recordDead(root: string, id: string, experiment: ExperimentRecord, status: StatusRecord | null): ResultRecord {
	if (status?.detached) {
		// The adapter is in the process group of the supervisor: stop it if it still runs.
		try {
			process.kill(-status.pid, "SIGTERM");
		} catch {}
	}
	const dir = experimentDir(root, id);
	const now = new Date();
	const started = status?.started_at ?? experiment.created_at;
	const who = status ? `the ${status.detached ? "supervisor" : "runner"} process (pid ${status.pid})` : "the run (no status.json)";
	const result: ResultRecord = {
		schema: RESULT_SCHEMA,
		experiment: id,
		status: "error",
		started_at: started,
		finished_at: now.toISOString(),
		duration_s: Math.max(0, (now.getTime() - Date.parse(started)) / 1000),
		exit_code: null,
		signal: null,
		errors: [`${who} ended before it wrote result.json; a wait recorded this at ${now.toISOString()}`],
		tool: null,
		input_files: null,
		outputs: [],
		measurements: {},
		diagnostics: [],
		logs: { adapter_stdout: relative(root, join(dir, "adapter.stdout.log")), adapter_stderr: relative(root, join(dir, "adapter.stderr.log")) },
	};
	writeJsonAtomic(join(dir, "result.json"), result);
	finishStatus(root, id, result);
	return result;
}

/** The result of the run, or null while it runs. */
function poll(root: string, id: string, experiment: ExperimentRecord): ResultRecord | null {
	const resultPath = join(experimentDir(root, id), "result.json");
	if (existsSync(resultPath)) return readJson<ResultRecord>(resultPath);
	const status = readStatus(root, id);
	// A process on another host cannot be checked from here.
	if (status && (status.host !== hostname() || alive(status.pid))) return null;
	// The process wrote result.json just before it ended.
	if (existsSync(resultPath)) return readJson<ResultRecord>(resultPath);
	return recordDead(root, id, experiment, status);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * Wait until each listed experiment has result.json (or its process is gone), the timeout, or the abort. It reads the
 * records once per second. The outcomes are in the order of ids.
 */
export async function waitExperiments(root: string, ids: string[], opts: WaitOptions = {}): Promise<WaitOutcome[]> {
	const experiments = new Map<string, ExperimentRecord>();
	for (const id of ids) {
		const path = join(experimentDir(root, id), "experiment.json");
		if (!/^[\w.-]+$/.test(id) || id === "." || id === ".." || !existsSync(path)) throw new Error(`experiment "${id}" not found in ${relative(root, experimentDir(root, "")) || "."}`);
		experiments.set(id, readJson<ExperimentRecord>(path));
	}
	const deadline = Date.now() + (opts.timeoutS ?? 3600) * 1000;
	const results = new Map<string, ResultRecord>();
	for (;;) {
		for (const [id, experiment] of experiments) {
			if (results.has(id)) continue;
			const result = poll(root, id, experiment);
			if (result) results.set(id, result);
		}
		const left = deadline - Date.now();
		if (results.size === experiments.size || left <= 0 || opts.signal?.aborted) break;
		await sleep(Math.min(POLL_MS, left), opts.signal);
	}
	return ids.map((id) => {
		const result = results.get(id) ?? null;
		return { id, experiment: experiments.get(id) as ExperimentRecord, status: result?.status ?? "running", result };
	});
}
