// Local job runner. It runs one experiment to the end and writes its records.
// Stage 1: the call blocks until the adapter exits. Detached jobs come later.
//
// Contract with the adapter (simra.adapter/0): the runner writes request.json and starts the adapter with its
// path as the only argument. The adapter writes response.json. See CONTRIBUTING.md.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { buildInvocation } from "./environments.ts";
import {
	createExperimentDir,
	EXPERIMENT_SCHEMA,
	experimentDir,
	type ExecutionStatus,
	type ExperimentRecord,
	type FileHash,
	newExperimentId,
	RESULT_SCHEMA,
	type ResultRecord,
	readJson,
	writeJsonAtomic,
} from "./records.ts";

export const CONTRACT = "simra.adapter/0";
export const KERNEL_VERSION: string = readJson<{ version: string }>(
	new URL("../package.json", import.meta.url).pathname,
).version;
export const BUILTIN_ADAPTER_DIR = new URL("../../../adapters", import.meta.url).pathname;

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
	signal?: AbortSignal;
}

export interface RunOutcome {
	id: string;
	dir: string;
	experiment: ExperimentRecord;
	result: ResultRecord;
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

function gitState(root: string): ExperimentRecord["design"] {
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

export async function runExperiment(opts: RunOptions): Promise<RunOutcome> {
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
	const invocation = buildInvocation({ name: envName, config: envConfig, root, adapterDir, adapterCommand, experimentId: id });
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

	const started = new Date();
	const stdoutPath = join(dir, "adapter.stdout.log");
	const stderrPath = join(dir, "adapter.stderr.log");
	const exit = await spawnAndWait(invocation.command, invocation.args, {
		cwd: root,
		env: invocation.env,
		stdoutPath,
		stderrPath,
		timeoutS: opts.timeoutS ?? 3600,
		signal: opts.signal,
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
		result.errors.push(`the adapter did not finish in ${opts.timeoutS ?? 3600} s and was stopped`);
	} else if (exit.cancelled) {
		result.status = "cancelled";
		result.errors.push("the run was cancelled");
	} else if (!existsSync(responsePath)) {
		result.errors.push(`the adapter wrote no response (exit code ${exit.code}); see ${result.logs.adapter_stderr}`);
	} else {
		applyResponse(result, responsePath, exit.code);
	}

	writeJsonAtomic(join(dir, "result.json"), result);
	return { id, dir, experiment, result };
}

/** Copy a valid adapter response into the result. An invalid response makes the status "error". */
function applyResponse(result: ResultRecord, responsePath: string, exitCode: number | null): void {
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
	result.input_files = (response.input_files as ResultRecord["input_files"]) ?? null;
	result.outputs = (response.outputs as FileHash[]) ?? [];
	result.measurements = (response.measurements as ResultRecord["measurements"]) ?? {};
	result.diagnostics = (response.diagnostics as ResultRecord["diagnostics"]) ?? [];
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
