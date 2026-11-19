// EM S-parameters with openEMS: one "simulate" job per port (that port excited), run as N jobs with "run N jobs and
// wait" on a CPU pool, then one "merge" job that writes the Touchstone file. A port job that did not complete (a
// failed solver, a timeout, or a run that did not reach the end criterion of openEMS) stops the merge: the result has
// no Touchstone file, and the text names the job and its reason.

import { join } from "node:path";
import { formatJobs, type JobOutcome, type JobsOutcome, runJobs } from "./jobs.ts";
import { readJson, type ResultRecord } from "./records.ts";
import { entry, readTouchstone } from "./touchstone.ts";

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
		if (opts.inputs.deembed !== undefined) mergeInputs.deembed = opts.inputs.deembed;
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

export interface SPoint {
	/** The requested frequency and the nearest frequency of the file (no interpolation). */
	f_req_hz: number;
	f_hz: number;
	/** "S21" -> [dB, degrees]. */
	s: Record<string, [number, number]>;
}

/** Every S_ij (dB and degrees) at the file point nearest to each requested frequency. */
export function sParametersAt(path: string, freqs: number[]): SPoint[] {
	const t = readTouchstone(path);
	const n = t.nports;
	const name = (i: number, j: number) => (n <= 9 ? `S${i + 1}${j + 1}` : `S${i + 1}_${j + 1}`);
	return freqs.map((f) => {
		let k = 0;
		for (let m = 1; m < t.f.length; m++) if (Math.abs(t.f[m] - f) < Math.abs(t.f[k] - f)) k = m;
		const s: Record<string, [number, number]> = {};
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				const [re, im] = entry(t, k, i, j);
				s[name(i, j)] = [20 * Math.log10(Math.hypot(re, im)), (Math.atan2(im, re) * 180) / Math.PI];
			}
		}
		return { f_req_hz: f, f_hz: t.f[k], s };
	});
}

export function formatSPoints(points: SPoint[]): string {
	return points
		.map((p) => {
			const at = p.f_hz === p.f_req_hz ? `${p.f_hz / 1e9} GHz` : `${p.f_hz / 1e9} GHz (nearest point to ${p.f_req_hz / 1e9} GHz)`;
			return `${at}: ${Object.entries(p.s).map(([k, [db, deg]]) => `${k} ${db.toFixed(3)} dB ${deg.toFixed(2)} deg`).join(", ")}`;
		})
		.join("\n");
}

export interface SnpDiffEntry {
	entry: string;
	max_abs_db: number;
	at_db_hz: number;
	max_abs_deg: number;
	at_deg_hz: number;
	max_abs_ds: number;
	at_ds_hz: number;
}

/**
 * The difference of two Touchstone files with the same port count, at the frequencies that both have (within 1 Hz)
 * inside the band: per S_ij the largest |difference| in dB, in degrees (wrapped to +-180) and of the complex value.
 * Phase and dB differences of an entry below floor_db (default -40 dB in both files) are left out: they are noise.
 */
export function compareTouchstone(a: string, b: string, band?: [number, number], floorDb = -40): { points: number; entries: SnpDiffEntry[] } {
	const ta = readTouchstone(a);
	const tb = readTouchstone(b);
	if (ta.nports !== tb.nports) throw new Error(`port counts differ: ${ta.nports} and ${tb.nports}`);
	const n = ta.nports;
	const pairs: [number, number][] = [];
	let j = 0;
	for (let k = 0; k < ta.f.length; k++) {
		const f = ta.f[k];
		if (band && (f < band[0] - 1 || f > band[1] + 1)) continue;
		while (j < tb.f.length && tb.f[j] < f - 1) j++;
		if (j < tb.f.length && Math.abs(tb.f[j] - f) <= 1) pairs.push([k, j]);
	}
	if (!pairs.length) throw new Error("the files have no common frequency in the band");
	const entries: SnpDiffEntry[] = [];
	for (let i = 0; i < n; i++) {
		for (let m = 0; m < n; m++) {
			const e: SnpDiffEntry = { entry: `S${i + 1}${m + 1}`, max_abs_db: 0, at_db_hz: NaN, max_abs_deg: 0, at_deg_hz: NaN, max_abs_ds: 0, at_ds_hz: NaN };
			for (const [k, l] of pairs) {
				const [ar, ai] = entry(ta, k, i, m);
				const [br, bi] = entry(tb, l, i, m);
				const ds = Math.hypot(ar - br, ai - bi);
				if (ds > e.max_abs_ds) [e.max_abs_ds, e.at_ds_hz] = [ds, ta.f[k]];
				const da = 20 * Math.log10(Math.hypot(ar, ai));
				const db = 20 * Math.log10(Math.hypot(br, bi));
				if (da < floorDb && db < floorDb) continue;
				if (Math.abs(da - db) > e.max_abs_db) [e.max_abs_db, e.at_db_hz] = [Math.abs(da - db), ta.f[k]];
				let deg = ((Math.atan2(ai, ar) - Math.atan2(bi, br)) * 180) / Math.PI;
				deg = ((((deg + 180) % 360) + 360) % 360) - 180;
				if (Math.abs(deg) > e.max_abs_deg) [e.max_abs_deg, e.at_deg_hz] = [Math.abs(deg), ta.f[k]];
			}
			entries.push(e);
		}
	}
	return { points: pairs.length, entries };
}

export function formatSnpDiff(d: { points: number; entries: SnpDiffEntry[] }): string {
	const ghz = (f: number) => (Number.isNaN(f) ? "-" : `${(f / 1e9).toFixed(1)} GHz`);
	return [`${d.points} common points`, ...d.entries.map((e) => `${e.entry}: max ${e.max_abs_db.toFixed(3)} dB at ${ghz(e.at_db_hz)}, ${e.max_abs_deg.toFixed(2)} deg at ${ghz(e.at_deg_hz)}, |dS| ${e.max_abs_ds.toFixed(4)} at ${ghz(e.at_ds_hz)}`)].join("\n");
}
