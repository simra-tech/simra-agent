// EM S-parameters with openEMS: one "simulate" job per port (that port excited), run as N jobs with "run N jobs and
// wait" on a CPU pool, then one "merge" job that writes the Touchstone file. A port job that did not complete (a
// failed solver, a timeout, or a run that did not reach the end criterion of openEMS) stops the merge: the result has
// no Touchstone file, and the text names the job and its reason.

import { join } from "node:path";
import { formatJobs, type JobOutcome, type JobsOutcome, runJobs } from "./jobs.ts";
import { readJson, type ResultRecord } from "./records.ts";

export interface EmOptions {
	root: string;
	/** Inputs of the openEMS operation "simulate" (gds, stackup, ports, band_hz, ...). "excite" is set per job. */
	inputs: Record<string, unknown>;
	adapter?: string;
	environment?: string;
	/** CPU pool, split into one slot per job. */
	cpus?: string;
	parallel?: number;
	/** Wall time of each port job in seconds (default 3600). */
	timeoutS?: number;
	signal?: AbortSignal;
}

export interface EmOutcome {
	ports: JobsOutcome;
	merge: JobOutcome | null;
	/** The Touchstone file, relative to the design root, or null. */
	touchstone: string | null;
	/** Per port job: the result status and the diagnostics of severity error. */
	problems: string[];
	text: string;
}

function readResult(root: string, job: JobOutcome): ResultRecord | null {
	if (!job.id) return null;
	try {
		return readJson<ResultRecord>(join(root, "simra/experiments", job.id, "result.json"));
	} catch {
		return null;
	}
}

/** The port jobs of an EM run: one "simulate" job per port, with only that port excited. */
export function emPortJobs(opts: EmOptions): { adapter: string; operation: string; inputs: Record<string, unknown>; environment?: string; purpose: string; timeout_s: number }[] {
	const ports = opts.inputs.ports;
	if (!Array.isArray(ports) || ports.length === 0) throw new Error("inputs.ports must be a list of ports");
	if (opts.inputs.excite !== undefined) throw new Error("inputs.excite is set by simra em (one job per port); remove it");
	return ports.map((_, k) => ({
		adapter: opts.adapter ?? "openems",
		operation: "simulate",
		inputs: { ...opts.inputs, excite: [k + 1] },
		environment: opts.environment,
		purpose: `EM port ${k + 1} of ${ports.length}`,
		timeout_s: opts.timeoutS ?? 3600,
	}));
}

export async function emSParameters(opts: EmOptions): Promise<EmOutcome> {
	const jobs = emPortJobs(opts);
	const ports = await runJobs({ root: opts.root, jobs, cpus: opts.cpus, parallel: opts.parallel, signal: opts.signal });
	const problems: string[] = [];
	const columns: string[] = [];
	for (const job of ports.jobs) {
		const result = readResult(opts.root, job);
		const col = result?.outputs.find((o) => o.role === "sparameter_columns");
		if (job.status !== "completed" || !result || !col) {
			const errors = [...job.errors, ...(result?.diagnostics.filter((d) => d.severity === "error").map((d) => d.message) ?? [])];
			problems.push(`${job.purpose}: ${job.status}${errors.length ? `: ${errors.join("; ")}` : ""}`);
			continue;
		}
		columns.push(col.path);
	}
	let merge: JobOutcome | null = null;
	let touchstone: string | null = null;
	if (problems.length === 0) {
		const mergeInputs: Record<string, unknown> = { columns };
		if (opts.inputs.allow_unconverged !== undefined) mergeInputs.allow_unconverged = opts.inputs.allow_unconverged;
		const out = await runJobs({
			root: opts.root,
			cpus: ports.slots[0] ?? undefined,
			signal: opts.signal,
			jobs: [{ adapter: opts.adapter ?? "openems", operation: "merge", inputs: mergeInputs, environment: opts.environment, purpose: "EM merge to Touchstone", timeout_s: 600 }],
		});
		merge = out.jobs[0];
		const result = readResult(opts.root, merge);
		touchstone = (merge.status === "completed" && result?.outputs.find((o) => o.role === "touchstone")?.path) || null;
		if (!touchstone) {
			const errors = [...merge.errors, ...(result?.diagnostics.filter((d) => d.severity === "error").map((d) => d.message) ?? [])];
			problems.push(`EM merge: ${merge.status}${errors.length ? `: ${errors.join("; ")}` : ""}`);
		}
	}
	const head = touchstone ? `EM S-parameters: ${touchstone}` : `EM S-parameters: no Touchstone file\n${problems.map((p) => `  ${p}`).join("\n")}`;
	const tail = merge ? `\nmerge: ${merge.status} (${merge.id})` : problems.length ? "\nmerge: not run (a port job did not complete)" : "";
	return { ports, merge, touchstone, problems, text: `${head}\n\n${formatJobs(ports)}${tail}` };
}
