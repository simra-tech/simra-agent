// Local job runner. It runs one experiment to the end and writes its records.
// A blocking run ends when the adapter exits. A detached run continues in a supervisor process (see runDetachedWorker),
// and waitExperiments waits for it.
//
// Contract with the adapter (simra.adapter/0): the runner writes request.json and starts the adapter with its
// path as the only argument. The adapter writes response.json. See CONTRIBUTING.md.

import { telemetry } from "./telemetry.ts";
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
	loadExperiment,
	RESULT_SCHEMA,
	type ResultRecord,
	readJson,
	type StatusRecord,
	writeJsonAtomic,
} from "./records.ts";
import { runtimeEstimate, type RuntimeEstimate } from "./estimate.ts";
import { acquireHeavyLock, formatHolder, type HeavyLock, heavyQueue, isHeavyOperation } from "./heavy.ts";
import { writeInboxMarker } from "./inbox.ts";
import { type PassRuleInput, recordPassRule } from "./passrule.ts";
import { citeDecisions } from "./decisions.ts";
import { describeTouchstone, isTouchstoneEntry } from "./touchstone.ts";

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
	/** Other adapters whose code this adapter imports (their directories are mounted and named in SIMRA_ADAPTER_DIRS). */
	uses_adapters?: string[];
}

export interface RunOptions {
	root: string;
	adapter: string;
	operation: string;
	inputs: Record<string, unknown>;
	environment?: string;
	purpose?: string;
	timeoutS?: number;
	/** A CPU list ("4-7,9") that replaces the cpus of the environment for this run. */
	cpus?: string;
	/** Blocking run only: abort stops the adapter, and the run is recorded as cancelled. */
	signal?: AbortSignal;
	/** Run the experiment in a supervisor process and return at once (status "running"). */
	detached?: boolean;
	/** The rule that decides pass or fail (a text or a file). It is recorded in experiment.json before the run starts. */
	passRule?: PassRuleInput;
	/**
	 * A heavy job: it runs only while it holds the heavy-job lock of the machine, and it waits in the queue of the lock
	 * with the status "queued". Default: true when heavy_operations of the configuration names the operation.
	 */
	heavy?: boolean;
	/**
	 * The decisions that the run rests on (ids of simra/decisions, or the start or end of an id). They are recorded in
	 * experiment.json. The run does not start when a cited class A decision waits for the owner, or when the owner
	 * reversed a cited decision.
	 */
	decisions?: string[];
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
	/** The container engine, for a container environment: a stopped run also removes its container (by label). */
	engine?: string | null;
	/** true: the run waits for the heavy-job lock of the machine before the adapter starts. */
	heavy?: boolean;
	/** true: a supervisor runs the job. When it ends, the supervisor writes a marker in the inbox of the design root. */
	detached?: boolean;
	/** The sha256 of the pass rule of experiment.json, copied into result.json. */
	pass_rule_sha256?: string;
	/** The decisions that the run cites (full ids). They are checked again when the adapter is about to start. */
	decisions?: string[];
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
	const configured = config.environments[envName];
	if (!configured) {
		throw new Error(`environment "${envName}" is not defined. Known: ${Object.keys(config.environments).join(", ")}`);
	}
	if (opts.cpus !== undefined) parseCpuList(opts.cpus);
	const envConfig = opts.cpus === undefined ? configured : { ...configured, cpus: opts.cpus };
	const { dir: adapterDir, manifest } = findAdapter(opts.adapter, [...(config.adapter_dirs ?? []), BUILTIN_ADAPTER_DIR]);
	if (manifest.contract !== CONTRACT) {
		throw new Error(`adapter "${opts.adapter}" uses contract ${manifest.contract}; this kernel supports ${CONTRACT}`);
	}
	if (!manifest.operations[opts.operation]) {
		throw new Error(
			`adapter "${opts.adapter}" has no operation "${opts.operation}". Known: ${Object.keys(manifest.operations).join(", ")}`,
		);
	}

	const heavy = opts.heavy ?? isHeavyOperation(config.heavy_operations, opts.adapter, opts.operation);
	// The pass rule is checked and hashed before the experiment directory exists: a rule that cannot be read stops the run.
	const passRule = opts.passRule === undefined ? undefined : recordPassRule(root, opts.passRule);
	// The cited decisions are checked before the experiment directory exists: a class A decision that waits stops the run.
	const decisions = opts.decisions === undefined || (Array.isArray(opts.decisions) && opts.decisions.length === 0) ? undefined : citeDecisions(root, opts.decisions);
	const id = newExperimentId();
	const dir = experimentDir(root, id);
	const requestPath = join(dir, "request.json");
	const responsePath = join(dir, "response.json");
	const adapterCommand = [...manifest.command.map((part) => part.replaceAll("{adapter_dir}", adapterDir)), requestPath];
	// Build the invocation first: a configuration error must not leave an empty experiment behind.
	const technologyDirs = technologySearchPath(config.technology_dirs ?? []);
	const usedAdapterDirs = Object.fromEntries((manifest.uses_adapters ?? []).map((n) => [n, findAdapter(n, [...(config.adapter_dirs ?? []), BUILTIN_ADAPTER_DIR]).dir]));
	const invocation = buildInvocation({ name: envName, config: envConfig, root, adapterDir, adapterCommand, experimentId: id, technologyDirs, usedAdapterDirs });
	createExperimentDir(root, id);

	const experiment: ExperimentRecord = {
		schema: EXPERIMENT_SCHEMA,
		id,
		created_at: new Date().toISOString(),
		purpose: opts.purpose ?? null,
		adapter: { name: manifest.name, version: manifest.version, dir: adapterDir, files: hashTree(adapterDir), ...(Object.keys(usedAdapterDirs).length ? { uses: Object.fromEntries(Object.entries(usedAdapterDirs).map(([n, d]) => [n, { dir: d, files: hashTree(d) }])) } : {}) },
		operation: opts.operation,
		inputs: opts.inputs,
		environment: invocation.record,
		design: gitState(root),
		simra: { kernel_version: KERNEL_VERSION },
		...(passRule ? { pass_rule: passRule } : {}),
		...(heavy ? { heavy: true } : {}),
		...(decisions ? { decisions } : {}),
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
	const engine = invocation.record.kind === "container" ? (invocation.record as { engine: string }).engine : null;
	const job: Job = { root, id, command: invocation.command, args: invocation.args, timeout_s: opts.timeoutS ?? 3600, engine };
	if (heavy) job.heavy = true;
	if (opts.detached) job.detached = true;
	if (passRule) job.pass_rule_sha256 = passRule.sha256;
	if (decisions) job.decisions = decisions;
	return { job, env: invocation.env, dir, experiment };
}

/** Run the adapter of a prepared experiment to the end and write result.json and the final status.json. */
async function executeJob(job: Job, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ResultRecord> {
	const { root, id } = job;
	const dir = experimentDir(root, id);
	const responsePath = join(dir, "response.json");
	const stdoutPath = join(dir, "adapter.stdout.log");
	const stderrPath = join(dir, "adapter.stderr.log");
	// A heavy job waits for the heavy-job lock of the machine, with the status "queued". The watchdog of the run
	// (timeout_s) starts when the adapter starts.
	let lock: HeavyLock | null = null;
	let cancelledInQueue = false;
	if (job.heavy) {
		const queuedAt = new Date().toISOString();
		const queued = (holder: string) => {
			const old = readStatus(root, id);
			writeStatus(root, id, { status: "queued", detached: old?.detached ?? job.detached === true, pid: process.pid, started_at: old?.started_at ?? queuedAt, waiting_for: holder });
		};
		lock = await acquireHeavyLock({ experiment: id, root, signal, onWait: queued });
		if (lock) {
			const old = readStatus(root, id);
			writeStatus(root, id, { status: "running", detached: old?.detached ?? job.detached === true, pid: process.pid, started_at: old?.started_at ?? queuedAt });
		} else cancelledInQueue = true;
	}
	// The cited decisions are checked again when the adapter is about to start: the owner can answer while the run
	// waits in the queue. A decision that the owner reversed stops the run here.
	let refused: string | null = null;
	if (!cancelledInQueue && job.decisions?.length) {
		try {
			citeDecisions(root, job.decisions);
		} catch (e) {
			refused = `the adapter did not start: ${(e as Error).message.replace(/^the run did not start: /, "")}`;
		}
	}
	const started = new Date();
	let exit: SpawnResult;
	let containerLeft = false;
	try {
		exit = cancelledInQueue
			? { code: null, signal: null, timedOut: false, cancelled: true, spawnError: null }
			: refused !== null
				? { code: null, signal: null, timedOut: false, cancelled: false, spawnError: null }
				: await spawnAndWait(job.command, job.args, { cwd: root, env, stdoutPath, stderrPath, timeoutS: job.timeout_s, signal, onSpawn: (pid) => lock?.track({ pid, engine: job.engine ?? undefined }) });
		// A stopped engine client can leave its container running: remove the container of this experiment by its label.
		// A heavy job keeps the lock until this is done.
		// When the removal fails, the state of the container is not known: the lock is not given back (see heavy.ts).
		if ((exit.timedOut || exit.cancelled) && job.engine) containerLeft = !removeContainers(job.engine, id);
	} finally {
		lock?.release({ jobMayRun: containerLeft });
	}
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
	if (job.pass_rule_sha256) result.pass_rule_sha256 = job.pass_rule_sha256;
	if (lock) result.queued_s = lock.waited_s;

	if (exit.spawnError) result.errors.push(`could not start the adapter: ${exit.spawnError}`);
	if (exit.timedOut) {
		result.status = "timeout";
		result.errors.push(`the adapter did not finish in ${job.timeout_s} s and was stopped`);
	} else if (exit.cancelled) {
		result.status = "cancelled";
		result.errors.push(cancelledInQueue ? "the run was cancelled while it waited for the heavy-job lock: the adapter did not start" : "the run was cancelled");
	}
	if (containerLeft) {
		result.errors.push(`the container engine ${job.engine} did not answer: the check that the container of this run is gone did not run${lock ? "; the heavy-job lock stays until the engine reports no container with the label of this experiment" : ""}`);
	}
	if (exit.timedOut || exit.cancelled) {
		// the status and its message are set above
	} else if (refused !== null) {
		result.errors.push(refused);
	} else if (!existsSync(responsePath)) {
		result.errors.push(`the adapter wrote no response (exit code ${exit.code}); see ${result.logs.adapter_stderr}`);
	} else {
		applyResponse(result, responsePath, exit.code);
		annotateTouchstone(root, result);
	}

	// The inbox marker of a detached run is written before result.json: a wait that reads the result removes it.
	if (job.detached) {
		try {
			let experiment: ExperimentRecord | null = null;
			try {
				experiment = loadExperiment(root, id).experiment;
			} catch {}
			writeInboxMarker(root, id, result, experiment);
		} catch {
			// The marker is a notice; a write error must not lose the result.
		}
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
	const start = Date.now();
	const properties = { adapter: opts.adapter, operation: opts.operation, execution_mode: opts.detached ? "detached" : "blocking" };
	telemetry.capture("experiment_started", properties);
	try {
		const outcome = await runExperimentImpl(opts);
		if ("result" in outcome) telemetry.capture("experiment_completed", { ...properties, status: outcome.result.status, duration_ms: Date.now() - start });
		return outcome;
	} catch (error) {
		telemetry.capture("experiment_completed", { ...properties, status: "error", duration_ms: Date.now() - start });
		throw error;
	}
}

async function runExperimentImpl(opts: RunOptions): Promise<RunOutcome | DetachedOutcome> {
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
			// A heavy job starts as "queued": its supervisor sets "running" when it holds the heavy-job lock.
			const status = writeStatus(root, id, { status: job.heavy ? "queued" : "running", detached: true, pid: child.pid, started_at: new Date().toISOString(), ...(job.heavy ? { waiting_for: formatHolder(heavyQueue().holder) } : {}) });
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
	writeStatus(job.root, job.id, { status: job.heavy ? "queued" : "running", detached: true, pid: process.pid, started_at: status?.started_at ?? new Date().toISOString(), ...(job.heavy && status?.waiting_for ? { waiting_for: status.waiting_for } : {}) });
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		const start = Date.now();
		const result = await executeJob(job, process.env, controller.signal);
		if (telemetry.enabled()) {
			try {
				const { experiment } = loadExperiment(job.root, job.id);
				telemetry.capture("experiment_completed", { adapter: experiment.adapter.name, operation: experiment.operation, execution_mode: "detached", status: result.status, duration_ms: Date.now() - start });
			} catch {
				// Optional analytics metadata must never prevent or fail the actual job.
			}
		}
		return result;
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

/**
 * Add the summary of each Touchstone file (input or output) to its entry. The kernel reads the file itself, and only
 * when its hash is still the hash that the adapter recorded.
 */
export function annotateTouchstone(root: string, result: Pick<ResultRecord, "input_files" | "outputs">): void {
	for (const f of [...(result.input_files?.files ?? []), ...result.outputs]) {
		if (!f || typeof f.path !== "string" || !isTouchstoneEntry(f)) continue;
		const path = resolve(root, f.path);
		try {
			if (sha256File(path) !== f.sha256) {
				f.touchstone = { error: "the file changed after the adapter hashed it" };
				continue;
			}
		} catch {
			f.touchstone = { error: "file not found" };
			continue;
		}
		f.touchstone = describeTouchstone(path);
	}
}

/**
 * Remove the containers with the label simra.experiment=<id>. It never throws. It returns true when the engine
 * answered and no such container is left, false when a command of the engine failed (the state is not known).
 */
export function removeContainers(engine: string, id: string): boolean {
	try {
		const ids = execFileSync(engine, ["ps", "-q", "--filter", `label=simra.experiment=${id}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 })
			.split("\n")
			.filter(Boolean);
		if (ids.length) execFileSync(engine, ["rm", "-f", ...ids], { stdio: "ignore", timeout: 60_000 });
		return true;
	} catch {
		return false;
	}
}

/** The CPUs of a list such as "4-7,9", in order, without repeats. An invalid list is an error. */
export function parseCpuList(list: string): number[] {
	const out: number[] = [];
	for (const part of list.split(",")) {
		const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
		if (!m) throw new Error(`invalid CPU list "${list}": use numbers and ranges, for example "4-7,9"`);
		const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
		if (b < a) throw new Error(`invalid CPU list "${list}": the range ${part} goes down`);
		for (let c = a; c <= b; c++) if (!out.includes(c)) out.push(c);
	}
	return out;
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
	o: { cwd: string; env: NodeJS.ProcessEnv; stdoutPath: string; stderrPath: string; timeoutS: number; signal?: AbortSignal; onSpawn?: (pid: number) => void },
): Promise<SpawnResult> {
	return new Promise((resolvePromise) => {
		const out = createWriteStream(o.stdoutPath);
		const err = createWriteStream(o.stderrPath);
		const state: SpawnResult = { code: null, signal: null, timedOut: false, cancelled: false, spawnError: null };
		const child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.pipe(out);
		child.stderr.pipe(err);
		if (child.pid !== undefined) o.onSpawn?.(child.pid);

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
