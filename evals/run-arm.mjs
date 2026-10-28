// Run one arm of an evaluation task in a sandbox container and score it.
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
// 1. Make a run directory: <runs>/<task>-<arm>-<time>/ with ws/ (the agent workspace), state/ (the harness
//    state) and proxy/ (the socket of the model proxy).
// 2. Fill ws/ with the task files and sim.sh. In ws/simra.local.json, the task environment is "local":
//    the agent already runs in the environment image, so the tools are in the same container.
// 3. Start evals/model-proxy.mjs on this host. It holds the real key and logs every model call
//    (model name, thinking settings, tokens).
// 4. Run the agent once with the task prompt, in a container of the environment image (see sandboxArgs).
//    Write its event stream to transcript.jsonl.
// 5. Score ws/ and write score.json.
// 6. Mark the run as contaminated if the transcript names the answers, this repository or another run.
//
// The sandbox: no network, a read-only root file system, no capabilities, and only ws/ (at /work),
// state/ (at /state) and proxy/ (at /proxy) mounted. The agent gets a dummy key. A small forwarder in the
// container connects 127.0.0.1:8080 to the proxy socket; the proxy puts the real key in each request.
// The image must not hold the answers: container/build.sh copies only the runtime files.
//
// The model key comes from DEEPSEEK_API_KEY (environment or .env in the repository root).
//
// Usage: node evals/run-arm.mjs <task dir> <simra|pi|opencode> [--runs <dir>] [--timeout-min <n>] [--upstream <url>]

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "@simra-tech/kernel";
import { containerImageId, containerUser } from "../packages/kernel/src/environments.ts";

const repo = new URL("../", import.meta.url).pathname;
export const MODEL = "deepseek/deepseek-flash";
export const DUMMY_KEY = "sk-dummy-the-proxy-adds-the-real-key";
export const WORK = "/work";
export const STATE = "/state";
const PROXY_DIR = "/proxy";
const FORWARD_PORT = 8080;
const BASE_URL = `http://127.0.0.1:${FORWARD_PORT}`;
const EXTENSION = "/opt/simra-agent/packages/pi-extension";

// The container entry point: forward 127.0.0.1:<port> to the proxy socket, then run the agent.
// Arguments: <socket> <port> <command> [arguments].
const LAUNCH = `const net = require("node:net"), { spawn } = require("node:child_process");
const [socket, port, ...cmd] = process.argv.slice(1);
net.createServer((c) => { const u = net.connect(socket); c.pipe(u).pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); })
	.listen(Number(port), "127.0.0.1", () => spawn(cmd[0], cmd.slice(1), { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 1)));`;

/** sim.sh runs "ngspice -b" with the environment variables of the task environment. */
function simScript(env) {
	const vars = Object.entries(env.env ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
	const pin = env.cpus ? `taskset -c ${env.cpus} ` : "";
	return `#!/bin/sh
# Run ngspice in batch mode (IHP SG13G2 PDK at $PDK_ROOT/ihp-sg13g2).
# Usage: ./sim.sh <deck> [more ngspice arguments].
exec env ${vars} ${pin}ngspice -b "$@"
`;
}

/** Fill ws with the task files. Returns the task environment as the host sees it (engine, image). */
export function makeWorkspace(taskDir, task, ws) {
	mkdirSync(ws, { recursive: true });
	for (const [name, src] of Object.entries(task.files)) {
		const from = resolve(taskDir, src);
		if (existsSync(from)) copyFileSync(from, join(ws, name));
	}
	const env = loadConfig(ws).environments[task.environment];
	if (!env || env.kind !== "container") throw new Error(`environment "${task.environment}" must be a container environment`);
	// In the sandbox, the task environment is the container itself.
	const inside = { kind: "local", ...(env.cpus ? { cpus: env.cpus } : {}) };
	writeFileSync(join(ws, "simra.local.json"), `${JSON.stringify({ environments: { [task.environment]: inside } }, null, 2)}\n`);
	writeFileSync(join(ws, "sim.sh"), simScript(env));
	chmodSync(join(ws, "sim.sh"), 0o755);
	// A design repository with one commit, as a designer would have it.
	const git = (...args) => execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@localhost", ...args], { cwd: ws, stdio: "ignore" });
	git("init", "-q");
	git("add", ".");
	git("commit", "-q", "-m", "design");
	return env;
}

/**
 * The container command line for one sandboxed process. ws, state and proxyDir are host directories.
 * env: extra environment variables. command: the program and its arguments in the container.
 */
export function sandboxArgs({ engine, imageId, name, ws, state, proxyDir, env = {}, command }) {
	return [
		"run",
		"--rm",
		"--name",
		name,
		"--init",
		"--network",
		"none",
		"--pull",
		"never",
		"-u",
		containerUser(engine),
		"--read-only",
		"--tmpfs",
		"/tmp:rw,exec,size=2g",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"-v",
		`${ws}:${WORK}`,
		"-v",
		`${state}:${STATE}`,
		"-v",
		`${proxyDir}:${PROXY_DIR}`,
		"-w",
		WORK,
		...Object.entries({ HOME: `${STATE}/home`, DEEPSEEK_API_KEY: DUMMY_KEY, ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
		imageId,
		"node",
		"-e",
		LAUNCH,
		`${PROXY_DIR}/model.sock`,
		String(FORWARD_PORT),
		...command,
	];
}

/** Start the model proxy on <run>/proxy/model.sock. It gets the key in its environment, not on its command line. */
export async function startProxy(run, key, upstream) {
	const proxyDir = join(run, "proxy");
	mkdirSync(proxyDir, { recursive: true });
	const socket = join(proxyDir, "model.sock");
	const args = [join(repo, "evals", "model-proxy.mjs"), socket, join(run, "models.jsonl"), ...(upstream ? [upstream] : [])];
	const proxy = spawn(process.execPath, args, { env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: key }, stdio: ["ignore", "ignore", "inherit"] });
	for (let i = 0; i < 100 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 50));
	if (!existsSync(socket)) throw new Error("model proxy did not start");
	return { proxy, proxyDir };
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

/** The agent command in the container. Configuration files go to the host directory state (mounted at STATE). */
function armCommand(arm, state, prompt) {
	if (arm === "simra" || arm === "pi") {
		mkdirSync(join(state, "pi-agent"), { recursive: true });
		writeFileSync(join(state, "pi-agent", "models.json"), JSON.stringify({ providers: { deepseek: { baseUrl: BASE_URL } } }, null, 2));
		const ext = arm === "simra" ? ["-e", EXTENSION] : [];
		return {
			command: ["pi", "--session-dir", `${STATE}/sessions`, "-ne", ...ext, "-ns", "-np", "--model", MODEL, "--thinking", "high", "--mode", "json", "-p", prompt],
			env: { PI_CODING_AGENT_DIR: `${STATE}/pi-agent`, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
		};
	}
	if (arm === "opencode") {
		mkdirSync(join(state, "opencode", "config", "opencode"), { recursive: true });
		// Without network, OpenCode uses its built-in model list, which does not have deepseek-flash.
		// The values are the ones that pi has for this model.
		const flash = {
			name: "DeepSeek Flash",
			reasoning: true,
			tool_call: true,
			temperature: true,
			interleaved: { field: "reasoning_content" },
			limit: { context: 1_000_000, output: 384_000 },
			variants: { high: { reasoningEffort: "high" } },
		};
		const config = { $schema: "https://opencode.ai/config.json", provider: { deepseek: { options: { baseURL: BASE_URL }, models: { "deepseek-flash": flash } } } };
		writeFileSync(join(state, "opencode", "config", "opencode", "opencode.json"), JSON.stringify(config, null, 2));
		const xdg = `${STATE}/opencode`;
		return {
			command: ["opencode", "run", "--pure", "-m", MODEL, "--variant", "high", "--format", "json", prompt],
			env: { XDG_CONFIG_HOME: `${xdg}/config`, XDG_DATA_HOME: `${xdg}/data`, XDG_CACHE_HOME: `${xdg}/cache`, XDG_STATE_HOME: `${xdg}/state` },
		};
	}
	throw new Error(`unknown arm "${arm}" (use simra, pi or opencode)`);
}

function waitExit(child, timeoutMs, onTimeout) {
	return new Promise((res) => {
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			onTimeout();
		}, timeoutMs);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			res({ code, signal, timed_out: timedOut });
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
	const runs = resolve(opt("--runs", process.env.SIMRA_EVAL_RUNS ?? join(tmpdir(), "simra-evals")));
	const timeoutMin = Number(opt("--timeout-min", "30"));
	const upstream = opt("--upstream", undefined);
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	const runName = `${task.name}-${arm}-${stamp}`;
	const run = join(runs, runName);
	const ws = join(run, "ws");
	const state = join(run, "state");
	mkdirSync(join(state, "home"), { recursive: true });
	const env = makeWorkspace(taskDir, task, ws);
	const engine = env.engine ?? "podman";
	const imageId = containerImageId(engine, env.image);
	if (env.image_id && env.image_id !== imageId) throw new Error(`image ${env.image} is ${imageId}, expected ${env.image_id}`);

	const key = process.env.DEEPSEEK_API_KEY ?? loadDotEnv().DEEPSEEK_API_KEY;
	if (!key) throw new Error("DEEPSEEK_API_KEY is not set");
	const { proxy, proxyDir } = await startProxy(run, key, upstream);

	const prompt = readFileSync(join(taskDir, task.prompt), "utf8");
	const cmd = armCommand(arm, state, prompt);
	const name = `simra-arm-${runName}`;
	const toolEnv = Object.fromEntries(Object.entries(env.env ?? {}).filter(([k]) => k !== "HOME"));
	const argv = sandboxArgs({ engine, imageId, name, ws, state, proxyDir, env: { ...toolEnv, ...cmd.env }, command: cmd.command });
	const started = new Date();
	// The engine client gets no key: only PATH and the variables that select the engine.
	const clientEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "PATH" || k.startsWith("DOCKER_") || k.startsWith("CONTAINER") || k === "XDG_RUNTIME_DIR" || k === "HOME"));
	const child = spawn(engine, argv, { env: clientEnv, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.pipe(createWriteStream(join(run, "transcript.jsonl")));
	child.stderr.pipe(createWriteStream(join(run, "stderr.log")));
	const exit = await waitExit(child, timeoutMin * 60_000, () => spawnSync(engine, ["kill", name], { stdio: "ignore" }));
	proxy.kill("SIGTERM");

	const log = join(run, "models.jsonl");
	const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const tokens = calls.reduce((a, c) => ({ prompt: a.prompt + (c.usage?.prompt_tokens ?? 0), completion: a.completion + (c.usage?.completion_tokens ?? 0) }), { prompt: 0, completion: 0 });
	// The sandbox prevents access to host files. These checks remain as a second line.
	const transcript = readFileSync(join(run, "transcript.jsonl"), "utf8");
	const contamination = [
		["task directory", new RegExp(`${escape(taskDir)}|expected\\.json|cross_check`)],
		["this repository", new RegExp(escape(repo))],
		["another run", new RegExp(`${escape(dirname(runs))}/(?!${escape(`${basename(runs)}/${runName}`)})`)],
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
		sandbox: { engine, image: env.image, image_id: imageId, network: "none", read_only_root: true, mounts: { [WORK]: "ws", [STATE]: "state", [PROXY_DIR]: "proxy" } },
		contamination,
		score: score(ws, undefined, WORK),
	};
	writeFileSync(join(run, "score.json"), `${JSON.stringify(summary, null, 2)}\n`);
	const s = summary.score;
	console.log(`${run}\n${contamination.length ? `CONTAMINATED (${contamination.join(", ")}) ` : ""}${task.name} ${arm}: correctness ${s.correctness}/16, traceability ${s.traceability}/16, tool ${s.tool}/2, ${summary.model_calls} model calls, ${summary.duration_s} s`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
