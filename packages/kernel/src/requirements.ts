// Requirements and checks. A requirement is one limit on one measurement, at one or more conditions
// (for example process corners). The requirements are a plain JSON file in the design root:
//
//   <root>/requirements.json                  what the design must meet (schema simra.requirements/0)
//   <root>/simra/checks/<id>/verdict.json     the result of one check (schema simra.verdict/0)
//
// A check runs the experiments that the selected requirements need (one per experiment and condition) and
// compares each measurement with its limit. result.json keeps the execution status; only the verdict says
// "pass" or "fail", and each verdict row names the experiment that gave its value.

import { existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
	type ExecutionStatus,
	type ExperimentRecord,
	newExperimentId,
	readJson,
	type ResultRecord,
	writeJsonAtomic,
} from "./records.ts";
import { gitState, KERNEL_VERSION, runExperiment, sha256File } from "./runner.ts";

export const REQUIREMENTS_SCHEMA = "simra.requirements/0";
export const VERDICT_SCHEMA = "simra.verdict/0";
export const REQUIREMENTS_FILE = "requirements.json";
/** Reason of a row that the check did not select. */
export const NOT_SELECTED = "not selected in this check";

/** One limit. "between" takes [low, high]; "<=" and ">=" take one number. */
export type Limit = number | [number, number];

export interface Requirement {
	id: string;
	description?: string;
	/** Name of an entry in "experiments". */
	experiment: string;
	/** Measurement name in the result of that experiment. */
	measurement: string;
	/** Expected unit. A measurement with a different unit is not compared. */
	unit?: string;
	op: "<=" | ">=" | "between";
	/** One limit for all conditions, or one limit per condition name. */
	limit: Limit | Record<string, Limit>;
	conditions: string[];
}

export interface ExperimentTemplate {
	adapter: string;
	operation: string;
	/** Adapter inputs. In each string, "{condition}" is replaced with the condition name. */
	inputs: Record<string, unknown>;
	environment?: string;
	timeout_s?: number;
}

export interface RequirementsFile {
	schema: typeof REQUIREMENTS_SCHEMA;
	/** Each condition adds its inputs to the experiment inputs (a condition input replaces an input of the same name). */
	conditions: Record<string, { description?: string; inputs?: Record<string, unknown> }>;
	experiments: Record<string, ExperimentTemplate>;
	requirements: Requirement[];
}

/**
 * Row status. "not_run": no usable experiment (not selected, or the experiment did not complete).
 * "not_measured": the experiment completed, but the value is missing or has a different unit.
 */
export type RowStatus = "pass" | "fail" | "not_measured" | "not_run";

export interface VerdictRow {
	requirement: string;
	condition: string;
	measurement: string;
	op: Requirement["op"];
	limit: Limit;
	value: number | null;
	unit: string | null;
	/** Distance to the limit in the measurement unit; positive means inside the limit. */
	margin: number | null;
	/** margin divided by |limit| ("between": by high - low); null when the divisor is 0. */
	margin_rel: number | null;
	status: RowStatus;
	experiment: string | null;
	reason: string | null;
}

export interface VerdictRecord {
	schema: typeof VERDICT_SCHEMA;
	id: string;
	created_at: string;
	/** "pass" only when every row of every requirement passes. A partial check is never "pass". */
	status: "pass" | "fail" | "incomplete";
	counts: Record<RowStatus, number>;
	requirements_file: { path: string; sha256: string };
	selection: { requirements: string[] | null; conditions: string[] | null };
	design: ExperimentRecord["design"];
	simra: { kernel_version: string };
	experiments: { id: string; experiment: string; condition: string; status: ExecutionStatus }[];
	rows: VerdictRow[];
}

export interface CheckOptions {
	root: string;
	/** Requirements file, relative to the root (default requirements.json). */
	file?: string;
	/** Check only these requirement ids. The others are recorded as not run. */
	requirements?: string[];
	/** Check only these conditions. The others are recorded as not run. */
	conditions?: string[];
	signal?: AbortSignal;
}

export function checksDir(root: string): string {
	return join(root, "simra", "checks");
}

const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function validLimit(op: Requirement["op"], limit: unknown): boolean {
	if (op === "between") return Array.isArray(limit) && limit.length === 2 && limit.every(isNumber) && limit[0] <= limit[1];
	return isNumber(limit);
}

/** Every problem in the file, so that the author can fix them all at once. An empty list means valid. */
export function validateRequirements(file: RequirementsFile): string[] {
	const errors: string[] = [];
	if (file.schema !== REQUIREMENTS_SCHEMA) errors.push(`schema is ${String(file.schema)}, expected ${REQUIREMENTS_SCHEMA}`);
	const conditions = file.conditions ?? {};
	const experiments = file.experiments ?? {};
	for (const [name, e] of Object.entries(experiments)) {
		if (!e.adapter || !e.operation) errors.push(`experiment "${name}": adapter and operation are required`);
	}
	if (!Array.isArray(file.requirements) || file.requirements.length === 0) {
		errors.push("requirements: give at least one requirement");
		return errors;
	}
	const ids = new Set<string>();
	for (const r of file.requirements) {
		const where = `requirement "${r.id}"`;
		if (!r.id) errors.push("a requirement has no id");
		if (ids.has(r.id)) errors.push(`${where}: the id is used more than once`);
		ids.add(r.id);
		if (!experiments[r.experiment]) errors.push(`${where}: experiment "${r.experiment}" is not defined`);
		if (!r.measurement) errors.push(`${where}: measurement is required`);
		if (!["<=", ">=", "between"].includes(r.op)) errors.push(`${where}: op is ${String(r.op)}, expected <=, >= or between`);
		if (!Array.isArray(r.conditions) || r.conditions.length === 0) {
			errors.push(`${where}: give at least one condition`);
			continue;
		}
		for (const c of r.conditions) {
			if (!conditions[c]) errors.push(`${where}: condition "${c}" is not defined`);
			const limit = limitFor(r, c);
			if (!validLimit(r.op, limit)) errors.push(`${where}: no valid limit for op ${r.op} at condition "${c}"`);
		}
	}
	return errors;
}

function limitFor(r: Requirement, condition: string): Limit | undefined {
	if (isNumber(r.limit) || Array.isArray(r.limit)) return r.limit;
	return (r.limit as Record<string, Limit> | undefined)?.[condition];
}

function substitute(value: unknown, condition: string): unknown {
	if (typeof value === "string") return value.replaceAll("{condition}", condition);
	if (Array.isArray(value)) return value.map((v) => substitute(v, condition));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, condition)]));
	}
	return value;
}

/** The inputs of one experiment at one condition. */
export function experimentInputs(file: RequirementsFile, experiment: string, condition: string): Record<string, unknown> {
	const merged = { ...file.experiments[experiment].inputs, ...(file.conditions[condition].inputs ?? {}) };
	return substitute(merged, condition) as Record<string, unknown>;
}

function compare(op: Requirement["op"], limit: Limit, value: number): { margin: number; margin_rel: number | null } {
	if (op === "between") {
		const [low, high] = limit as [number, number];
		const margin = Math.min(value - low, high - value);
		return { margin, margin_rel: high > low ? margin / (high - low) : null };
	}
	const l = limit as number;
	const margin = op === "<=" ? l - value : value - l;
	return { margin, margin_rel: l !== 0 ? margin / Math.abs(l) : null };
}

/** One row from the result of the experiment that measured it (null: not run). */
export function evaluateRow(
	r: Requirement,
	condition: string,
	run: { id: string; result: ResultRecord } | null,
	notRunReason: string,
): VerdictRow {
	const limit = limitFor(r, condition) as Limit;
	const row: VerdictRow = {
		requirement: r.id,
		condition,
		measurement: r.measurement,
		op: r.op,
		limit,
		value: null,
		unit: r.unit ?? null,
		margin: null,
		margin_rel: null,
		status: "not_run",
		experiment: run?.id ?? null,
		reason: null,
	};
	if (!run) return { ...row, reason: notRunReason };
	if (run.result.status !== "completed") {
		return { ...row, reason: `experiment ${run.id} ended with status ${run.result.status}` };
	}
	const m = run.result.measurements[r.measurement];
	if (!m || m.status !== "measured" || !isNumber(m.value)) {
		return { ...row, status: "not_measured", reason: `experiment ${run.id} gave no value for ${r.measurement}` };
	}
	row.value = m.value;
	row.unit = m.unit ?? r.unit ?? null;
	if (r.unit && m.unit && r.unit !== m.unit) {
		return { ...row, status: "not_measured", reason: `unit is ${m.unit}, the requirement expects ${r.unit}` };
	}
	const { margin, margin_rel } = compare(r.op, limit, m.value);
	return { ...row, margin, margin_rel, status: margin >= 0 ? "pass" : "fail" };
}

export function loadRequirements(root: string, file = REQUIREMENTS_FILE): { path: string; file: RequirementsFile } {
	const path = resolve(root, file);
	if (!existsSync(path)) throw new Error(`requirements file not found: ${relative(root, path) || path}`);
	const parsed = readJson<RequirementsFile>(path);
	const errors = validateRequirements(parsed);
	if (errors.length) throw new Error(`invalid requirements file ${relative(root, path)}:\n- ${errors.join("\n- ")}`);
	return { path, file: parsed };
}

/** Run the experiments that the selected rows need, one at a time, and write the verdict. */
export async function runCheck(opts: CheckOptions): Promise<{ id: string; dir: string; verdict: VerdictRecord }> {
	const root = resolve(opts.root);
	const { path, file } = loadRequirements(root, opts.file);
	const known = new Set(file.requirements.map((r) => r.id));
	for (const id of opts.requirements ?? []) if (!known.has(id)) throw new Error(`requirement "${id}" is not defined`);
	for (const c of opts.conditions ?? []) if (!file.conditions[c]) throw new Error(`condition "${c}" is not defined`);

	const selected = (r: Requirement, c: string) =>
		(!opts.requirements || opts.requirements.includes(r.id)) && (!opts.conditions || opts.conditions.includes(c));

	// One experiment per (experiment, condition) pair, shared by all requirements that read it.
	const pairs = new Map<string, { experiment: string; condition: string }>();
	for (const r of file.requirements) {
		for (const c of r.conditions) if (selected(r, c)) pairs.set(`${r.experiment}\u0000${c}`, { experiment: r.experiment, condition: c });
	}

	const id = newExperimentId();
	const runs = new Map<string, { id: string; result: ResultRecord }>();
	const experiments: VerdictRecord["experiments"] = [];
	for (const [key, { experiment, condition }] of pairs) {
		if (opts.signal?.aborted) break;
		const t = file.experiments[experiment];
		const outcome = await runExperiment({
			root,
			adapter: t.adapter,
			operation: t.operation,
			inputs: experimentInputs(file, experiment, condition),
			environment: t.environment,
			timeoutS: t.timeout_s,
			purpose: `check ${id}: ${experiment} at ${condition}`,
			signal: opts.signal,
		});
		runs.set(key, { id: outcome.id, result: outcome.result });
		experiments.push({ id: outcome.id, experiment, condition, status: outcome.result.status });
	}

	const rows: VerdictRow[] = [];
	for (const r of file.requirements) {
		for (const c of r.conditions) {
			// A row that is not selected stays not run, also when a selected row shares its experiment.
			const run = selected(r, c) ? (runs.get(`${r.experiment}\u0000${c}`) ?? null) : null;
			rows.push(evaluateRow(r, c, run, selected(r, c) ? "the check was cancelled before this experiment" : NOT_SELECTED));
		}
	}
	const counts: Record<RowStatus, number> = { pass: 0, fail: 0, not_measured: 0, not_run: 0 };
	for (const row of rows) counts[row.status]++;

	const verdict: VerdictRecord = {
		schema: VERDICT_SCHEMA,
		id,
		created_at: new Date().toISOString(),
		status: counts.fail > 0 ? "fail" : counts.pass === rows.length ? "pass" : "incomplete",
		counts,
		requirements_file: { path: relative(root, path), sha256: sha256File(path) },
		selection: { requirements: opts.requirements ?? null, conditions: opts.conditions ?? null },
		design: gitState(root),
		simra: { kernel_version: KERNEL_VERSION },
		experiments,
		rows,
	};
	const dir = join(checksDir(root), id);
	mkdirSync(dir, { recursive: true });
	writeJsonAtomic(join(dir, "verdict.json"), verdict);
	return { id, dir, verdict };
}
