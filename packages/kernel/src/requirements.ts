// Requirements and checks. A requirement is one limit on one measurement, at one or more conditions
// (for example process corners). The requirements are a plain JSON file in the design root:
//
//   <root>/requirements.json                  what the design must meet (schema simra.requirements/0)
//   <root>/simra/checks/<id>/verdict.json     the result of one check (schema simra.verdict/0)
//
// A check runs the experiments that the selected requirements need (one per experiment and condition) and
// compares each measurement with its limit. result.json keeps the execution status; only the verdict says
// "pass" or "fail", and each verdict row names the experiment that gave its value.
//
// A sweep experiment reports <measurement>.min and <measurement>.max instead of one value. A row then uses the
// worst point for its op (>=: .min, <=: .max, between: both) and gives the sweep point in "at".
//
// A requirement without conditions reads its experiment once, with the template inputs only (for example a check of
// the design netlist: design_errors <= 0, area_um2 <= 800). The verdict keeps the error and warning diagnostics of
// each experiment, so a failed row can show its errors with file and line. The kernel reads no netlist and holds no
// PDK facts.

import { type ConnectionRow, connectionGate } from "./connections.ts";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
	type Diagnostic,
	type ExecutionStatus,
	type ExperimentRecord,
	type Measurement,
	newExperimentId,
	readJson,
	type ResultRecord,
	writeJsonAtomic,
} from "./records.ts";
import { type ReducerSpec, reduceSweep, reducerError, type SweepPoint } from "./reducers.ts";
import { gitState, KERNEL_VERSION, runExperiment, sha256File } from "./runner.ts";
import { isTouchstoneEntry, readTouchstone, sDb, stabilityMu } from "./touchstone.ts";

export const REQUIREMENTS_SCHEMA = "simra.requirements/0";
export const VERDICT_SCHEMA = "simra.verdict/0";
export const REQUIREMENTS_FILE = "requirements.json";
/** Reason of a row that the check did not select. */
export const NOT_SELECTED = "not selected in this check";

/** One limit. "between" takes [low, high]; "<=" and ">=" take one number. */
export type Limit = number | [number, number];

/**
 * "measurement" (the default): a measurement of the experiment. "s_db" and "mu": a value that the kernel computes from
 * a Touchstone file of the experiment (an output, or an input file) at each data point in band_hz; the row uses the
 * worst point. s_db is 20 log10 |S_ij| (entry [i, j], ports from 1); mu is the stability factor of a 2-port
 * (Edwards and Sinsky), > 1 for an unconditionally stable 2-port.
 */
export type RequirementKind = "measurement" | "s_db" | "mu" | "sweep";
export const REQUIREMENT_KINDS: RequirementKind[] = ["measurement", "s_db", "mu", "sweep"];

/** The stability gate: every listed stage needs a mu requirement over the band at every listed condition. */
/** The connection gate: the block interface record of a block against the connection table (see connections.ts). */
export interface ConnectionsGate {
	/** The connection table, relative to the design root. */
	table: string;
	block: string;
	/** The block interface record, relative to the design root. */
	interface: string;
}

export interface StabilityGate {
	/** The active RF stages of the block. A mu requirement names its stage in "stage". */
	stages: string[];
	/** Default [1e9, 300e9]. A mu requirement covers the gate when its band contains this band. */
	band_hz?: [number, number];
	/** The conditions (corners) of the gate. */
	conditions: string[];
}
export const STABILITY_BAND_HZ: [number, number] = [1e9, 300e9];

/** A stated assumption (for example a system level that no block measures). Rows that depend on it cite its id. */
export interface Assumption {
	description: string;
	value?: number | string;
	unit?: string;
	source?: string;
}

export interface Requirement {
	id: string;
	description?: string;
	/** Name of an entry in "experiments". */
	experiment: string;
	/** Default "measurement". */
	kind?: RequirementKind;
	/** Measurement name in the result of that experiment (kind "measurement" only). */
	measurement?: string;
	/** s_db and mu: the Touchstone file, by its path or the end of its path; optional when the experiment has one. */
	touchstone?: string;
	/** s_db: [i, j], the entry S_ij, ports from 1. */
	entry?: [number, number];
	/** s_db and mu: the band [f_lo, f_hi] in Hz. Each data point in it is checked; [f, f] checks one data point. */
	band_hz?: [number, number];
	/** mu: the RF stage that the 2-port describes (for the stability gate). */
	stage?: string;
	/** sweep: the column of the sweep table (an output with the role "sweep"). */
	column?: string;
	/** sweep: the reducer (min, max, crossing with level and direction, compression with db). */
	reduce?: ReducerSpec;
	/** sweep: the sweep table, by its path or the end of its path; optional when the experiment has one. */
	table?: string;
	/** The ids of the assumptions that the row depends on (see "assumptions" of the file). */
	assumptions?: string[];
	/** Expected unit. A measurement with a different unit is not compared. */
	unit?: string;
	op: "<=" | ">=" | "between";
	/** One limit for all conditions, or one limit per condition name. */
	limit: Limit | Record<string, Limit>;
	/** The conditions of the rows. Without conditions, the requirement has one row and its experiment runs once. */
	conditions?: string[];
}

export interface ExperimentTemplate {
	adapter: string;
	operation: string;
	/** Adapter inputs. In each string, "{condition}" is replaced with the condition name. */
	inputs: Record<string, unknown>;
	environment?: string;
	timeout_s?: number;
	/** Assumptions that every row of this experiment depends on. */
	assumptions?: string[];
}

export interface RequirementsFile {
	schema: typeof REQUIREMENTS_SCHEMA;
	/** Each condition adds its inputs to the experiment inputs (a condition input replaces an input of the same name). */
	conditions: Record<string, { description?: string; inputs?: Record<string, unknown>; assumptions?: string[] }>;
	experiments: Record<string, ExperimentTemplate>;
	requirements: Requirement[];
	assumptions?: Record<string, Assumption>;
	gates?: { stability?: StabilityGate; connections?: ConnectionsGate };
}

/**
 * Row status. "not_run": no usable experiment (not selected, or the experiment did not complete).
 * "not_measured": the experiment completed, but the value is missing or has a different unit.
 */
export type RowStatus = "pass" | "fail" | "not_measured" | "not_run";

export interface VerdictRow {
	requirement: string;
	/** null: the requirement has no conditions. */
	condition: string | null;
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
	/** The sweep point of the value, when it is the worst point of a sweep (for example {"vcm": 0.4}). */
	at: Record<string, number> | null;
	/** The assumptions that the row depends on (of the requirement, its experiment and its condition); absent when none. */
	assumptions?: string[];
	/** A gate row: the gate ("stability") and the requirements that cover it. */
	gate?: { name: string; stage: string; covered_by: string[] };
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
	/** Each experiment of the check, with its error and warning diagnostics (for example a design error with its file and line). */
	experiments: { id: string; experiment: string; condition: string | null; status: ExecutionStatus; diagnostics: Diagnostic[] }[];
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
	/** Number of experiments that run at the same time (default 4; 1 runs them one at a time). */
	parallel?: number;
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

const FIELDS = ["schema", "conditions", "experiments", "requirements", "assumptions", "gates"];
/** An old file had a top-level design section. Its check would be lost without a message, so the field is an error. */
const DESIGN_MIGRATION =
	"design: this field is not supported. Put the design check in experiments (adapter ngspice, operation check_design, " +
	"with the inputs of the design section, and without limits.area_um2 and limits.gate_area_um2), and add requirements " +
	"without conditions on its measurements design_errors (<= 0) and area_um2";

/** Every problem in the file, so that the author can fix them all at once. An empty list means valid. */
export function validateRequirements(file: RequirementsFile): string[] {
	const errors: string[] = [];
	if (file.schema !== REQUIREMENTS_SCHEMA) errors.push(`schema is ${String(file.schema)}, expected ${REQUIREMENTS_SCHEMA}`);
	for (const k of Object.keys(file)) {
		if (!FIELDS.includes(k)) errors.push(k === "design" ? DESIGN_MIGRATION : `${k}: unknown field; the fields are ${FIELDS.join(", ")}`);
	}
	const conditions = file.conditions ?? {};
	const experiments = file.experiments ?? {};
	const assumptions = file.assumptions ?? {};
	for (const [id, a] of Object.entries(assumptions)) {
		if (!/^[\w.-]+$/.test(id)) errors.push(`assumption "${id}": an id has letters, digits, "_", "." and "-" only`);
		if (!a || typeof a.description !== "string" || !a.description) errors.push(`assumption "${id}": description is required`);
	}
	const cites = (where: string, list: unknown) => {
		if (list === undefined) return;
		if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) errors.push(`${where}: assumptions must be a list of assumption ids`);
		else for (const a of list) if (!assumptions[a]) errors.push(`${where}: assumption "${a}" is not defined in assumptions`);
	};
	for (const [name, e] of Object.entries(experiments)) {
		if (!e.adapter || !e.operation) errors.push(`experiment "${name}": adapter and operation are required`);
		cites(`experiment "${name}"`, e.assumptions);
	}
	for (const [name, c] of Object.entries(conditions)) cites(`condition "${name}"`, c?.assumptions);
	const gate = file.gates?.stability;
	for (const k of Object.keys(file.gates ?? {})) if (k !== "stability" && k !== "connections") errors.push(`gates.${k}: unknown gate; the gates are stability and connections`);
	const cg = file.gates?.connections;
	if (cg !== undefined && !(cg && typeof cg.table === "string" && typeof cg.block === "string" && typeof cg.interface === "string")) {
		errors.push("gates.connections: table, block and interface (paths relative to the design root, and the block name) are required");
	}
	if (gate) {
		if (!Array.isArray(gate.stages) || !gate.stages.length || !gate.stages.every((x) => typeof x === "string" && x)) errors.push("gates.stability: stages must list the active RF stages");
		if (!Array.isArray(gate.conditions) || !gate.conditions.length) errors.push("gates.stability: conditions must list the corners of the gate");
		else for (const c of gate.conditions) if (!conditions[c]) errors.push(`gates.stability: condition "${c}" is not defined`);
		const b = gate.band_hz;
		if (b !== undefined && !(Array.isArray(b) && b.length === 2 && b.every(isNumber) && b[0] >= 0 && b[0] < b[1])) errors.push("gates.stability: band_hz must be [f_lo, f_hi] in Hz");
	}
	if (!Array.isArray(file.requirements) || (file.requirements.length === 0 && !file.gates?.connections)) {
		errors.push("requirements: give at least one requirement (or a connection gate)");
		return errors;
	}
	const ids = new Set<string>();
	for (const r of file.requirements) {
		const where = `requirement "${r.id}"`;
		if (!r.id) errors.push("a requirement has no id");
		if (ids.has(r.id)) errors.push(`${where}: the id is used more than once`);
		ids.add(r.id);
		if (!experiments[r.experiment]) errors.push(`${where}: experiment "${r.experiment}" is not defined`);
		const kind = r.kind ?? "measurement";
		if (!REQUIREMENT_KINDS.includes(kind)) errors.push(`${where}: kind is ${String(kind)}, expected ${REQUIREMENT_KINDS.join(", ")}`);
		if (kind === "measurement" && !r.measurement) errors.push(`${where}: measurement is required`);
		cites(where, r.assumptions);
		if (r.stage !== undefined && (kind !== "mu" || typeof r.stage !== "string")) errors.push(`${where}: stage is for kind mu (the name of an RF stage)`);
		if (kind === "sweep") {
			if (r.measurement !== undefined) errors.push(`${where}: kind sweep reads a sweep table; remove measurement`);
			if (typeof r.column !== "string" || !r.column) errors.push(`${where}: kind sweep needs column (a column of the sweep table)`);
			const e = reducerError(r.reduce);
			if (e) errors.push(`${where}: ${e}`);
			if (r.table !== undefined && typeof r.table !== "string") errors.push(`${where}: table must be a path`);
			if (r.band_hz !== undefined || r.touchstone !== undefined || r.entry !== undefined) errors.push(`${where}: band_hz, touchstone and entry are for the kinds s_db and mu`);
		} else if (r.column !== undefined || r.reduce !== undefined || r.table !== undefined) errors.push(`${where}: column, reduce and table are for kind sweep`);
		if (kind === "s_db" || kind === "mu") {
			if (r.measurement !== undefined) errors.push(`${where}: kind ${kind} computes its value from a Touchstone file; remove measurement`);
			const band = r.band_hz;
			if (!(Array.isArray(band) && band.length === 2 && band.every(isNumber) && band[0] >= 0 && band[0] <= band[1])) {
				errors.push(`${where}: kind ${kind} needs band_hz [f_lo, f_hi] in Hz with 0 <= f_lo <= f_hi`);
			}
			if (r.touchstone !== undefined && typeof r.touchstone !== "string") errors.push(`${where}: touchstone must be a path`);
		}
		if (kind === "s_db") {
			const e = r.entry;
			if (!(Array.isArray(e) && e.length === 2 && e.every((x) => Number.isInteger(x) && x >= 1))) errors.push(`${where}: kind s_db needs entry [i, j] (ports from 1)`);
			if (r.unit !== undefined && r.unit !== "dB") errors.push(`${where}: the unit of kind s_db is dB`);
		} else if (r.entry !== undefined) errors.push(`${where}: entry is only for kind s_db`);
		if (kind === "mu" && r.unit !== undefined) errors.push(`${where}: kind mu has no unit`);
		if (kind === "measurement" && (r.band_hz !== undefined || r.touchstone !== undefined)) {
			errors.push(`${where}: band_hz and touchstone are for the kinds s_db and mu`);
		}
		if (!["<=", ">=", "between"].includes(r.op)) errors.push(`${where}: op is ${String(r.op)}, expected <=, >= or between`);
		if (r.conditions === undefined) {
			if (!validLimit(r.op, r.limit)) errors.push(`${where}: no valid limit for op ${r.op}`);
			if (experiments[r.experiment] && JSON.stringify(experiments[r.experiment].inputs ?? {}).includes("{condition}")) {
				errors.push(`${where}: experiment "${r.experiment}" uses {condition}, so the requirement needs conditions`);
			}
			continue;
		}
		if (!Array.isArray(r.conditions) || r.conditions.length === 0) {
			errors.push(`${where}: give at least one condition, or no conditions field`);
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

function limitFor(r: Requirement, condition: string | null): Limit | undefined {
	if (isNumber(r.limit) || Array.isArray(r.limit)) return r.limit;
	return condition === null ? undefined : (r.limit as Record<string, Limit> | undefined)?.[condition];
}

function substitute(value: unknown, condition: string): unknown {
	if (typeof value === "string") return value.replaceAll("{condition}", condition);
	if (Array.isArray(value)) return value.map((v) => substitute(v, condition));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, condition)]));
	}
	return value;
}

/** The inputs of one experiment at one condition (null: the template inputs only). */
export function experimentInputs(file: RequirementsFile, experiment: string, condition: string | null): Record<string, unknown> {
	if (condition === null) return { ...file.experiments[experiment].inputs };
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

/** The name of the value of a row: the measurement, or for a Touchstone kind, for example "S21 dB" or "mu". */
export function rowMeasurement(r: Requirement): string {
	if (r.kind === "s_db") return `S${r.entry?.join("") ?? ""} dB`;
	if (r.kind === "mu") return "mu";
	if (r.kind === "sweep") return `${r.column ?? ""} ${r.reduce?.kind ?? ""}`;
	return r.measurement ?? "";
}

/**
 * The values of a Touchstone kind at the data points in band_hz, from the Touchstone file of the run, or the reason why
 * there are none. The file must still have the hash of the record, and the data must cover the band.
 */
function touchstoneValues(r: Requirement, run: { id: string; result: ResultRecord }, root: string | undefined): { values: { value: number; f: number }[] } | { reason: string } {
	const files = [...run.result.outputs, ...(run.result.input_files?.files ?? [])].filter(isTouchstoneEntry);
	const chosen = r.touchstone ? files.filter((f) => f.path === r.touchstone || f.path.endsWith(`/${r.touchstone}`)) : files;
	if (chosen.length === 0) return { reason: `experiment ${run.id} has no Touchstone file${r.touchstone ? ` ${r.touchstone}` : ""}` };
	if (chosen.length > 1) return { reason: `experiment ${run.id} has ${chosen.length} Touchstone files; name one in touchstone` };
	if (root === undefined) return { reason: "the design root is not known" };
	const file = chosen[0];
	const path = resolve(root, file.path);
	let data: ReturnType<typeof readTouchstone>;
	try {
		if (sha256File(path) !== file.sha256) return { reason: `${file.path} changed after experiment ${run.id}` };
		data = readTouchstone(path);
	} catch (e) {
		return { reason: `${file.path}: ${(e as Error).message}` };
	}
	const [lo, hi] = r.band_hz as [number, number];
	const fmin = data.f[0];
	const fmax = data.f[data.f.length - 1];
	if (lo < fmin * (1 - 1e-9) || hi > fmax * (1 + 1e-9)) {
		return { reason: `${file.path} covers ${fmin} to ${fmax} Hz; the band ${lo} to ${hi} Hz is not inside it` };
	}
	const ks = data.f.map((f, k) => [f, k]).filter(([f]) => f >= lo * (1 - 1e-9) && f <= hi * (1 + 1e-9));
	if (!ks.length) return { reason: `${file.path} has no data point in ${lo} to ${hi} Hz` };
	if (r.kind === "mu") {
		if (data.nports !== 2) return { reason: `mu needs a 2-port; ${file.path} has ${data.nports} ports` };
		return { values: ks.map(([f, k]) => ({ value: stabilityMu(data, k), f })) };
	}
	const [i, j] = r.entry as [number, number];
	if (i > data.nports || j > data.nports) return { reason: `${file.path} has ${data.nports} ports; there is no S${i}${j}` };
	return { values: ks.map(([f, k]) => ({ value: sDb(data, k, i, j), f })) };
}

/** The points of a column of the sweep table of the run (role "sweep": {sweep, columns, rows}), or the reason why there
 * are none. The table must still have the hash of the record. */
function sweepPoints(r: Requirement, run: { id: string; result: ResultRecord }, root: string | undefined): { sweep: string; points: SweepPoint[] } | { reason: string } {
	const files = run.result.outputs.filter((f) => f.role === "sweep");
	const chosen = r.table ? files.filter((f) => f.path === r.table || f.path.endsWith(`/${r.table}`)) : files;
	if (chosen.length === 0) return { reason: `experiment ${run.id} has no sweep table${r.table ? ` ${r.table}` : ""}` };
	if (chosen.length > 1) return { reason: `experiment ${run.id} has ${chosen.length} sweep tables; name one in table` };
	if (root === undefined) return { reason: "the design root is not known" };
	const file = chosen[0];
	const path = resolve(root, file.path);
	let table: { sweep: string; columns: string[]; rows: Record<string, number | null>[] };
	try {
		if (sha256File(path) !== file.sha256) return { reason: `${file.path} changed after experiment ${run.id}` };
		table = readJson(path);
	} catch (e) {
		return { reason: `${file.path}: ${(e as Error).message}` };
	}
	const column = r.column as string;
	if (!table.columns?.includes(column)) return { reason: `${file.path} has no column ${column}; the columns are ${(table.columns ?? []).join(", ")}` };
	const points = table.rows.map((row) => ({ x: row[table.sweep] as number, y: isNumber(row[column]) ? (row[column] as number) : null }));
	return { sweep: table.sweep, points };
}

/** The assumptions of a row: of the requirement, its experiment and its condition, without repeats. */
export function rowAssumptions(file: RequirementsFile, r: Requirement, condition: string | null): string[] {
	const all = [...(r.assumptions ?? []), ...(file.experiments[r.experiment]?.assumptions ?? []), ...(condition ? (file.conditions[condition]?.assumptions ?? []) : [])];
	return [...new Set(all)];
}

/** One row from the result of the experiment that measured it (null: not run). root: the design root, for the kinds
 * that read a Touchstone file. */
export function evaluateRow(
	r: Requirement,
	condition: string | null,
	run: { id: string; result: ResultRecord } | null,
	notRunReason: string,
	root?: string,
): VerdictRow {
	const limit = limitFor(r, condition) as Limit;
	const row: VerdictRow = {
		requirement: r.id,
		condition,
		measurement: rowMeasurement(r),
		op: r.op,
		limit,
		value: null,
		unit: r.unit ?? null,
		margin: null,
		margin_rel: null,
		status: "not_run",
		experiment: run?.id ?? null,
		reason: null,
		at: null,
	};
	if (!run) return { ...row, reason: notRunReason };
	if (run.result.status !== "completed") {
		return { ...row, reason: `experiment ${run.id} ended with status ${run.result.status}` };
	}
	if (r.kind === "sweep") {
		const got = sweepPoints(r, run, root);
		if ("reason" in got) return { ...row, status: "not_measured", reason: got.reason };
		const reduced = reduceSweep(got.points, r.reduce as ReducerSpec);
		if (reduced.status !== "measured") return { ...row, status: "not_measured", reason: `${r.column} ${r.reduce?.kind}: ${reduced.status} (${reduced.reason})` };
		const value = reduced.value as number;
		return { ...row, value, ...compare(r.op, limit, value), status: compare(r.op, limit, value).margin >= 0 ? "pass" : "fail", at: reduced.at === null ? null : { [got.sweep]: reduced.at } };
	}
	if (r.kind === "s_db" || r.kind === "mu") {
		const got = touchstoneValues(r, run, root);
		if ("reason" in got) return { ...row, status: "not_measured", reason: got.reason };
		// The worst data point decides: the smallest value for >=, the largest for <=, the nearer side for between.
		const lowest = got.values.reduce((a, b) => (b.value < a.value ? b : a));
		const highest = got.values.reduce((a, b) => (b.value > a.value ? b : a));
		const picks = r.op === ">=" ? [lowest] : r.op === "<=" ? [highest] : [lowest, highest];
		const scored = picks.map((p) => ({ p, ...compare(r.op, limit, p.value) }));
		const worst = scored.reduce((a, b) => (b.margin < a.margin ? b : a));
		return {
			...row,
			value: worst.p.value,
			unit: r.kind === "s_db" ? "dB" : null,
			margin: worst.margin,
			margin_rel: worst.margin_rel,
			status: worst.margin >= 0 ? "pass" : "fail",
			at: { f_hz: worst.p.f },
		};
	}
	const measurements = run.result.measurements;
	const valid = (m: Measurement | undefined): m is Measurement & { value: number } =>
		!!m && m.status === "measured" && isNumber(m.value);
	// A sweep gives <measurement>.min and .max. The row uses the worst point: .min for >=, .max for <=, both for
	// between. The sweep comes before a scalar of the same name, which a bench can print at each point (the last wins).
	const meas = r.measurement as string;
	const sweep = `${meas}.min` in measurements || `${meas}.max` in measurements;
	const names = !sweep ? [meas] : r.op === ">=" ? [`${meas}.min`] : r.op === "<=" ? [`${meas}.max`] : [`${meas}.min`, `${meas}.max`];
	for (const name of names) {
		const m = measurements[name];
		if (!valid(m)) return { ...row, status: "not_measured", reason: `experiment ${run.id} gave no value for ${name}` };
		if (r.unit && m.unit && r.unit !== m.unit) {
			return { ...row, value: m.value, unit: m.unit, status: "not_measured", reason: `unit is ${m.unit}, the requirement expects ${r.unit}` };
		}
	}
	// The entry with the smallest margin decides the row ("between": the side nearer to its limit).
	const scored = names.map((name) => ({ m: measurements[name], ...compare(r.op, limit, measurements[name].value as number) }));
	const worst = scored.reduce((a, b) => (b.margin < a.margin ? b : a));
	return {
		...row,
		value: worst.m.value,
		unit: worst.m.unit ?? r.unit ?? null,
		margin: worst.margin,
		margin_rel: worst.margin_rel,
		status: worst.margin >= 0 ? "pass" : "fail",
		at: sweep ? (worst.m.at ?? null) : null,
	};
}

const rank: Record<RowStatus, number> = { fail: 0, not_run: 1, not_measured: 2, pass: 3 };

/** The rows of the connection gate: one per item of the block against the connection table (connections.ts). */
export function connectionGateRows(file: RequirementsFile, root: string): VerdictRow[] {
	const gate = file.gates?.connections;
	if (!gate) return [];
	let rows: ConnectionRow[];
	try {
		rows = connectionGate(root, gate.table, gate.block, gate.interface);
	} catch (e) {
		rows = [{ item: "table", status: "not_run", expected: null, got: null, unit: null, reason: (e as Error).message }];
	}
	return rows.map((r) => {
		const numeric = typeof r.got === "number" && (typeof r.expected === "number" || Array.isArray(r.expected));
		return {
			requirement: `gate connections ${gate.block}`,
			condition: null,
			measurement: r.item,
			op: numeric && Array.isArray(r.expected) ? "between" : ">=",
			limit: numeric ? (r.expected as Limit) : 1,
			value: numeric ? (r.got as number) : r.status === "pass" ? 1 : r.status === "fail" ? 0 : null,
			unit: r.unit,
			margin: null,
			margin_rel: null,
			status: r.status,
			experiment: null,
			reason: r.reason,
			at: null,
			gate: { name: "connections", stage: gate.block, covered_by: [] },
		} as VerdictRow;
	});
}

/**
 * The rows of the stability gate: one per stage and condition of the gate. A gate row takes the worst of the mu rows of
 * its stage and condition whose band contains the gate band, with op >= and a limit of at least 1. Without such a row,
 * the gate row is not run: the block cannot pass without the record.
 */
export function stabilityGateRows(file: RequirementsFile, rows: VerdictRow[]): VerdictRow[] {
	const gate = file.gates?.stability;
	if (!gate) return [];
	const band = gate.band_hz ?? STABILITY_BAND_HZ;
	const out: VerdictRow[] = [];
	for (const stage of gate.stages) {
		for (const c of gate.conditions) {
			const covering = file.requirements.filter((r) => {
				if (r.kind !== "mu" || r.stage !== stage || r.op !== ">=" || !r.band_hz) return false;
				if (r.band_hz[0] > band[0] || r.band_hz[1] < band[1]) return false;
				const conds = r.conditions ?? [null];
				const limit = limitFor(r, conds.includes(c) ? c : null);
				return conds.includes(c) && isNumber(limit) && limit >= 1;
			});
			const found = rows.filter((row) => covering.some((r) => r.id === row.requirement) && row.condition === c);
			const base: VerdictRow = {
				requirement: `gate stability ${stage}`,
				condition: c,
				measurement: "mu",
				op: ">=",
				limit: 1,
				value: null,
				unit: null,
				margin: null,
				margin_rel: null,
				status: "not_run",
				experiment: null,
				reason: `no mu requirement of stage ${stage} with op >= and a limit of at least 1 covers ${band[0]} to ${band[1]} Hz at condition ${c}`,
				at: null,
				gate: { name: "stability", stage, covered_by: covering.map((r) => r.id) },
			};
			if (!found.length) {
				out.push(base);
				continue;
			}
			const worst = found.reduce((a, b) => (rank[b.status] < rank[a.status] || (b.status === a.status && (b.margin ?? 0) < (a.margin ?? 0)) ? b : a));
			out.push({ ...base, value: worst.value, limit: worst.limit, margin: worst.margin, margin_rel: worst.margin_rel, status: worst.status, experiment: worst.experiment, at: worst.at, reason: `from requirement ${worst.requirement}${worst.reason ? `: ${worst.reason}` : ""}` });
		}
	}
	return out;
}

export interface AssumptionUse {
	assumption: string;
	definition: Assumption | null;
	/** The requirements that depend on it, and through what (the requirement itself, its experiment or a condition). */
	requirements: { id: string; via: string[]; conditions: (string | null)[] }[];
}

/** For each assumption (or the one given), every requirement and condition that depends on it. */
export function assumptionUses(file: RequirementsFile, id?: string): AssumptionUse[] {
	const ids = id === undefined ? Object.keys(file.assumptions ?? {}) : [id];
	return ids.map((a) => {
		const requirements: AssumptionUse["requirements"] = [];
		for (const r of file.requirements) {
			const via: string[] = [];
			if (r.assumptions?.includes(a)) via.push("requirement");
			if (file.experiments[r.experiment]?.assumptions?.includes(a)) via.push(`experiment ${r.experiment}`);
			const all = r.conditions ?? [null];
			const byCondition = all.filter((c) => c !== null && file.conditions[c]?.assumptions?.includes(a));
			for (const c of byCondition) via.push(`condition ${c}`);
			if (!via.length) continue;
			const conditions = via.some((v) => !v.startsWith("condition ")) ? all : byCondition;
			requirements.push({ id: r.id, via, conditions });
		}
		return { assumption: a, definition: file.assumptions?.[a] ?? null, requirements };
	});
}

/** The newest verdict of the design root (by its id, which starts with the time), or null. */
export function latestVerdict(root: string): VerdictRecord | null {
	const dir = checksDir(root);
	if (!existsSync(dir)) return null;
	const ids = readdirSync(dir).filter((d) => existsSync(join(dir, d, "verdict.json"))).sort();
	return ids.length ? readJson<VerdictRecord>(join(dir, ids[ids.length - 1], "verdict.json")) : null;
}

export function loadRequirements(root: string, file = REQUIREMENTS_FILE): { path: string; file: RequirementsFile } {
	const path = resolve(root, file);
	if (!existsSync(path)) throw new Error(`requirements file not found: ${relative(root, path) || path}`);
	const parsed = readJson<RequirementsFile>(path);
	const errors = validateRequirements(parsed);
	if (errors.length) throw new Error(`invalid requirements file ${relative(root, path)}:\n- ${errors.join("\n- ")}`);
	return { path, file: parsed };
}

/** Run the experiments that the selected rows need, a few at a time (opts.parallel), and write the verdict. */
export async function runCheck(opts: CheckOptions): Promise<{ id: string; dir: string; verdict: VerdictRecord }> {
	const root = resolve(opts.root);
	const { path, file } = loadRequirements(root, opts.file);
	const known = new Set(file.requirements.map((r) => r.id));
	for (const id of opts.requirements ?? []) if (!known.has(id)) throw new Error(`requirement "${id}" is not defined`);
	for (const c of opts.conditions ?? []) if (!file.conditions[c]) throw new Error(`condition "${c}" is not defined`);

	// A selection of conditions keeps the rows without a condition.
	const selected = (r: Requirement, c: string | null) =>
		(!opts.requirements || opts.requirements.includes(r.id)) && (c === null || !opts.conditions || opts.conditions.includes(c));
	const conditionsOf = (r: Requirement) => r.conditions ?? [null];
	const key = (experiment: string, condition: string | null) => JSON.stringify([experiment, condition]);

	// One experiment per (experiment, condition) pair, shared by all requirements that read it.
	const pairs = new Map<string, { experiment: string; condition: string | null }>();
	for (const r of file.requirements) {
		for (const c of conditionsOf(r)) if (selected(r, c)) pairs.set(key(r.experiment, c), { experiment: r.experiment, condition: c });
	}

	const id = newExperimentId();
	const runs = new Map<string, { id: string; result: ResultRecord }>();
	const list = [...pairs];
	const done: (VerdictRecord["experiments"][number] | null)[] = list.map(() => null);
	const jobs = list.map(([pair, { experiment, condition }], i) => async () => {
		const t = file.experiments[experiment];
		const outcome = await runExperiment({
			root,
			adapter: t.adapter,
			operation: t.operation,
			inputs: experimentInputs(file, experiment, condition),
			environment: t.environment,
			timeoutS: t.timeout_s,
			purpose: `check ${id}: ${experiment}${condition === null ? "" : ` at ${condition}`}`,
			signal: opts.signal,
		});
		runs.set(pair, { id: outcome.id, result: outcome.result });
		const diagnostics = outcome.result.diagnostics.filter((d) => d.severity !== "info");
		done[i] = { id: outcome.id, experiment, condition, status: outcome.result.status, diagnostics };
	});
	// A few workers take the jobs in order. After an abort, no worker starts a new run.
	let next = 0;
	const worker = async () => {
		while (next < jobs.length && !opts.signal?.aborted) await jobs[next++]();
	};
	const parallel = isNumber(opts.parallel) ? Math.max(1, Math.floor(opts.parallel)) : 4;
	await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
	// The experiments in the order of the pairs, as in a run one at a time.
	const experiments = done.filter((e) => e !== null);

	const rows: VerdictRow[] = [];
	for (const r of file.requirements) {
		for (const c of conditionsOf(r)) {
			// A row that is not selected stays not run, also when a selected row shares its experiment.
			const run = selected(r, c) ? (runs.get(key(r.experiment, c)) ?? null) : null;
			const row = evaluateRow(r, c, run, selected(r, c) ? "the check was cancelled before this experiment" : NOT_SELECTED, root);
			const cited = rowAssumptions(file, r, c);
			rows.push(cited.length ? { ...row, assumptions: cited } : row);
		}
	}
	rows.push(...stabilityGateRows(file, rows));
	rows.push(...connectionGateRows(file, root));
	const counts: Record<RowStatus, number> = { pass: 0, fail: 0, not_measured: 0, not_run: 0 };
	for (const row of rows) counts[row.status]++;
	// A selection is never a pass, also when it happens to include every row.
	const partial = opts.requirements !== undefined || opts.conditions !== undefined;

	const verdict: VerdictRecord = {
		schema: VERDICT_SCHEMA,
		id,
		created_at: new Date().toISOString(),
		status: counts.fail > 0 ? "fail" : counts.pass === rows.length && !partial ? "pass" : "incomplete",
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
