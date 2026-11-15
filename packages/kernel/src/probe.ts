// Device-class probe: run the operation probe_devices of each simulator adapter (one small DC deck per device class of
// the technology pack) as N jobs, and merge the rows into one table "class x simulator: simulates / parses / fails /
// not run, with the reason". Use it before a campaign: a model gap of a simulator found late costs a campaign.

import { join } from "node:path";
import { formatJobs, type JobOutcome, runJobs } from "./jobs.ts";
import { readJson, type ResultRecord } from "./records.ts";

export const PROBE_SCHEMA = "simra.device_probe/0";
export type ProbeStatus = "simulates" | "parses" | "fails" | "not run";

export interface ProbeRow {
	class: string;
	simulator: string;
	description?: string | null;
	status: ProbeStatus;
	value_a: number | null;
	reason: string | null;
	warnings: string[];
	gaps?: string[];
}

export interface ProbeTable {
	schema: typeof PROBE_SCHEMA;
	pdk: string;
	pack: string | null;
	/** Per simulator: its version and the experiment of its probe. */
	simulators: Record<string, { version: string | null; experiment: string | null; status: string }>;
	/** class -> simulator -> cell. */
	classes: Record<string, Record<string, Omit<ProbeRow, "class" | "simulator">>>;
	/** For each class that more than one simulator simulates: the largest relative difference of the probe currents. */
	agreement: Record<string, number>;
}

/** The relative difference |a - b| / max(|a|, |b|) of the probe currents; 0 when both are below 1 fA. */
export function relativeDifference(values: number[]): number {
	const big = Math.max(...values.map(Math.abs));
	if (big < 1e-15) return 0;
	return (Math.max(...values) - Math.min(...values)) / big;
}

export interface ProbeOptions {
	root: string;
	pdk: string;
	/** Adapters with the operation probe_devices (default ngspice and xyce). */
	simulators?: string[];
	environment?: string;
	cpus?: string;
	classes?: string[];
	technology?: string;
	/** The watchdog of each simulator job (default 1800 s). */
	timeoutS?: number;
	signal?: AbortSignal;
}

export async function probeDevices(opts: ProbeOptions): Promise<{ table: ProbeTable; jobs: JobOutcome[]; text: string }> {
	const simulators = opts.simulators ?? ["ngspice", "xyce"];
	const inputs = { pdk: opts.pdk, ...(opts.classes ? { classes: opts.classes } : {}), ...(opts.technology ? { technology: opts.technology } : {}) };
	const out = await runJobs({
		root: opts.root,
		cpus: opts.cpus,
		signal: opts.signal,
		jobs: simulators.map((adapter) => ({
			adapter,
			operation: "probe_devices",
			inputs,
			environment: opts.environment,
			purpose: `device-class probe of ${opts.pdk} in ${adapter}`,
			timeout_s: opts.timeoutS ?? 1800,
		})),
	});
	const table: ProbeTable = { schema: PROBE_SCHEMA, pdk: opts.pdk, pack: null, simulators: {}, classes: {}, agreement: {} };
	for (const [k, job] of out.jobs.entries()) {
		const sim = simulators[k];
		table.simulators[sim] = { version: null, experiment: job.id, status: job.status };
		if (!job.id || job.status !== "completed") continue;
		const result = readJson<ResultRecord>(join(opts.root, "simra/experiments", job.id, "result.json"));
		const entry = result.outputs.find((o) => o.role === "probe");
		if (!entry) continue;
		const probe = readJson<{ version: string | null; pack: string; rows: ProbeRow[] }>(join(opts.root, entry.path));
		table.simulators[sim].version = probe.version;
		table.pack ??= probe.pack;
		for (const row of probe.rows) {
			const { class: name, simulator: _s, ...cell } = row;
			table.classes[name] ??= {};
			table.classes[name][sim] = cell;
		}
	}
	// A simulator whose job did not complete is "not run" for every class.
	for (const sim of simulators) {
		for (const cells of Object.values(table.classes)) {
			cells[sim] ??= { status: "not run", value_a: null, reason: `the ${sim} probe ended with status ${table.simulators[sim].status}`, warnings: [] };
		}
	}
	for (const [name, cells] of Object.entries(table.classes)) {
		const values = Object.values(cells).filter((c) => c.status === "simulates" && c.value_a !== null).map((c) => c.value_a as number);
		if (values.length > 1) table.agreement[name] = relativeDifference(values);
	}
	return { table, jobs: out.jobs, text: `${formatProbeTable(table)}\n\n${formatJobs(out)}` };
}

/** The table as text: one line per class, one column per simulator, then the reasons. */
export function formatProbeTable(table: ProbeTable): string {
	const sims = Object.keys(table.simulators);
	const names = Object.keys(table.classes);
	const width = Math.max(5, ...names.map((n) => n.length));
	const lines = [
		`device-class probe of ${table.pdk} (pack ${table.pack ?? "?"}): ${sims.map((s) => `${s} ${table.simulators[s].version ?? "?"} [${table.simulators[s].experiment ?? "not started"}]`).join(", ")}`,
		`${"class".padEnd(width)}  ${sims.map((s) => s.padEnd(10)).join("  ")}`,
	];
	for (const n of names) lines.push(`${n.padEnd(width)}  ${sims.map((s) => (table.classes[n][s]?.status ?? "not run").padEnd(10)).join("  ")}`);
	const counts = sims.map((s) => {
		const c: Record<string, number> = {};
		for (const n of names) c[table.classes[n][s]?.status ?? "not run"] = (c[table.classes[n][s]?.status ?? "not run"] ?? 0) + 1;
		return `${s}: ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(", ")}`;
	});
	lines.push(counts.join("; "));
	const apart = Object.entries(table.agreement ?? {}).filter(([, d]) => d > 0.01);
	if (apart.length) lines.push("simulators disagree (probe current, relative difference above 1 %):", ...apart.map(([n, d]) => `  ${n}: ${(d * 100).toFixed(1)} %`));
	const reasons = names.flatMap((n) => sims.filter((s) => table.classes[n][s]?.reason).map((s) => `  ${n} / ${s}: ${table.classes[n][s].status}: ${table.classes[n][s].reason}`));
	if (reasons.length) lines.push("reasons:", ...reasons);
	const warnings = names.flatMap((n) => sims.flatMap((s) => (table.classes[n][s]?.warnings ?? []).slice(0, 1).map((w) => `  ${n} / ${s}: ${w}`)));
	if (warnings.length) lines.push("fidelity warnings (first per cell):", ...warnings);
	return lines.join("\n");
}
