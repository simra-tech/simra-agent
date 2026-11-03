// Local job runner. It runs one experiment to the end and writes its records.
// A blocking run ends when the adapter exits. A detached run continues in a supervisor process (see runDetachedWorker),
// and waitExperiments waits for it.
//
// Contract with the adapter (simra.adapter/0): the runner writes request.json and starts the adapter with its
// path as the only argument. The adapter writes response.json. See CONTRIBUTING.md.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createWriteStream, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import kernelPackage from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { buildInvocation } from "./environments.ts";
import {
	type CommandRun,
	createExperimentDir,
	finishStatus,
	readStatus,
	writeStatus,
	EXPERIMENT_SCHEMA,
	experimentDir,
	type ExecutionStatus,
	type ExperimentRecord,
	type FileHash,
	newExperimentId,
	RESULT_SCHEMA,
	type ResultRecord,
	readJson,
	type StatusRecord,
	writeJsonAtomic,
} from "./records.ts";
import { runtimeEstimate, type RuntimeEstimate } from "./estimate.ts";

export const CONTRACT = "simra.adapter/0";
export const KERNEL_VERSION: string = kernelPackage.version;
/** true in the simra binary: Bun embeds its modules in the virtual folder /$bunfs. */
const IN_BINARY = import.meta.url.includes("$bunfs");
/** The folder with adapters/ and technologies/: the release folder of the binary (the real path), or the repository. */
const INSTALL_DIR = IN_BINARY ? dirname(realpathSync(process.execPath)) : fileURLToPath(new URL("../../..", import.meta.url));
export const BUILTIN_ADAPTER_DIR = join(INSTALL_DIR, "adapters");
/** The technology packs (PDK data for adapters, see technologies/README.md). */
export const BUILTIN_TECHNOLOGY_DIR = join(INSTALL_DIR, "technologies");

export interface AdapterManifest {
	contract: string;
	name: string;
	version: string;
	/** Command line. "{adapter_dir}" is replaced with the adapter directory. The request path is appended. */
	command: string[];
	operations: Record<string, { description: string }>;
}

export interface RunOptions {
	root: string;
	adapter: string;
	operation: string;
	inputs: Record<string, unknown>;
	environment?: string;
	purpose?: string;
	timeoutS?: number;
	/** Blocking run only: abort stops the adapter, and the run is recorded as cancelled. */
	signal?: AbortSignal;
	/** Run the experiment in a supervisor process and return at once (status "running"). */
	detached?: boolean;
}

export interface RunOutcome {
	id: string;
	dir: string;
	experiment: ExperimentRecord;
	result: ResultRecord;
	/** The runtimes of earlier runs of the same kind (see runtimeEstimate), or null. */
	estimate: RuntimeEstimate | null;
}

/** A detached experiment just after its start. */
export interface DetachedOutcome {
	id: string;
	dir: string;
	experiment: ExperimentRecord;
	status: StatusRecord;
	estimate: RuntimeEstimate | null;
}

export function findAdapter(name: string, dirs: string[]): { dir: string; manifest: AdapterManifest } {
	for (const base of dirs) {
		const dir = join(base, name);
		const path = join(dir, "adapter.json");
		if (existsSync(path)) return { dir, manifest: readJson<AdapterManifest>(path) };
	}
	throw new Error(`adapter "${name}" not found in: ${dirs.join(", ")}`);
}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Hash every file of the adapter, so the record shows exactly which adapter code ran. */
function hashTree(dir: string): FileHash[] {
	const out: FileHash[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			if (name === "__pycache__" || name === "node_modules") continue;
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.isFile()) out.push({ path: relative(dir, p), sha256: sha256File(p), bytes: st.size });
		}
	};
	walk(dir);
	return out;
}

export function gitState(root: string): ExperimentRecord["design"] {
	const git = (args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		const commit = git(["rev-parse", "HEAD"]);
		// Records under simra/ do not count as a design change.
		const dirty = git(["status", "--porcelain", "--", ".", ":(exclude)simra"]) !== "";
		return { root, git_commit: commit, git_dirty: dirty };
	} catch {
		return { root, git_commit: null, git_dirty: null };
	}
}

/** The facts that the runner needs to run a prepared experiment: in this process, or in a detached supervisor. */
interface Job {
	root: string;
	id: string;
	command: string;
	args: string[];
	timeout_s: number;
}

const JOB_FILE = "job.json";
/** The arguments before a CLI command: none for the simra binary, the path of cli.ts for Node. */
const CLI_ARGS = IN_BINARY ? [] : [fileURLToPath(new URL("./cli.ts", import.meta.url))];

/**
 * The directories of the technology packs that the adapter searches, in order: the configured ones (technology_dirs),
 * then the built-in one. A configured directory that does not exist is an error. A path with ":" cannot be given,
 * because SIMRA_TECHNOLOGY_DIR separates the entries with ":".
 */
export function technologySearchPath(configured: string[]): string[] {
	for (const dir of configured) {
		if (!existsSync(dir)) throw new Error(`technology_dirs: directory not found: ${dir}`);
		if (dir.includes(":")) throw new Error(`technology_dirs: a path with ":" is not supported: ${dir}`);
	}
	const dirs = existsSync(BUILTIN_TECHNOLOGY_DIR) ? [...configured, BUILTIN_TECHNOLOGY_DIR] : [...configured];
	return [...new Set(dirs)];
}

/** Check the options, make the experiment directory, and write experiment.json and request.json. */
function prepareExperiment(opts: RunOptions): { job: Job; env: NodeJS.ProcessEnv; dir: string; experiment: ExperimentRecord } {
	const root = resolve(opts.root);
	const config = loadConfig(root);
	const envName = opts.environment ?? "local";
	const envConfig = config.environments[envName];
	if (!envConfig) {
		throw new Error(`environment "${envName}" is not defined. Known: ${Object.keys(config.environments).join(", ")}`);
	}
	const { dir: adapterDir, manifest } = findAdapter(opts.adapter, [...(config.adapter_dirs ?? []), BUILTIN_ADAPTER_DIR]);
	if (manifest.contract !== CONTRACT) {
		throw new Error(`adapter "${opts.adapter}" uses contract ${manifest.contract}; this kernel supports ${CONTRACT}`);
	}
	if (!manifest.operations[opts.operation]) {
		throw new Error(
			`adapter "${opts.adapter}" has no operation "${opts.operation}". Known: ${Object.keys(manifest.operations).join(", ")}`,
		);
	}

	const id = newExperimentId();
	const dir = experimentDir(root, id);
	const requestPath = join(dir, "request.json");
	const responsePath = join(dir, "response.json");
	const adapterCommand = [...manifest.command.map((part) => part.replaceAll("{adapter_dir}", adapterDir)), requestPath];
	// Build the invocation first: a configuration error must not leave an empty experiment behind.
	const technologyDirs = technologySearchPath(config.technology_dirs ?? []);
	const invocation = buildInvocation({ name: envName, config: envConfig, root, adapterDir, adapterCommand, experimentId: id, technologyDirs });
	createExperimentDir(root, id);

	const experiment: ExperimentRecord = {
		schema: EXPERIMENT_SCHEMA,
		id,
		created_at: new Date().toISOString(),
		purpose: opts.purpose ?? null,
		adapter: { name: manifest.name, version: manifest.version, dir: adapterDir, files: hashTree(adapterDir) },
		operation: opts.operation,
		inputs: opts.inputs,
		environment: invocation.record,
		design: gitState(root),
		simra: { kernel_version: KERNEL_VERSION },
	};
	writeJsonAtomic(join(dir, "experiment.json"), experiment);
	writeJsonAtomic(requestPath, {
		contract: CONTRACT,
		experiment: id,
		adapter: manifest.name,
		operation: opts.operation,
		inputs: opts.inputs,
		root,
		work_dir: join(dir, "work"),
		response_path: responsePath,
	});
	const job = { root, id, command: invocation.command, args: invocation.args, timeout_s: opts.timeoutS ?? 3600 };
	return { job, env: invocation.env, dir, experiment };
}

/** Run the adapter of a prepared experiment to the end and write result.json and the final status.json. */
async function executeJob(job: Job, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ResultRecord> {
	const { root, id } = job;
	const dir = experimentDir(root, id);
	const responsePath = join(dir, "response.json");
	const started = new Date();
	const stdoutPath = join(dir, "adapter.stdout.log");
	const stderrPath = join(dir, "adapter.stderr.log");
	const exit = await spawnAndWait(job.command, job.args, {
		cwd: root,
		env,
		stdoutPath,
		stderrPath,
		timeoutS: job.timeout_s,
		signal,
	});
	const finished = new Date();

	const result: ResultRecord = {
		schema: RESULT_SCHEMA,
		experiment: id,
		status: "error",
		started_at: started.toISOString(),
		finished_at: finished.toISOString(),
		duration_s: (finished.getTime() - started.getTime()) / 1000,
		exit_code: exit.code,
		signal: exit.signal,
		errors: [],
		tool: null,
		input_files: null,
		outputs: [],
		measurements: {},
		diagnostics: [],
		logs: { adapter_stdout: relative(root, stdoutPath), adapter_stderr: relative(root, stderrPath) },
	};

	if (exit.spawnError) result.errors.push(`could not start the adapter: ${exit.spawnError}`);
	if (exit.timedOut) {
		result.status = "timeout";
		result.errors.push(`the adapter did not finish in ${job.timeout_s} s and was stopped`);
	} else if (exit.cancelled) {
		result.status = "cancelled";
		result.errors.push("the run was cancelled");
	} else if (!existsSync(responsePath)) {
		result.errors.push(`the adapter wrote no response (exit code ${exit.code}); see ${result.logs.adapter_stderr}`);
	} else {
		applyResponse(result, responsePath, exit.code);
	}

	writeJsonAtomic(join(dir, "result.json"), result);
	finishStatus(root, id, result);
	return result;
}

export function runExperiment(opts: RunOptions & { detached: true }): Promise<DetachedOutcome>;
export function runExperiment(opts: RunOptions & { detached?: false }): Promise<RunOutcome>;
export function runExperiment(opts: RunOptions): Promise<RunOutcome | DetachedOutcome>;
/**
 * Run one experiment. By default the call waits until the run ends. With detached: true, a supervisor process runs
 * the experiment, and the call returns at once with the status "running". The supervisor writes result.json as the
 * blocking run does; waitExperiments waits for it.
 */
export async function runExperiment(opts: RunOptions): Promise<RunOutcome | DetachedOutcome> {
	const { job, env, dir, experiment } = prepareExperiment(opts);
	const { root, id } = job;
	const estimate = runtimeEstimate(root, experiment);
	if (opts.detached) {
		// The job file has no environment variables: the supervisor gets them from its process environment.
		writeJsonAtomic(join(dir, JOB_FILE), job);
		const out = openSync(join(dir, "supervisor.stdout.log"), "w");
		const err = openSync(join(dir, "supervisor.stderr.log"), "w");
		try {
			const child = spawn(process.execPath, [...CLI_ARGS, "run", "--detached-worker", dir], {
				cwd: root,
				env,
				detached: true,
				stdio: ["ignore", out, err],
			});
			// A start error without a pid is thrown here; a later error is seen by the next wait (no process).
			child.on("error", () => {});
			if (child.pid === undefined) throw new Error("could not start the supervisor process");
			child.unref();
			const status = writeStatus(root, id, { status: "running", detached: true, pid: child.pid, started_at: new Date().toISOString() });
			return { id, dir, experiment, status, estimate };
		} finally {
			closeSync(out);
			closeSync(err);
		}
	}
	writeStatus(root, id, { status: "running", detached: false, pid: process.pid, started_at: new Date().toISOString() });
	const result = await executeJob(job, env, opts.signal);
	return { id, dir, experiment, result, estimate };
}

/**
 * The supervisor of a detached experiment (simra run --detached-worker <dir>). It runs the job of the directory to
 * the end. SIGTERM or SIGINT stops the adapter, and the run is recorded as cancelled.
 */
export async function runDetachedWorker(dir: string): Promise<ResultRecord> {
	const job = readJson<Job>(join(resolve(dir), JOB_FILE));
	const status = readStatus(job.root, job.id);
	writeStatus(job.root, job.id, { status: "running", detached: true, pid: process.pid, started_at: status?.started_at ?? new Date().toISOString() });
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		return await executeJob(job, process.env, controller.signal);
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}

export interface QueryOutcome {
	status: ExecutionStatus;
	errors: string[];
	measurements: ResultRecord["measurements"];
	diagnostics: ResultRecord["diagnostics"];
}

/**
 * Run an adapter operation that only reads files (for example a netlist check) on this host, and return its response.
 * It writes no experiment record: use runExperiment for a simulation.
 */
export async function queryAdapter(opts: Omit<RunOptions, "environment" | "purpose">): Promise<QueryOutcome> {
	const root = resolve(opts.root);
	const config = loadConfig(root);
	const { dir: adapterDir, manifest } = findAdapter(opts.adapter, [...(config.adapter_dirs ?? []), BUILTIN_ADAPTER_DIR]);
	if (!manifest.operations[opts.operation]) {
		throw new Error(`adapter "${opts.adapter}" has no operation "${opts.operation}"`);
	}
	const dir = mkdtempSync(join(tmpdir(), "simra-query-"));
	try {
		const requestPath = join(dir, "request.json");
		const responsePath = join(dir, "response.json");
		writeJsonAtomic(requestPath, {
			contract: CONTRACT,
			experiment: null,
			adapter: manifest.name,
			operation: opts.operation,
			inputs: opts.inputs,
			root,
			work_dir: dir,
			response_path: responsePath,
		});
		const command = manifest.command.map((part) => part.replaceAll("{adapter_dir}", adapterDir));
		const exit = await spawnAndWait(command[0], [...command.slice(1), requestPath], {
			cwd: root,
			env: process.env,
			stdoutPath: join(dir, "adapter.stdout.log"),
			stderrPath: join(dir, "adapter.stderr.log"),
			timeoutS: opts.timeoutS ?? 60,
			signal: opts.signal,
		});
		const result: ResponseFields = { status: "error", errors: [], tool: null, input_files: null, outputs: [], measurements: {}, diagnostics: [] };
		if (exit.spawnError) result.errors.push(`could not start the adapter: ${exit.spawnError}`);
		else if (exit.timedOut || exit.cancelled) result.errors.push("the adapter was stopped");
		else if (!existsSync(responsePath)) result.errors.push(`the adapter wrote no response (exit code ${exit.code})`);
		else applyResponse(result, responsePath, exit.code);
		return { status: result.status, errors: result.errors, measurements: result.measurements, diagnostics: result.diagnostics };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

type ResponseFields = Pick<ResultRecord, "status" | "errors" | "tool" | "commands" | "input_files" | "outputs" | "measurements" | "diagnostics" | "report">;

/** Copy a valid adapter response into the result. An invalid response makes the status "error". */
function applyResponse(result: ResponseFields, responsePath: string, exitCode: number | null): void {
	let response: Record<string, unknown>;
	try {
		response = readJson<Record<string, unknown>>(responsePath);
	} catch (e) {
		result.errors.push(`response.json is not valid JSON: ${(e as Error).message}`);
		return;
	}
	if (response.contract !== CONTRACT) {
		result.errors.push(`response.json has contract ${String(response.contract)}, expected ${CONTRACT}`);
		return;
	}
	if (response.status !== "completed" && response.status !== "failed") {
		result.errors.push(`response.json has status ${String(response.status)}, expected "completed" or "failed"`);
		return;
	}
	if (exitCode !== 0) {
		result.errors.push(`the adapter exited with code ${exitCode}; the contract requires 0 after a valid response`);
		return;
	}
	result.status = response.status as ExecutionStatus;
	result.tool = (response.tool as Record<string, unknown>) ?? null;
	if (Array.isArray(response.commands)) result.commands = response.commands as CommandRun[];
	result.input_files = (response.input_files as ResultRecord["input_files"]) ?? null;
	result.outputs = (response.outputs as FileHash[]) ?? [];
	result.measurements = (response.measurements as ResultRecord["measurements"]) ?? {};
	result.diagnostics = (response.diagnostics as ResultRecord["diagnostics"]) ?? [];
	if (Array.isArray(response.report)) result.report = response.report.map((line) => String(line));
}

interface SpawnResult {
	code: number | null;
	signal: string | null;
	timedOut: boolean;
	cancelled: boolean;
	spawnError: string | null;
}

function spawnAndWait(
	command: string,
	args: string[],
	o: { cwd: string; env: NodeJS.ProcessEnv; stdoutPath: string; stderrPath: string; timeoutS: number; signal?: AbortSignal },
): Promise<SpawnResult> {
	return new Promise((resolvePromise) => {
		const out = createWriteStream(o.stdoutPath);
		const err = createWriteStream(o.stderrPath);
		const state: SpawnResult = { code: null, signal: null, timedOut: false, cancelled: false, spawnError: null };
		const child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.pipe(out);
		child.stderr.pipe(err);

		const stop = () => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
		};
		const timer = setTimeout(() => {
			state.timedOut = true;
			stop();
		}, o.timeoutS * 1000);
		const onAbort = () => {
			state.cancelled = true;
			stop();
		};
		o.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (e) => {
			state.spawnError = e.message;
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			o.signal?.removeEventListener("abort", onAbort);
			state.code = code;
			state.signal = signal;
			let pending = 2;
			const done = () => --pending === 0 && resolvePromise(state);
			out.end(done);
			err.end(done);
		});
	});
}
