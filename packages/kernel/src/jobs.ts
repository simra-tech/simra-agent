// Run N jobs and wait: start N detached experiments on a CPU pool, wait for all of them, and give one line per job
// with its status, exit code, runtime and log paths.
//
// - The CPU pool ("122-125") is split into slots of equal size, one job per slot at a time. A job runs pinned to the
//   CPUs of its slot (the cpus of its environment are replaced). Without a pool, every job uses the cpus of its
//   environment and `parallel` jobs run at the same time.
// - Each job has a wall-time watchdog (timeout_s, default 3600 s): the supervisor stops the adapter, removes its
//   container, and records the status "timeout".
// - The wait reads the records of the experiments (result.json, status.json with the process id). It never matches
//   process names.
// - A job that did not start before the wait ended (wait_timeout_s, or an abort) is "not_started": it never runs
//   later. A started job that did not end is "running": wait for it with waitExperiments.

import { relative } from "node:path";
import { type ExecutionStatus, experimentDir, type ExperimentRecord, type ResultRecord } from "./records.ts";
import { ackInbox } from "./inbox.ts";
import type { PassRuleInput } from "./passrule.ts";
import { parseCpuList, runExperiment } from "./runner.ts";
import { pollExperiment } from "./wait.ts";

export interface JobSpec {
	adapter: string;
	operation: string;
	inputs: Record<string, unknown>;
	environment?: string;
	purpose?: string;
	/** Wall time of this job in seconds (default 3600). */
	timeout_s?: number;
	/** The rule that decides pass or fail, recorded before the job starts (see passrule.ts). */
	pass_rule?: PassRuleInput;
	/** A heavy job: it waits for the heavy-job lock of the machine (see heavy.ts). */
	heavy?: boolean;
}

export interface JobsOptions {
	root: string;
	jobs: JobSpec[];
	/** CPU pool, for example "122-125". */
	cpus?: string;
	/** Jobs at the same time. Default: one per CPU of the pool (at most the job count), or 4 without a pool. */
	parallel?: number;
	/** Return after this many seconds (default: no limit; each job has its own watchdog). */
	waitTimeoutS?: number;
	signal?: AbortSignal;
	/** Called when a job starts and when it ends. */
	onEvent?: (event: { kind: "started" | "ended"; job: JobOutcome }) => void;
}

export interface JobOutcome {
	/** The index of the job in the list. */
	index: number;
	id: string | null;
	adapter: string;
	operation: string;
	purpose: string | null;
	cpus: string | null;
	timeout_s: number;
	status: ExecutionStatus | "running" | "not_started";
	exit_code: number | null;
	duration_s: number | null;
	errors: string[];
	/** Paths relative to the design root. */
	records: string | null;
	logs: Record<string, string>;
}

export interface JobsOutcome {
	jobs: JobOutcome[];
	slots: (string | null)[];
	waited_s: number;
	counts: Record<string, number>;
}

const POLL_MS = 500;

/** Split a CPU pool into n slots of equal size (the rest of the division stays unused). */
export function cpuSlots(cpus: string, n?: number): string[] {
	const list = parseCpuList(cpus);
	const count = Math.max(1, Math.min(n ?? list.length, list.length));
	const size = Math.floor(list.length / count);
	return Array.from({ length: count }, (_, k) => list.slice(k * size, (k + 1) * size).join(","));
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

export async function runJobs(opts: JobsOptions): Promise<JobsOutcome> {
	const { root, jobs } = opts;
	if (!jobs.length) throw new Error("no jobs");
	if (opts.parallel !== undefined && !(Number.isInteger(opts.parallel) && opts.parallel > 0)) throw new Error("parallel must be a positive integer");
	for (const [k, j] of jobs.entries()) {
		if (!j || typeof j.adapter !== "string" || typeof j.operation !== "string") throw new Error(`job ${k}: adapter and operation are required`);
		if (j.timeout_s !== undefined && !(typeof j.timeout_s === "number" && j.timeout_s > 0)) throw new Error(`job ${k}: timeout_s must be a positive number`);
	}
	const slots: (string | null)[] = opts.cpus
		? cpuSlots(opts.cpus, Math.min(opts.parallel ?? Number.POSITIVE_INFINITY, jobs.length))
		: Array.from({ length: Math.min(opts.parallel ?? 4, jobs.length) }, () => null);
	const outcomes: JobOutcome[] = jobs.map((j, index) => ({
		index,
		id: null,
		adapter: j.adapter,
		operation: j.operation,
		purpose: j.purpose ?? null,
		cpus: null,
		timeout_s: j.timeout_s ?? 3600,
		status: "not_started",
		exit_code: null,
		duration_s: null,
		errors: [],
		records: null,
		logs: {},
	}));
	const experiments = new Map<number, ExperimentRecord>();
	const free = slots.map((_, k) => k);
	const running = new Map<number, number>(); // job index -> slot
	const start = Date.now();
	const deadline = opts.waitTimeoutS === undefined ? Number.POSITIVE_INFINITY : start + opts.waitTimeoutS * 1000;
	let next = 0;

	const finish = (k: number, result: ResultRecord) => {
		const o = outcomes[k];
		o.status = result.status;
		o.exit_code = result.exit_code;
		o.duration_s = result.duration_s;
		o.errors = result.errors;
		o.logs = { ...result.logs, ...o.logs };
		// The caller gets the outcome of the job: it leaves the inbox of the design root.
		if (o.id) ackInbox(root, [o.id]);
		free.push(running.get(k) as number);
		running.delete(k);
		opts.onEvent?.({ kind: "ended", job: o });
	};

	for (;;) {
		// Start jobs in the free slots.
		while (free.length && next < jobs.length && Date.now() < deadline && !opts.signal?.aborted) {
			const k = next++;
			const slot = free.shift() as number;
			const j = jobs[k];
			const o = outcomes[k];
			o.cpus = slots[slot];
			try {
				const started = await runExperiment({
					root,
					adapter: j.adapter,
					operation: j.operation,
					inputs: j.inputs ?? {},
					environment: j.environment,
					purpose: j.purpose,
					timeoutS: o.timeout_s,
					cpus: slots[slot] ?? undefined,
					detached: true,
					passRule: j.pass_rule,
					heavy: j.heavy,
				});
				o.id = started.id;
				o.status = "running";
				o.cpus = started.experiment.environment.cpus ?? null;
				const dir = relative(root, experimentDir(root, started.id));
				o.records = `${dir}/`;
				o.logs = { supervisor_stdout: `${dir}/supervisor.stdout.log`, supervisor_stderr: `${dir}/supervisor.stderr.log` };
				experiments.set(k, started.experiment);
				running.set(k, slot);
				opts.onEvent?.({ kind: "started", job: o });
			} catch (e) {
				// The job could not start (unknown adapter, environment, image): an error, and its slot is free again.
				o.status = "error";
				o.errors = [(e as Error).message];
				free.unshift(slot);
				opts.onEvent?.({ kind: "ended", job: o });
			}
		}
		for (const k of [...running.keys()]) {
			const result = pollExperiment(root, outcomes[k].id as string, experiments.get(k) as ExperimentRecord);
			if (result) finish(k, result);
		}
		const waiting = running.size > 0 || next < jobs.length;
		if (!waiting || Date.now() >= deadline || opts.signal?.aborted) break;
		await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), opts.signal);
	}
	const counts: Record<string, number> = {};
	for (const o of outcomes) counts[o.status] = (counts[o.status] ?? 0) + 1;
	return { jobs: outcomes, slots, waited_s: (Date.now() - start) / 1000, counts };
}

/** One line per job, then the counts. */
export function formatJobs(outcome: JobsOutcome): string {
	const lines = outcome.jobs.map((o) => {
		const head = `job ${o.index} ${o.adapter}.${o.operation}${o.purpose ? ` (${o.purpose})` : ""}: ${o.status}`;
		const facts = [
			o.id ? `experiment ${o.id}` : null,
			o.cpus ? `cpus ${o.cpus}` : null,
			o.duration_s !== null ? `${o.duration_s.toFixed(1)} s of ${o.timeout_s} s` : `watchdog ${o.timeout_s} s`,
			o.exit_code !== null ? `exit code ${o.exit_code}` : null,
		].filter(Boolean);
		const logs = Object.entries(o.logs).map(([k, v]) => `  ${k}: ${v}`);
		const errors = o.errors.map((e) => `  error: ${e}`);
		return [`${head}; ${facts.join("; ")}`, ...errors, ...logs].join("\n");
	});
	const counts = Object.entries(outcome.counts).map(([k, v]) => `${v} ${k}`).join(", ");
	const tail = [`jobs: ${outcome.jobs.length} (${counts}); waited ${outcome.waited_s.toFixed(1)} s`];
	if (outcome.counts.running) tail.push("a running job continues: wait for it with wait_experiments (or simra wait) and its experiment id");
	if (outcome.counts.not_started) tail.push("a job that did not start never runs: start it again");
	return [...lines, ...tail].join("\n");
}
