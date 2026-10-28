// Experiment and result records. They are plain JSON files in the design repository:
//
//   <root>/simra/experiments/<id>/experiment.json   what was asked (written before the run)
//   <root>/simra/experiments/<id>/result.json       what happened (written after the run)
//
// The files are the source of truth. Any tool can read them without this code.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXPERIMENT_SCHEMA = "simra.experiment/0";
export const RESULT_SCHEMA = "simra.result/0";

/** Execution status only. It says nothing about whether a requirement passed. */
export type ExecutionStatus = "completed" | "failed" | "error" | "timeout" | "cancelled";

export interface FileHash {
	path: string;
	sha256: string;
	bytes?: number;
	role?: string;
}

export interface Measurement {
	value: number | null;
	unit: string | null;
	status: "measured" | "failed" | "missing";
	source?: string;
}

export interface Diagnostic {
	severity: "error" | "warning" | "info";
	message: string;
	source?: string;
}

export interface ExperimentRecord {
	schema: typeof EXPERIMENT_SCHEMA;
	id: string;
	created_at: string;
	purpose: string | null;
	adapter: { name: string; version: string; dir: string; files: FileHash[] };
	operation: string;
	inputs: Record<string, unknown>;
	environment: Record<string, unknown>;
	design: { root: string; git_commit: string | null; git_dirty: boolean | null };
	simra: { kernel_version: string };
}

export interface ResultRecord {
	schema: typeof RESULT_SCHEMA;
	experiment: string;
	status: ExecutionStatus;
	started_at: string;
	finished_at: string;
	duration_s: number;
	exit_code: number | null;
	signal: string | null;
	/** Problems seen by the runner (for example an invalid adapter response). */
	errors: string[];
	tool: Record<string, unknown> | null;
	input_files: { files: FileHash[]; complete: boolean } | null;
	outputs: FileHash[];
	measurements: Record<string, Measurement>;
	diagnostics: Diagnostic[];
	logs: { adapter_stdout: string; adapter_stderr: string };
}

export function experimentsDir(root: string): string {
	return join(root, "simra", "experiments");
}

export function experimentDir(root: string, id: string): string {
	return join(experimentsDir(root), id);
}

/** Sortable, unique enough for one design repository: 20261028-190501-3fa2c1. */
export function newExperimentId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Write JSON through a temporary file, so a reader never sees a half-written record. */
export function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function createExperimentDir(root: string, id: string): string {
	const dir = experimentDir(root, id);
	mkdirSync(join(dir, "work"), { recursive: true });
	return dir;
}

export interface ExperimentSummary {
	id: string;
	experiment: ExperimentRecord;
	result: ResultRecord | null;
}

export function loadExperiment(root: string, id: string): ExperimentSummary {
	const dir = experimentDir(root, id);
	const experiment = readJson<ExperimentRecord>(join(dir, "experiment.json"));
	const resultPath = join(dir, "result.json");
	const result = existsSync(resultPath) ? readJson<ResultRecord>(resultPath) : null;
	return { id, experiment, result };
}

/** All experiments, oldest first. An experiment without result.json did not finish (or still runs). */
export function listExperiments(root: string): ExperimentSummary[] {
	const dir = experimentsDir(root);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => existsSync(join(dir, name, "experiment.json")))
		.sort()
		.map((id) => loadExperiment(root, id));
}
