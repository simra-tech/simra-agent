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
import { type Analysis, checkNetlist, fitBandFindings, fittedModels, type InstanceParamClass, type NetlistRules } from "./netlist.ts";
import { designTechnologyDirs, findPack } from "./packs.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
export type RequirementKind = "measurement" | "s_db" | "mu" | "sweep" | "monte_carlo";
export const REQUIREMENT_KINDS: RequirementKind[] = ["measurement", "s_db", "mu", "sweep", "monte_carlo"];

/**
 * monte_carlo: a statistic of a measurement over the seeds of a Monte Carlo table (output role "monte_carlo", for
 * example work/mc.json of the ngspice operation monte_carlo). "mean_abs_k_sigma" is |mean| + k sigma, the usual offset
 * row; sigma is the sample standard deviation (n - 1). A seed without a value makes the row not measured: a seed
 * without a DC point is never dropped.
 */
export type McStatistic = "mean" | "sigma" | "min" | "max" | "abs_max" | "mean_abs_k_sigma" | "mean_plus_k_sigma" | "mean_minus_k_sigma";
export const MC_STATISTICS: McStatistic[] = ["mean", "sigma", "min", "max", "abs_max", "mean_abs_k_sigma", "mean_plus_k_sigma", "mean_minus_k_sigma"];
/** The fewest seeds of a monte_carlo row, unless the requirement gives min_seeds. */
export const MC_MIN_SEEDS = 30;

/** The stability gate: every listed stage needs a mu requirement over the band at every listed condition. */
/** The connection gate: the block interface record of a block against the connection table (see connections.ts). */
export interface ConnectionsGate {
	/** The connection table, relative to the design root. */
	table: string;
	block: string;
	/** The block interface record, relative to the design root. */
	interface: string;
}

/**
 * The operating-limit gate: for each experiment (default: every ngspice simulate and xyce hb experiment that a requirement
 * cites) and each condition of its rows, the check runs the ngspice operation device_limits with the same deck, libs,
 * params and temperature, or for an hb experiment the xyce operation hb_limits with all its inputs (cycle means and
 * peak voltages under the drive). The limits come from the technology pack (each with its PDK source, or an assumption) and extra_limits.
 * tran gives a transient per experiment for the peak values. A run without a result makes its gate row not run.
 */
export interface LimitsGate {
	experiments?: string[];
	technology?: string;
	tran?: Record<string, { step_s: number; stop_s: number; start_s?: number; dc?: "op" | "mean" }>;
	/** Limits of the design (for example a minimum VCE); each cites an assumption of the file or gives a source. */
	extra_limits?: { id: string; class: string; quantity: string; op: "<=" | ">="; limit: number; models?: string; source?: string; assumption?: string; description?: string; limit_source?: LimitSource }[];
	/** Another value of a limit at the peak only (ngspice device_limits with tran), each with an assumption id. */
	peak_overrides?: { id: string; limit: number; assumption: string; description?: string }[];
}

/**
 * The device-check gate: each device of the list runs alone in ngspice and in Xyce (xyce adapter, operation
 * device_crosscheck) at each condition of the gate, and a difference of the DC currents or of the y-parameters above
 * the tolerance fails its row. The model libraries of each simulator come from the inputs of the named experiments.
 * The instance settings that the netlist gate requires (gates.netlist.require_params) go to the ngspice device.
 */
export interface DeviceCheckGate {
	/** An experiment of the file that runs in ngspice, and one that runs in Xyce: their libs (and temp_c) are used. */
	ngspice_experiment: string;
	xyce_experiment: string;
	conditions: string[];
	devices: { name: string; cell: string; params?: Record<string, number>; pins: string[]; bias_v: [number, number]; ngspice_params?: Record<string, number>; xyce_params?: Record<string, number> }[];
	freqs_hz: number[];
	tolerance?: { dc_rel?: number; y_rel?: number };
	/** The temperature at which the two model cards are expected to agree (default 27). At a condition with another
	 * temperature the check runs both; a difference only at the temperature of the condition is a finding in the reason
	 * of the row, not a failure. */
	reference_temp_c?: number;
	environment?: string;
}

/**
 * The required-corner gate: the corners (conditions) that the block must pass. Each requirement of the gate needs a
 * result at each required corner. Without one, its gate row is not run: a pass at another corner (for example the
 * typical corner) does not cover a required corner, and a required corner is never left out of the verdict.
 */
export interface CornersGate {
	/** The required corners: names of conditions of the file. */
	required: string[];
	/** The requirements of the gate (default: every requirement that has conditions). */
	requirements?: string[];
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
	/**
	 * Measurement name in the result of that experiment (kind "measurement" only). "{condition}" is replaced with the
	 * condition name, for an experiment that gives one measurement per corner (for example "setup_ws_ns@{condition}").
	 */
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
	/** monte_carlo: the statistic over the seeds, k (default 3) for the k-sigma statistics, and the fewest seeds (default 30). */
	statistic?: McStatistic;
	k?: number;
	min_seeds?: number;
	/** The ids of the assumptions that the row depends on (see "assumptions" of the file). */
	assumptions?: string[];
	/** Expected unit. A measurement with a different unit is not compared. */
	unit?: string;
	op: "<=" | ">=" | "between";
	/** One limit for all conditions, or one limit per condition name. */
	limit: Limit | Record<string, Limit>;
	/** The conditions of the rows. Without conditions, the requirement has one row and its experiment runs once. */
	conditions?: string[];
	/** Where the limit comes from (see LimitSource). */
	limit_source?: LimitSource;
	/**
	 * Conditions at which the value is measured and reported, not scored: the check runs the experiment there and
	 * writes the row (status from the limit, as information) to verdict.reported, not to rows. A reported row does
	 * not change the status of the check or meets_spec. reason says why the row is not scored there.
	 */
	reported?: { conditions: string[]; reason: string };
}

/**
 * Where a limit comes from: a row of the specification, a PDK document, a value set from the reference design (after
 * a reference run: the reference passes it by construction), or a choice of the task author. ref names the row,
 * document or reason.
 */
export interface LimitSource {
	kind: "specification" | "pdk" | "reference_design" | "task";
	ref: string;
}
export const LIMIT_SOURCE_KINDS: LimitSource["kind"][] = ["specification", "pdk", "reference_design", "task"];

function validLimitSource(x: unknown): boolean {
	const s = x as LimitSource | undefined;
	return Boolean(s && LIMIT_SOURCE_KINDS.includes(s.kind) && typeof s.ref === "string" && s.ref.length > 0);
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
	/**
	 * Each condition adds its inputs to the experiment inputs (a condition input replaces an input of the same name).
	 * experiment_inputs.<experiment> adds inputs for one experiment only, after inputs (for example the model libraries
	 * of a second simulator).
	 */
	conditions: Record<string, { description?: string; inputs?: Record<string, unknown>; experiment_inputs?: Record<string, Record<string, unknown>>; assumptions?: string[] }>;
	experiments: Record<string, ExperimentTemplate>;
	requirements: Requirement[];
	assumptions?: Record<string, Assumption>;
	gates?: { stability?: StabilityGate; connections?: ConnectionsGate; limits?: LimitsGate; netlist?: NetlistRules; device_check?: DeviceCheckGate; corners?: CornersGate };
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
	/** The design file of the netlist gate (gates.netlist.file) with its hash at the start of the check, or null. */
	design_file?: { path: string; sha256: string } | null;
	simra: { kernel_version: string };
	/** Each experiment of the check, with its error and warning diagnostics (for example a design error with its file and line). */
	experiments: { id: string; experiment: string; condition: string | null; status: ExecutionStatus; diagnostics: Diagnostic[] }[];
	rows: VerdictRow[];
	/** Rows that are reported and not scored (Requirement.reported); absent when the file has none. */
	reported?: (VerdictRow & { reported_reason: string })[];
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
	for (const [name, c] of Object.entries(conditions)) {
		cites(`condition "${name}"`, c?.assumptions);
		for (const e of Object.keys(c?.experiment_inputs ?? {})) if (!experiments[e]) errors.push(`condition "${name}": experiment_inputs.${e}: experiment "${e}" is not defined`);
	}
	const gate = file.gates?.stability;
	for (const k of Object.keys(file.gates ?? {})) if (!["stability", "connections", "limits", "netlist", "device_check", "corners"].includes(k)) errors.push(`gates.${k}: unknown gate; the gates are stability, connections, limits, netlist, device_check and corners`);
	if (file.gates && "corners" in file.gates) {
		const cg = file.gates.corners;
		if (!cg || typeof cg !== "object" || Array.isArray(cg)) errors.push("gates.corners: must be an object with required (the corners that the block must pass)");
		else {
			for (const k of Object.keys(cg)) if (!["required", "requirements"].includes(k)) errors.push(`gates.corners.${k}: unknown field; the fields are required and requirements`);
			if (!Array.isArray(cg.required) || !cg.required.length || !cg.required.every((x) => typeof x === "string" && x)) errors.push("gates.corners: required must list the corners that the block must pass (names of conditions)");
			else {
				for (const c of cg.required) if (!conditions[c]) errors.push(`gates.corners: required corner "${c}" is not defined in conditions`);
				if (new Set(cg.required).size !== cg.required.length) errors.push("gates.corners: a required corner is listed more than once");
			}
			if (cg.requirements !== undefined) {
				if (!Array.isArray(cg.requirements) || !cg.requirements.length || !cg.requirements.every((x) => typeof x === "string" && x)) errors.push("gates.corners: requirements must list requirement ids (or leave the field out: every requirement that has conditions)");
				else for (const id of cg.requirements) if (!(Array.isArray(file.requirements) ? file.requirements : []).some((r) => r?.id === id)) errors.push(`gates.corners: requirement "${id}" is not defined`);
			} else if (Array.isArray(file.requirements) && !file.requirements.some((r) => r?.conditions !== undefined)) {
				errors.push("gates.corners: no requirement has conditions, so the gate has no requirement. Give the requirements their conditions, or name them in gates.corners.requirements");
			}
		}
	}
	const dg = file.gates?.device_check;
	if (file.gates && "device_check" in file.gates) {
		if (!dg || typeof dg !== "object") errors.push("gates.device_check: must be an object");
		else {
			for (const k of ["ngspice_experiment", "xyce_experiment"] as const) if (!experiments[dg[k]]) errors.push(`gates.device_check.${k}: experiment "${dg[k]}" is not defined`);
			if (!Array.isArray(dg.conditions) || !dg.conditions.length) errors.push("gates.device_check: conditions must list the conditions of the gate");
			else for (const c of dg.conditions) if (!conditions[c]) errors.push(`gates.device_check: condition "${c}" is not defined`);
			if (!Array.isArray(dg.freqs_hz) || !dg.freqs_hz.length || !dg.freqs_hz.every((x) => isNumber(x) && x > 0)) errors.push("gates.device_check: freqs_hz must list the frequencies in Hz");
			if (!Array.isArray(dg.devices) || !dg.devices.length) errors.push("gates.device_check: devices must list at least one device");
			else
				for (const d of dg.devices) {
					if (!d || typeof d.name !== "string" || typeof d.cell !== "string" || !Array.isArray(d.pins) || !Array.isArray(d.bias_v) || d.bias_v.length !== 2 || !d.bias_v.every(isNumber))
						errors.push(`gates.device_check.devices "${d?.name}": name, cell, pins and bias_v [V of port 1, V of port 2] are required`);
				}
		}
	}
	const ng = file.gates?.netlist;
	if (ng !== undefined) {
		if (!ng || typeof ng.file !== "string" || typeof ng.subckt !== "string" || !Array.isArray(ng.pins) || !Array.isArray(ng.devices))
			errors.push("gates.netlist: file, subckt, pins and devices are required");
		if (ng && ng.fit_checks !== undefined) {
			if (!Array.isArray(ng.fit_checks)) errors.push("gates.netlist.fit_checks: must be a list");
			else
				for (const [i, fc] of ng.fit_checks.entries()) {
					if (!fc || !["q", "re_z"].includes(fc.kind) || !Array.isArray(fc.band_hz) || fc.band_hz.length !== 2 || !fc.band_hz.every((x) => isNumber(x) && x > 0) || fc.band_hz[0] > fc.band_hz[1] || !isNumber(fc.tol_rel_max) || fc.tol_rel_max <= 0)
						errors.push(`gates.netlist.fit_checks[${i}]: kind ("q" or "re_z"), band_hz [low, high] and tol_rel_max (> 0) are required`);
				}
		}
		else if (ng.devices.length && typeof ng.technology !== "string") errors.push("gates.netlist: technology (the pack name) is required with devices: the pack gives the instance parameters of each device class");
	}
	const lg = file.gates?.limits;
	if (lg !== undefined) {
		if (!lg || typeof lg !== "object") errors.push("gates.limits: must be an object");
		else {
			for (const e of lg.experiments ?? []) if (!experiments[e]) errors.push(`gates.limits: experiment "${e}" is not defined`);
			for (const [e, t] of Object.entries(lg.tran ?? {})) {
				if (!experiments[e]) errors.push(`gates.limits.tran: experiment "${e}" is not defined`);
				if (!(t && isNumber(t.step_s) && isNumber(t.stop_s) && t.step_s > 0 && t.step_s < t.stop_s && (t.start_s === undefined || (isNumber(t.start_s) && t.start_s >= 0 && t.start_s < t.stop_s)))) {
					errors.push(`gates.limits.tran.${e}: give step_s < stop_s (and start_s < stop_s) in seconds`);
				}
				if (t && t.dc !== undefined && !["op", "mean"].includes(t.dc)) errors.push(`gates.limits.tran.${e}: dc is "op" or "mean"`);
			}
			for (const o of lg.peak_overrides ?? []) {
				if (!o?.id || !isNumber(o.limit) || typeof o.assumption !== "string") errors.push(`gates.limits.peak_overrides "${o?.id}": id, limit and assumption are required`);
				else if (!file.assumptions?.[o.assumption]) errors.push(`gates.limits.peak_overrides "${o.id}": assumption "${o.assumption}" is not defined`);
			}
			for (const l of lg.extra_limits ?? []) {
				const w = `gates.limits.extra_limits "${l?.id}"`;
				if (!l?.id || !l.class || !l.quantity || !["<=", ">="].includes(l.op) || !isNumber(l.limit)) errors.push(`${w}: id, class, quantity, op (<= or >=) and limit are required`);
				if (!l?.source && !l?.assumption) errors.push(`${w}: give a source or an assumption`);
				if (l?.assumption && !assumptions[l.assumption]) errors.push(`${w}: assumption "${l.assumption}" is not defined in assumptions`);
				if (l?.limit_source !== undefined && !validLimitSource(l.limit_source)) errors.push(`${w}: limit_source needs kind (${LIMIT_SOURCE_KINDS.join(", ")}) and ref`);
			}
		}
	}
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
		if ((kind === "measurement" || kind === "monte_carlo") && !r.measurement) errors.push(`${where}: measurement is required`);
		if (kind === "monte_carlo") {
			if (!MC_STATISTICS.includes(r.statistic as McStatistic)) errors.push(`${where}: kind monte_carlo needs statistic (${MC_STATISTICS.join(", ")})`);
			if (r.k !== undefined && !(isNumber(r.k) && r.k > 0)) errors.push(`${where}: k must be a positive number`);
			if (r.min_seeds !== undefined && !(Number.isInteger(r.min_seeds) && r.min_seeds >= 2)) errors.push(`${where}: min_seeds must be an integer of at least 2`);
		} else if (r.statistic !== undefined || r.k !== undefined || r.min_seeds !== undefined) errors.push(`${where}: statistic, k and min_seeds are for kind monte_carlo`);
		cites(where, r.assumptions);
		if (r.limit_source !== undefined && !validLimitSource(r.limit_source)) errors.push(`${where}: limit_source needs kind (${LIMIT_SOURCE_KINDS.join(", ")}) and ref`);
		if (r.stage !== undefined && (kind !== "mu" || typeof r.stage !== "string")) errors.push(`${where}: stage is for kind mu (the name of an RF stage)`);
		if (kind === "sweep") {
			if (r.measurement !== undefined) errors.push(`${where}: kind sweep reads a sweep table; remove measurement`);
			if (typeof r.column !== "string" || !r.column) errors.push(`${where}: kind sweep needs column (a column of the sweep table)`);
			const e = reducerError(r.reduce);
			if (e) errors.push(`${where}: ${e}`);
			if (r.table !== undefined && typeof r.table !== "string") errors.push(`${where}: table must be a path`);
			if (r.band_hz !== undefined || r.touchstone !== undefined || r.entry !== undefined) errors.push(`${where}: band_hz, touchstone and entry are for the kinds s_db and mu`);
		} else if (r.column !== undefined || r.reduce !== undefined || (r.table !== undefined && kind !== "monte_carlo")) errors.push(`${where}: column, reduce and table are for kind sweep`);
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
			if (typeof r.measurement === "string" && r.measurement.includes("{condition}")) errors.push(`${where}: measurement uses {condition}, so the requirement needs conditions`);
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
		if (r.reported !== undefined) {
			const rp = r.reported;
			if (!rp || !Array.isArray(rp.conditions) || !rp.conditions.length || typeof rp.reason !== "string" || !rp.reason) {
				errors.push(`${where}: reported needs conditions (at least one) and a reason`);
			} else {
				for (const c of rp.conditions) {
					if (!conditions[c]) errors.push(`${where}: reported condition "${c}" is not defined`);
					else if (r.conditions.includes(c)) errors.push(`${where}: condition "${c}" is both scored and reported`);
					else if (!validLimit(r.op, limitFor(r, c))) errors.push(`${where}: no valid limit for op ${r.op} at reported condition "${c}"`);
				}
			}
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
	const c = file.conditions[condition];
	const merged = { ...file.experiments[experiment].inputs, ...(c.inputs ?? {}), ...(c.experiment_inputs?.[experiment] ?? {}) };
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
	if (r.kind === "monte_carlo") return `${r.measurement ?? ""} ${r.statistic === "mean_abs_k_sigma" ? `|mean|+${r.k ?? 3}sigma` : r.statistic === "mean_plus_k_sigma" ? `mean+${r.k ?? 3}sigma` : r.statistic === "mean_minus_k_sigma" ? `mean-${r.k ?? 3}sigma` : (r.statistic ?? "")}`;
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

interface McTable {
	measurements: Record<string, string | null>;
	seeds: { seed: number; status: string; dc: string; values: Record<string, number | null> }[];
}

/** The statistic of a monte_carlo row from the table of the run, or the reason why there is none. */
function mcStatistic(r: Requirement, run: { id: string; result: ResultRecord }, root: string | undefined): { value: number; unit: string | null; at: Record<string, number> | null; note: string } | { reason: string } {
	const files = run.result.outputs.filter((f) => f.role === "monte_carlo");
	const chosen = r.table ? files.filter((f) => f.path === r.table || f.path.endsWith(`/${r.table}`)) : files;
	if (chosen.length !== 1) return { reason: `experiment ${run.id} has ${chosen.length} Monte Carlo tables${r.table ? ` named ${r.table}` : ""} (role monte_carlo)` };
	if (root === undefined) return { reason: "the design root is not known" };
	const path = resolve(root, chosen[0].path);
	let table: McTable;
	try {
		if (sha256File(path) !== chosen[0].sha256) return { reason: `${chosen[0].path} changed after experiment ${run.id}` };
		table = readJson(path);
	} catch (e) {
		return { reason: `${chosen[0].path}: ${(e as Error).message}` };
	}
	const name = r.measurement as string;
	if (!(name in (table.measurements ?? {}))) return { reason: `${chosen[0].path} has no measurement ${name}` };
	const missing = table.seeds.filter((s) => !isNumber(s.values?.[name]));
	if (missing.length) {
		const by = (st: string) => missing.filter((s) => s.status === st).map((s) => s.seed);
		return { reason: `${missing.length} of ${table.seeds.length} seeds have no value for ${name} (no DC point: ${by("no_dc").join(", ") || "none"}; failed: ${by("failed").join(", ") || "none"}); a seed is never dropped` };
	}
	const v = table.seeds.map((s) => ({ seed: s.seed, x: s.values[name] as number }));
	const n = v.length;
	const min = r.min_seeds ?? MC_MIN_SEEDS;
	if (n < min) return { reason: `${n} seeds, the requirement needs at least ${min}` };
	const mean = v.reduce((a, b) => a + b.x, 0) / n;
	const sigma = Math.sqrt(v.reduce((a, b) => a + (b.x - mean) ** 2, 0) / (n - 1));
	if (sigma === 0) return { reason: `${name} has the same value in all ${n} seeds: the mismatch models are not active` };
	const k = r.k ?? 3;
	const lo = v.reduce((a, b) => (b.x < a.x ? b : a));
	const hi = v.reduce((a, b) => (b.x > a.x ? b : a));
	const ab = v.reduce((a, b) => (Math.abs(b.x) > Math.abs(a.x) ? b : a));
	const stat = r.statistic as McStatistic;
	const value = { mean, sigma, min: lo.x, max: hi.x, abs_max: Math.abs(ab.x), mean_abs_k_sigma: Math.abs(mean) + k * sigma, mean_plus_k_sigma: mean + k * sigma, mean_minus_k_sigma: mean - k * sigma }[stat];
	const at = stat === "min" ? { seed: lo.seed } : stat === "max" ? { seed: hi.seed } : stat === "abs_max" ? { seed: ab.seed } : null;
	const unit = table.measurements[name] ?? null;
	const fallback = table.seeds.filter((s) => s.dc === "fallback").length;
	return { value, unit, at, note: `${n} seeds, mean ${mean.toPrecision(4)}, sigma ${sigma.toPrecision(4)}${fallback ? `, ${fallback} seeds needed the DC fallback` : ""}` };
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
	// One measurement per corner in one result: the name has the condition in it.
	if (condition !== null && typeof r.measurement === "string" && r.measurement.includes("{condition}")) r = { ...r, measurement: r.measurement.replaceAll("{condition}", condition) };
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
	if (r.kind === "monte_carlo") {
		const got = mcStatistic(r, run, root);
		if ("reason" in got) return { ...row, status: "not_measured", reason: got.reason };
		const c = compare(r.op, limit, got.value);
		return { ...row, value: got.value, unit: got.unit ?? r.unit ?? null, ...c, status: c.margin >= 0 ? "pass" : "fail", at: got.at, reason: got.note };
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

interface LimitRow {
	id: string;
	class: string;
	quantity: string;
	op: "<=" | ">=";
	limit: number;
	source: string | null;
	assumption: string | null;
	description: string | null;
	at: "dc" | "peak";
	value: number | null;
	device: string | null;
	status: "pass" | "fail" | "not_measured" | "not_applicable";
	reason: string | null;
}

/**
 * The rows of the operating-limit gate: for each device_limits run (one per experiment and condition), one row per
 * limit that applies (the worst device). A run without its limits table gives one row that is not run, so the check
 * cannot pass.
 */
export function limitsGateRows(runs: { experiment: string; condition: string | null; id: string; result: ResultRecord }[], root: string): VerdictRow[] {
	const out: VerdictRow[] = [];
	const order = [...runs].sort((a, b) => (a.experiment + (a.condition ?? "")).localeCompare(b.experiment + (b.condition ?? "")));
	for (const run of order) {
		const base = { condition: run.condition, unit: "V", margin: null, margin_rel: null, experiment: run.id, at: null, gate: { name: "limits", stage: run.experiment, covered_by: [] as string[] } };
		const file = run.result.outputs.find((f) => f.role === "device_limits");
		let table: { limits: LimitRow[] } | null = null;
		let why = run.result.status !== "completed" ? `experiment ${run.id} ended with status ${run.result.status}` : !file ? `experiment ${run.id} has no limits table` : null;
		if (!why && file) {
			try {
				const path = resolve(root, file.path);
				if (sha256File(path) !== file.sha256) why = `${file.path} changed after experiment ${run.id}`;
				else table = readJson(path);
			} catch (e) {
				why = `${file.path}: ${(e as Error).message}`;
			}
		}
		if (!table) {
			out.push({ ...base, requirement: "gate limits", measurement: `device limits @ ${run.experiment}`, op: "<=", limit: 0, value: null, status: "not_run", reason: why } as VerdictRow);
			continue;
		}
		for (const l of table.limits) {
			if (l.status === "not_applicable") continue;
			const c = l.value === null ? null : compare(l.op, l.limit, l.value);
			const note = l.source ? null : `assumed: ${l.description ?? "no PDK source"}`;
			const row: VerdictRow = {
				...base,
				requirement: `gate limits ${l.id}${l.at === "peak" ? " peak" : ""}`,
				measurement: `${l.quantity} ${l.at} @ ${run.experiment}`,
				op: l.op,
				limit: l.limit,
				value: l.value,
				unit: /^(ic|ib|id)/.test(l.quantity) ? "A" : "V",
				margin: c?.margin ?? null,
				margin_rel: c?.margin_rel ?? null,
				status: l.status,
				reason: [l.device ? `worst device ${l.device}` : null, l.reason, note].filter(Boolean).join("; ") || null,
			};
			out.push(l.assumption ? { ...row, assumptions: [l.assumption] } : row);
		}
	}
	return out;
}

/** The rows of the device-check gate: one per device and condition; the value is the number of findings. */
export function deviceCheckGateRows(runs: { device: string; condition: string; id: string | null; result: ResultRecord | null; why?: string }[]): VerdictRow[] {
	return runs.map((run) => {
		const base = { requirement: `gate device_check ${run.device}`, condition: run.condition, measurement: "findings of device_crosscheck (ngspice against Xyce)", op: "<=" as const, limit: 0, unit: null, margin: null, margin_rel: null, experiment: run.id, at: null, gate: { name: "device_check", stage: run.device, covered_by: [] as string[] } };
		const m = run.result?.status === "completed" ? run.result.measurements : null;
		const n = m?.findings?.value;
		if (!run.result || !m || !isNumber(n)) {
			return { ...base, value: null, status: "not_run", reason: run.why ?? (run.result ? `experiment ${run.id} ended with status ${run.result.status}` : "the check was cancelled before this experiment") } as VerdictRow;
		}
		const found = run.result.diagnostics.filter((d) => d.severity === "warning" && d.message.startsWith("finding: ")).map((d) => d.message.slice(9));
		const worst = `largest difference: DC ${(100 * (m.dc_rel_max?.value ?? 0)).toFixed(2)} %, y ${(100 * (m.y_rel_max?.value ?? 0)).toFixed(2)} %`;
		const atTemp = run.result.diagnostics.filter((d) => d.severity === "warning" && d.message.startsWith("temperature finding: ")).map((d) => d.message.slice(21));
		const tempNote = atTemp.length ? `; ${atTemp.length} temperature finding${atTemp.length === 1 ? "" : "s"} (the simulators agree at the reference temperature, so this is a finding and not an error): ${atTemp.slice(0, 2).join("; ")}${atTemp.length > 2 ? `; and ${atTemp.length - 2} more` : ""}` : "";
		const reason = n > 0 ? `${found.slice(0, 2).join("; ")}${found.length > 2 ? `; and ${found.length - 2} more` : ""}; the simulators do not agree for this device (see the workaround registry of the PDK)` : `${worst}${tempNote}`;
		return { ...base, value: n, margin: -n, status: n > 0 ? "fail" : "pass", reason } as VerdictRow;
	});
}

/** The rows of the connection gate: one per item of the block against the connection table (connections.ts). */
/** The instance-parameter classes of a technology pack (instance_params.<pdk>.classes), or {} when it has none. */
export function instanceParamClasses(root: string, technology: string): Record<string, InstanceParamClass> {
	const entry = findPack(designTechnologyDirs(root), technology);
	const pack = JSON.parse(readFileSync(entry.path, "utf8")) as { ngspice?: { instance_params?: Record<string, { classes?: Record<string, InstanceParamClass> }> } };
	const byPdk = pack.ngspice?.instance_params ?? {};
	const key = entry.pdks.find((p) => byPdk[p]) ?? Object.keys(byPdk)[0];
	return (key ? byPdk[key]?.classes : undefined) ?? {};
}

/** The netlist gate: one row with the number of rule errors of the design file (limit 0), and the errors in the reason. */
export function netlistGateRows(file: RequirementsFile, root: string): VerdictRow[] {
	const rules = file.gates?.netlist;
	if (!rules) return [];
	const base = { requirement: "gate netlist", condition: null, measurement: `rule errors in ${rules.file}`, op: "<=" as const, limit: 0, unit: null, at: null, experiment: null, gate: { name: "netlist", stage: rules.subckt, covered_by: [] as string[] } };
	const path = join(root, rules.file);
	if (!existsSync(path)) return [{ ...base, value: null, margin: null, margin_rel: null, status: "not_run", reason: `${rules.file} not found` }];
	let classes: Record<string, InstanceParamClass> = {};
	try {
		if (rules.technology) classes = instanceParamClasses(root, rules.technology);
	} catch (e) {
		return [{ ...base, value: null, margin: null, margin_rel: null, status: "not_run", reason: (e as Error).message }];
	}
	const fitsFound = rules.fitted ? fittedModels(root).found : [];
	const res = checkNetlist(readFileSync(path, "utf8"), rules, { classes, fits: fitsFound });
	for (const fc of rules.fit_checks ?? []) {
		const used = res.fitted_used.map((u) => fitsFound.find((m) => m.fit === u.fit && m.name === u.subckt)).filter((m) => m !== undefined);
		const ok = used.filter((m) => (m.checks ?? []).some((c) => c.kind === fc.kind && Array.isArray(c.band_hz) && c.band_hz[0] <= fc.band_hz[1] && c.band_hz[1] >= fc.band_hz[0] && c.tol_rel <= fc.tol_rel_max));
		const min = fc.min ?? 1;
		if (ok.length < min) {
			const what = fc.kind === "q" ? "Q" : "Re Z";
			res.errors.push({ line: null, message: `${ok.length} of the fitted models of ${rules.subckt} has a ${what} check from ${fc.band_hz[0] / 1e9} GHz to ${fc.band_hz[1] / 1e9} GHz with a tolerance of at most ${fc.tol_rel_max} (needed: ${min}). Give fit_to_spice the input "checks" ({name, kind "${fc.kind}", ports, band_hz, tol_rel}): the limit on max |dS| does not bound this quantity` });
		}
	}
	const n = res.errors.length;
	const shown = res.errors.slice(0, 12).map((e) => `${rules.file}${e.line ? `:${e.line}` : ""}: ${e.message}`);
	const fits = res.fitted_used.length ? `; fitted models used: ${res.fitted_used.map((x) => `${x.subckt} (fit ${x.fit}${x.em ? `, EM ${x.em}` : ""})`).join(", ")}` : "";
	return [{ ...base, value: n, margin: -n, margin_rel: null, status: n ? "fail" : "pass", reason: n ? `${shown.join("; ")}${n > 12 ? `; and ${n - 12} more` : ""}${fits}` : `no rule error${fits}` }];
}

/**
 * The fit-band gate: for each ngspice or Xyce simulate experiment of the check, each fitted model that its deck uses
 * against each analysis of the deck (netlist.ts fitBandFindings). One row per experiment and fitted model.
 */
export function fitBandGateRows(file: RequirementsFile, root: string, experiments: string[]): VerdictRow[] {
	const fits = fittedModels(root).found;
	if (!fits.length) return [];
	const rows: VerdictRow[] = [];
	for (const name of experiments) {
		const t = file.experiments[name];
		const inputs = (t?.inputs ?? {}) as { deck?: unknown; tones?: unknown; harmonics?: unknown };
		const deck = inputs.deck;
		const hb = t?.adapter === "xyce" && t.operation === "hb";
		if (!t || (t.operation !== "simulate" && !hb) || !["ngspice", "xyce"].includes(t.adapter) || typeof deck !== "string" || deck.includes("{")) continue;
		// harmonic balance: the band of the tones and their harmonics (default 25 per tone, as the xyce adapter)
		const extra: Analysis[] = [];
		if (hb) {
			const tones = Array.isArray(inputs.tones) ? inputs.tones.filter(isNumber) : [];
			const h = inputs.harmonics ?? 25;
			const hs = tones.map((_, i) => (Array.isArray(h) ? Number(h[i]) : Number(h)));
			const text = `hb tones ${tones.join(", ")} Hz, harmonics ${hs.join(", ")}`;
			extra.push({ kind: "hb", f_hz: tones.length && hs.every((x) => x >= 1) ? [Math.min(...tones), Math.max(...tones.map((f, i) => f * hs[i]))] : null, text });
		}
		for (const f of fitBandFindings(root, deck, fits, extra))
			rows.push({
				requirement: `gate fit_band ${f.subckt}`, condition: null, measurement: `band of use of fit ${f.fit} in ${deck}`, op: "<=", limit: 0,
				value: f.pass ? 0 : 1, unit: null, margin: f.pass ? 0 : -1, margin_rel: null, status: f.pass ? "pass" : "fail", experiment: null, reason: f.reason, at: null,
				gate: { name: "fit_band", stage: name, covered_by: [] },
			});
	}
	return rows;
}

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

/**
 * The rows of the required-corner gate: one per requirement of the gate and required corner. A gate row takes the
 * value and the status of the row of its requirement at that corner when that row is a pass or a fail. In every other
 * case the gate row is not run, with the reason: the requirement has no row at the corner, the corner is only
 * reported, the check did not select the row, or the row has no value. So the check cannot pass on the other corners.
 */
export function cornersGateRows(file: RequirementsFile, rows: VerdictRow[]): VerdictRow[] {
	const gate = file.gates?.corners;
	if (!gate) return [];
	const covered = gate.requirements ? file.requirements.filter((r) => gate.requirements?.includes(r.id)) : file.requirements.filter((r) => r.conditions !== undefined);
	const out: VerdictRow[] = [];
	for (const r of covered) {
		for (const c of gate.required) {
			const scored = r.conditions?.includes(c) === true;
			const row = scored ? rows.find((x) => x.requirement === r.id && x.condition === c && !x.gate) : undefined;
			const limit = limitFor(r, scored ? c : null) ?? limitFor(r, r.conditions?.[0] ?? null);
			const base: VerdictRow = {
				requirement: `gate corners ${r.id}`,
				condition: c,
				measurement: (row?.measurement ?? rowMeasurement(r)).replaceAll("{condition}", c),
				op: r.op,
				limit: (row?.limit ?? limit) as Limit,
				value: null,
				unit: row?.unit ?? r.unit ?? null,
				margin: null,
				margin_rel: null,
				status: "not_run",
				experiment: row?.experiment ?? null,
				reason: null,
				at: null,
				gate: { name: "corners", stage: r.id, covered_by: scored ? [r.id] : [] },
			};
			if (row && (row.status === "pass" || row.status === "fail")) {
				out.push({ ...base, value: row.value, margin: row.margin, margin_rel: row.margin_rel, status: row.status, at: row.at, reason: `from requirement ${r.id}${row.reason ? `: ${row.reason}` : ""}` });
			} else if (row) {
				out.push({ ...base, reason: `no result at the required corner ${c}: ${row.reason ?? `the row of requirement ${r.id} is ${row.status.replace("_", " ")}`}` });
			} else if (r.reported?.conditions?.includes(c)) {
				out.push({ ...base, reason: `requirement ${r.id} reports the required corner ${c} and does not score it (${r.reported.reason}). A reported row does not cover a required corner.` });
			} else {
				const has = r.conditions?.length ? `its conditions are ${r.conditions.join(", ")}` : "it has no conditions";
				out.push({ ...base, reason: `requirement ${r.id} has no row at the required corner ${c} (${has}). A pass at another corner does not cover it.` });
			}
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
	// The design file at the start of the check: an answer is consistent only with a check of the final file.
	const designRel = file.gates?.netlist?.file;
	const designFile = typeof designRel === "string" && existsSync(join(root, designRel)) ? { path: designRel, sha256: sha256File(join(root, designRel)) } : null;
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
	// Reported rows run their experiment too; they are added after the scored pairs, so the gates (which follow the
	// conditions of the scored rows) do not change.
	const reportedOf = (r: Requirement) => r.reported?.conditions ?? [];
	const reportedPairs = new Map<string, { experiment: string; condition: string | null }>();
	for (const r of file.requirements) {
		for (const c of reportedOf(r)) if (selected(r, c) && !pairs.has(key(r.experiment, c))) reportedPairs.set(key(r.experiment, c), { experiment: r.experiment, condition: c });
	}

	// The operating-limit gate: one device_limits run per (experiment, condition) pair of the gate.
	const lg = file.gates?.limits;
	const isHb = (e: string) => file.experiments[e]?.adapter === "xyce" && file.experiments[e]?.operation === "hb";
	const gateExperiments = lg ? (lg.experiments ?? [...new Set(file.requirements.map((r) => r.experiment))].filter((e) => (file.experiments[e]?.adapter === "ngspice" && file.experiments[e]?.operation === "simulate") || isHb(e))) : [];
	// An experiment of the gate runs at the conditions of its rows. An experiment that no selected row cites (for
	// example a DC bench for the gate only) runs at every condition of the check; before, it gave no gate row at all.
	// A row without a condition (for example an EM row) adds no condition: the DC point of a corner bench needs one.
	const named = [...new Set([...pairs.values()].map((p) => p.condition))].filter((c) => c !== null);
	const checkConditions = named.length ? named : [null];
	const limitPairs = gateExperiments.flatMap((experiment) => {
		const own = [...pairs.values()].filter((p) => p.experiment === experiment);
		return own.length ? own : checkConditions.map((condition) => ({ experiment, condition }));
	});

	const id = newExperimentId();
	const runs = new Map<string, { id: string; result: ResultRecord }>();
	const limitRuns: { experiment: string; condition: string | null; id: string; result: ResultRecord }[] = [];
	const list = [...pairs, ...reportedPairs];
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
	for (const { experiment, condition } of limitPairs) {
		jobs.push(async () => {
			const all = experimentInputs(file, experiment, condition);
			// An xyce hb experiment: the operation hb_limits runs the same harmonic balance (all its inputs) and checks the
			// cycle means and the peak voltages of each HBT under the drive. Otherwise ngspice device_limits at DC (and tran).
			const hb = isHb(experiment);
			const inputs: Record<string, unknown> = hb ? { ...all } : {};
			if (!hb) for (const k of ["deck", "libs", "params", "temp_c"]) if (all[k] !== undefined) inputs[k] = all[k];
			if (!hb && lg?.tran?.[experiment]) inputs.tran = lg.tran[experiment];
			if (lg?.extra_limits) inputs.extra_limits = lg.extra_limits;
			if (!hb && lg?.peak_overrides) inputs.peak_overrides = lg.peak_overrides;
			if (lg?.technology) inputs.technology = lg.technology;
			const t = file.experiments[experiment];
			const outcome = await runExperiment({
				root,
				adapter: hb ? "xyce" : "ngspice",
				operation: hb ? "hb_limits" : "device_limits",
				inputs,
				environment: t.environment,
				timeoutS: t.timeout_s,
				purpose: `check ${id}: gate limits ${experiment}${condition === null ? "" : ` at ${condition}`}`,
				signal: opts.signal,
			});
			limitRuns.push({ experiment, condition, id: outcome.id, result: outcome.result });
			const diagnostics = outcome.result.diagnostics.filter((d) => d.severity !== "info");
			done.push({ id: outcome.id, experiment: `gate limits ${experiment}`, condition, status: outcome.result.status, diagnostics });
		});
	}
	// The device-check gate: one device_crosscheck run per device and selected condition. A selection of requirements
	// leaves the gate out (its rows are then not run).
	const dgate = file.gates?.device_check;
	const deviceRuns: { device: string; condition: string; id: string | null; result: ResultRecord | null; why?: string }[] = [];
	for (const condition of dgate?.conditions ?? []) {
		for (const d of dgate?.devices ?? []) {
			const run: (typeof deviceRuns)[number] = { device: d.name, condition, id: null, result: null };
			deviceRuns.push(run);
			if (opts.requirements !== undefined || (opts.conditions && !opts.conditions.includes(condition))) {
				run.why = NOT_SELECTED;
				continue;
			}
			jobs.push(async () => {
				const ng = experimentInputs(file, dgate!.ngspice_experiment, condition);
				const xy = experimentInputs(file, dgate!.xyce_experiment, condition);
				const required = file.gates?.netlist?.require_params?.[d.cell.toLowerCase()] ?? {};
				const inputs: Record<string, unknown> = {
					device: { cell: d.cell, params: d.params ?? {}, pins: d.pins },
					bias_v: d.bias_v,
					freqs_hz: dgate!.freqs_hz,
					ngspice_libs: ng.libs,
					xyce_libs: xy.libs,
					ngspice_params: { ...required, ...(d.ngspice_params ?? {}) },
					...(d.xyce_params ? { xyce_params: d.xyce_params } : {}),
					...(ng.temp_c !== undefined ? { temp_c: ng.temp_c, reference_temp_c: dgate!.reference_temp_c ?? 27 } : {}),
					...(dgate!.tolerance ? { tolerance: dgate!.tolerance } : {}),
				};
				const outcome = await runExperiment({ root, adapter: "xyce", operation: "device_crosscheck", inputs, environment: dgate!.environment ?? file.experiments[dgate!.xyce_experiment].environment, purpose: `check ${id}: gate device_check ${d.name} at ${condition}`, signal: opts.signal });
				run.id = outcome.id;
				run.result = outcome.result;
				done.push({ id: outcome.id, experiment: `gate device_check ${d.name}`, condition, status: outcome.result.status, diagnostics: outcome.result.diagnostics.filter((x) => x.severity === "error") });
			});
		}
	}
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
	const reported: NonNullable<VerdictRecord["reported"]> = [];
	for (const r of file.requirements) {
		for (const c of reportedOf(r)) {
			const run = selected(r, c) ? (runs.get(key(r.experiment, c)) ?? null) : null;
			const row = evaluateRow(r, c, run, selected(r, c) ? "the check was cancelled before this experiment" : NOT_SELECTED, root);
			const cited = rowAssumptions(file, r, c);
			reported.push({ ...(cited.length ? { ...row, assumptions: cited } : row), reported_reason: r.reported!.reason });
		}
	}
	rows.push(...stabilityGateRows(file, rows));
	rows.push(...cornersGateRows(file, rows));
	rows.push(...connectionGateRows(file, root));
	rows.push(...limitsGateRows(limitRuns, root));
	rows.push(...netlistGateRows(file, root));
	rows.push(...deviceCheckGateRows(deviceRuns));
	rows.push(...fitBandGateRows(file, root, [...new Set([...pairs.values()].map((p) => p.experiment))]));
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
		design_file: designFile,
		simra: { kernel_version: KERNEL_VERSION },
		experiments,
		rows,
		...(reported.length ? { reported } : {}),
	};
	const dir = join(checksDir(root), id);
	mkdirSync(dir, { recursive: true });
	writeJsonAtomic(join(dir, "verdict.json"), verdict);
	return { id, dir, verdict };
}
