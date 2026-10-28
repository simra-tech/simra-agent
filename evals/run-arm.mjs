// Run one arm of an evaluation task and score it.
//
// A task is a directory with task.json:
//   { "name", "prompt": "task.md", "score": "score.mjs", "environment": "eda",
//     "files": { "<name in the workspace>": "<path relative to the task directory>" } }
// A file that does not exist is not copied (for example simra.local.json). score.mjs exports score(ws).
//
// Arms (all use the same model and the same thinking level):
//   simra     pi with the Simra Agent extension (tool run_experiment)
//   pi        stock pi
//   opencode  OpenCode
//
// Steps:
// 1. Make a run directory: <runs>/<task>-<arm>-<time>/ with ws/ (the agent workspace) and the harness state.
// 2. Fill ws/ with the task files and sim.sh (ngspice in the container of the task environment).
// 3. Start evals/model-proxy.mjs, so every model call is logged (model name, thinking settings, tokens).
// 4. Run the agent once with the task prompt. Write its event stream to transcript.jsonl.
// 5. Score ws/ and write score.json.
// 6. Mark the run as contaminated if the agent read the task directory, this repository or another run.
//
// The run directory is outside this repository, so the agent does not see the repository files.
// The model key comes from DEEPSEEK_API_KEY (environment or .env in the repository root).
//
// Usage: node evals/run-arm.mjs <task dir> <simra|pi|opencode> [--runs <dir>] [--timeout-min <n>]

import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "@simra-tech/kernel";
import { containerImageId, containerUser } from "../packages/kernel/src/environments.ts";

const repo = new URL("../", import.meta.url).pathname;
export const MODEL = "deepseek/deepseek-flash";

/** sim.sh runs "ngspice -b" in the same container, with the same CPU pinning, as the Simra environment. */
function simScript(env) {
	const engine = env.engine ?? "podman";
	const id = env.image_id ?? containerImageId(engine, env.image);
	const e = Object.entries(env.env ?? {}).map(([k, v]) => `-e ${k}=${v}`).join(" ");
	const pin = env.cpus ? `taskset -c ${env.cpus} ` : "";
	return `#!/bin/sh
# Run ngspice in batch mode in the EDA container (IHP SG13G2 PDK at $PDK_ROOT/ihp-sg13g2).
# Usage: ./sim.sh <deck> [more ngspice arguments]. Paths are the same inside and outside the container.
here=$(cd "$(dirname "$0")" && pwd)
exec ${engine} run --rm --network none --pull never -u ${containerUser(engine)} ${e} -v "$here:$here" -w "$PWD" ${id} ${pin}ngspice -b "$@"
`;
}

export function makeWorkspace(taskDir, task, ws) {
	mkdirSync(ws, { recursive: true });
	for (const [name, src] of Object.entries(task.files)) {
		const from = resolve(taskDir, src);
		if (existsSync(from)) copyFileSync(from, join(ws, name));
	}
	const env = loadConfig(ws).environments[task.environment];
	if (!env || env.kind !== "container") throw new Error(`environment "${task.environment}" must be a container environment`);
	writeFileSync(join(ws, "sim.sh"), simScript(env));
	chmodSync(join(ws, "sim.sh"), 0o755);
	// A design repository with one commit, as a designer would have it.
	const git = (...args) => execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@localhost", ...args], { cwd: ws, stdio: "ignore" });
	git("init", "-q");
	git("add", ".");
	git("commit", "-q", "-m", "design");
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function loadDotEnv() {
	const path = join(repo, ".env");
	if (!existsSync(path)) return {};
	const out = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
	}
	return out;
}

function armCommand(arm, run, ws, baseUrl, prompt) {
	const piBin = join(repo, "node_modules", ".bin", "pi");
	if (arm === "simra" || arm === "pi") {
		const agentDir = join(run, "pi-agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { deepseek: { baseUrl } } }, null, 2));
		const ext = arm === "simra" ? ["-e", join(repo, "packages", "pi-extension")] : [];
		return {
			command: piBin,
			args: ["--session-dir", join(run, "sessions"), "-ne", ...ext, "-ns", "-np", "--model", MODEL, "--thinking", "high", "--mode", "json", "-p", prompt],
			env: { PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
		};
	}
	if (arm === "opencode") {
		const xdg = join(run, "opencode");
		mkdirSync(join(xdg, "config", "opencode"), { recursive: true });
		writeFileSync(join(xdg, "config", "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { deepseek: { options: { baseURL: baseUrl } } } }, null, 2));
		return {
			command: "opencode",
			args: ["run", "--pure", "-m", MODEL, "--variant", "high", "--format", "json", prompt],
			env: { XDG_CONFIG_HOME: join(xdg, "config"), XDG_DATA_HOME: join(xdg, "data"), XDG_CACHE_HOME: join(xdg, "cache"), XDG_STATE_HOME: join(xdg, "state") },
		};
	}
	throw new Error(`unknown arm "${arm}" (use simra, pi or opencode)`);
}

function waitExit(child, timeoutMs) {
	return new Promise((res) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
		}, timeoutMs);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			res({ code, signal, timed_out: signal !== null && Date.now() - child.startedAt >= timeoutMs });
		});
	});
}

async function main() {
	const args = process.argv.slice(2);
	const taskDir = resolve(args[0] ?? "");
	const arm = args[1];
	if (!existsSync(join(taskDir, "task.json"))) throw new Error(`${taskDir}: no task.json`);
	const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
	const { score } = await import(resolve(taskDir, task.score));
	const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
	const runs = opt("--runs", process.env.SIMRA_EVAL_RUNS ?? join(tmpdir(), "simra-evals"));
	const timeoutMin = Number(opt("--timeout-min", "30"));
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	const run = join(runs, `${task.name}-${arm}-${stamp}`);
	const ws = join(run, "ws");
	makeWorkspace(taskDir, task, ws);

	const dotenv = loadDotEnv();
	const key = process.env.DEEPSEEK_API_KEY ?? dotenv.DEEPSEEK_API_KEY;
	if (!key) throw new Error("DEEPSEEK_API_KEY is not set");
	const port = 20000 + Math.floor(Math.random() * 20000);
	const proxy = spawn(process.execPath, [join(repo, "evals", "model-proxy.mjs"), String(port), join(run, "models.jsonl")], { stdio: ["ignore", "ignore", "inherit"] });
	await new Promise((r) => setTimeout(r, 500));

	const prompt = readFileSync(join(taskDir, task.prompt), "utf8");
	const cmd = armCommand(arm, run, ws, `http://127.0.0.1:${port}`, prompt);
	const env = { ...process.env, ...cmd.env, DEEPSEEK_API_KEY: key };
	delete env.OPENCODE_API_KEY;
	const started = new Date();
	const child = spawn(cmd.command, cmd.args, { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"] });
	child.startedAt = Date.now();
	child.stdout.pipe(createWriteStream(join(run, "transcript.jsonl")));
	child.stderr.pipe(createWriteStream(join(run, "stderr.log")));
	const exit = await waitExit(child, timeoutMin * 60_000);
	proxy.kill("SIGTERM");

	const calls = readFileSync(join(run, "models.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const tokens = calls.reduce((a, c) => ({ prompt: a.prompt + (c.usage?.prompt_tokens ?? 0), completion: a.completion + (c.usage?.completion_tokens ?? 0) }), { prompt: 0, completion: 0 });
	// The agent runs as the same user, so it can search the whole file system. Detect, do not prevent.
	const transcript = readFileSync(join(run, "transcript.jsonl"), "utf8");
	const contamination = [
		["task directory", new RegExp(`${escape(taskDir)}|expected\\.json|cross_check`)],
		// The adapter directory is named in experiment.json, so it does not count.
		["this repository", new RegExp(`${escape(repo)}(?!adapters/)`)],
		// Any path next to this run, or next to the runs directory, can hold the answers of other runs.
		["another run", new RegExp(`${escape(dirname(runs))}/(?!${escape(`${basename(runs)}/${task.name}-${arm}-${stamp}`)})`)],
	]
		.filter(([, re]) => re.test(transcript))
		.map(([what]) => what);
	const summary = {
		task: task.name,
		arm,
		model: MODEL,
		request_models: [...new Set(calls.map((c) => c.request_model))],
		response_models: [...new Set(calls.map((c) => c.response_model))],
		model_calls: calls.length,
		tokens,
		started_at: started.toISOString(),
		duration_s: Math.round((Date.now() - started.getTime()) / 1000),
		exit,
		contamination,
		score: score(ws),
	};
	writeFileSync(join(run, "score.json"), `${JSON.stringify(summary, null, 2)}\n`);
	const s = summary.score;
	console.log(`${run}\n${contamination.length ? `CONTAMINATED (${contamination.join(", ")}) ` : ""}${task.name} ${arm}: correctness ${s.correctness}/16, traceability ${s.traceability}/16, tool ${s.tool}/2, ${summary.model_calls} model calls, ${summary.duration_s} s`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
