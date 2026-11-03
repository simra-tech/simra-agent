// Run one arm of an evaluation task in a sandbox container and score it.
//
// A task is a directory with task.json:
//   { "name", "prompt": "task.md", "score": "score.mjs", "environment": "eda",
//     "files": { "<name in the workspace>": "<path relative to the task directory>" } }
// A file that does not exist is not copied (for example simra.local.json). A task file that is too large to commit
// is in "generated": { "<path>": { "sha256", "command" } }; the run stops if it is missing or has another hash.
// A task can have a companion: "companion": { "script": "<path>", "files": { "<name>": "<path>" } }. The run copies
// the script and the files to companion/ in the run directory, mounts it read-only at /companion, and starts the
// script in the sandbox before the agent, in the background. Its output goes to state/companion.log.
// score.mjs exports score(ws), which returns (or resolves to) the points of each part and "max": { part: maximum
// points }.
//
// Arms (all use the same model, chosen with --model, and the same thinking level):
//   simra     pi with the Simra Agent extension (tool run_experiment)
//   pi        stock pi
//   opencode  OpenCode
//   codex     Codex CLI, on the ChatGPT subscription of the host login (see codexAccess), not on the API key
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
// On macOS, a relay container makes the proxy socket (see startProxy), because a unix socket on the host does not
// reach a container in the engine's virtual machine.
// The image must not hold the answers: container/build.sh copies only the runtime files.
//
// The model key comes from the key variable of the model in MODELS (environment or .env in the repository root).
// For the codex arm, the proxy holds the access token of the Codex login on this host instead, and the sandbox gets
// only the Linux Codex package (--codex-dir or SIMRA_CODEX_DIR: the vendor/<target> directory of the npm package
// @openai/codex@<version>-linux-<arch>), mounted read-only. No login file goes into the sandbox.
//
// Usage: node evals/run-arm.mjs <task dir> <simra|pi|opencode|codex> [--model <id>] [--runs <dir>] [--timeout-min <n>]
//        [--upstream <url>] [--codex-dir <dir>]

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { connect, createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "@simra-tech/kernel";
import { containerImageId, containerUser } from "../packages/kernel/src/environments.ts";

const repo = new URL("../", import.meta.url).pathname;
export const DUMMY_KEY = "sk-dummy-the-proxy-adds-the-real-key";
export const WORK = "/work";
export const STATE = "/state";
const PROXY_DIR = "/proxy";
const FORWARD_PORT = 8080;
const BASE_URL = `http://127.0.0.1:${FORWARD_PORT}`;
const EXTENSION = "/opt/simra-agent/packages/pi-extension";
const CODEX_DIR = "/opt/codex";
const COMPANION_DIR = "/companion";
/** The Codex backend of a ChatGPT subscription. */
export const CODEX_UPSTREAM = "https://chatgpt.com/backend-api/codex";

/**
 * The models for the arms. keyVar: the variable that holds the key. upstream: the API that the proxy forwards to.
 * pi: the providers block of pi's models.json. opencode: the provider block of opencode.json. Without network,
 * OpenCode uses its built-in model list, so each model needs its entry here (the values are the ones in pi's list).
 * codex: the model name on the Codex backend (only models with this field can run on the codex arm).
 */
export const MODELS = {
	"deepseek/deepseek-flash": {
		keyVar: "DEEPSEEK_API_KEY",
		upstream: "https://api.deepseek.com",
		pi: { deepseek: { baseUrl: BASE_URL } },
		opencode: {
			deepseek: {
				options: { baseURL: BASE_URL },
				models: {
					"deepseek-flash": {
						name: "DeepSeek Flash",
						reasoning: true,
						tool_call: true,
						temperature: true,
						interleaved: { field: "reasoning_content" },
						limit: { context: 1_000_000, output: 384_000 },
						variants: { high: { reasoningEffort: "high" } },
					},
				},
			},
		},
	},
	"openai/gpt-6.1-sol": {
		keyVar: "OPENAI_API_KEY",
		upstream: "https://api.openai.com/v1",
		codex: "gpt-6.1-sol",
		pi: { openai: { baseUrl: BASE_URL } },
		opencode: {
			openai: {
				options: { baseURL: BASE_URL },
				models: {
					"gpt-6.1-sol": {
						name: "GPT-6.1 Sol",
						reasoning: true,
						tool_call: true,
						temperature: false,
						limit: { context: 272_000, output: 128_000 },
						// OpenCode 1.14.48 does not know this model as a reasoning model and drops the effort of the
						// variant. forceReasoning keeps it (checked with a fake API on 2026-10-30).
						options: { forceReasoning: true },
						variants: { high: { reasoningEffort: "high" } },
					},
				},
			},
		},
	},
};
export const DEFAULT_MODEL = "deepseek/deepseek-flash";

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
# Run ngspice in batch mode (PDK ${env.env?.PDK ?? "not set"} at $PDK_ROOT/${env.env?.PDK ?? ""}).
# Usage: ./sim.sh <deck> [more ngspice arguments].
exec env ${vars} ${pin}ngspice -b "$@"
`;
}

/**
 * Check the generated task files (the "generated" map of task.json: a task file that is too large to commit, with its
 * SHA-256 and the command that makes it). Throws if a file is missing or has another hash.
 */
export function checkGenerated(taskDir, task) {
	for (const [src, g] of Object.entries(task.generated ?? {})) {
		const from = resolve(taskDir, src);
		if (!existsSync(from)) throw new Error(`${from} not found: make it with ${g.command}`);
		const hash = createHash("sha256").update(readFileSync(from)).digest("hex");
		if (hash !== g.sha256) throw new Error(`${from} has SHA-256 ${hash}, expected ${g.sha256}: make it again with ${g.command}`);
	}
}

/** Fill ws with the task files. Returns the task environment as the host sees it (engine, image). */
/**
 * Copy the companion of a task (task.json "companion": { script, files }, paths relative to the task directory) to
 * dir: the script (executable) and the files. Returns { dir, script } (script: the file name of the script in dir).
 */
export function companionDir(taskDir, companion, dir) {
	mkdirSync(dir, { recursive: true });
	const script = basename(companion.script);
	const copies = { [script]: companion.script, ...(companion.files ?? {}) };
	for (const [name, from] of Object.entries(copies)) {
		const src = resolve(taskDir, from);
		if (!existsSync(src)) throw new Error(`the companion file ${from} does not exist`);
		copyFileSync(src, join(dir, name));
	}
	chmodSync(join(dir, script), 0o755);
	return { dir: realpathSync(dir), script };
}

/** The sandbox command with the companion: start /companion/<script> in the background (log: companion.log in the state mount), then the command. */
export const companionCommand = (script, command) => ["/bin/sh", "-c", `${COMPANION_DIR}/${script} > ${STATE}/companion.log 2>&1 & exec "$0" "$@"`, ...command];

export function makeWorkspace(taskDir, task, ws) {
	checkGenerated(taskDir, task);
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
 * The environment variables of the task environment that the sandbox gets (for example PDK, PDK_ROOT and
 * SIMRA_KLAYOUT), so that the tools and the adapters in the sandbox see them. The sandbox sets its own HOME.
 */
export function sandboxToolEnv(env) {
	return Object.fromEntries(Object.entries(env.env ?? {}).filter(([k]) => k !== "HOME"));
}

/**
 * The container command line for one sandboxed process. ws, state and proxyDir are host directories.
 * env: extra environment variables. command: the program and its arguments in the container.
 * readOnly: more mounts, { <host directory>: <container directory> }, read-only.
 */
export function sandboxArgs({ engine, imageId, name, ws, state, proxyDir, keyVar = "DEEPSEEK_API_KEY", env = {}, readOnly = {}, command }) {
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
		...Object.entries(readOnly).flatMap(([from, to]) => ["-v", `${from}:${to}:ro`]),
		"-w",
		WORK,
		...Object.entries({ HOME: `${STATE}/home`, [keyVar]: DUMMY_KEY, ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
		imageId,
		"node",
		"-e",
		LAUNCH,
		`${PROXY_DIR}/model.sock`,
		String(FORWARD_PORT),
		...command,
	];
}

/**
 * Use a relay for the proxy socket. On macOS the container engine runs in a virtual machine, and its file share
 * (virtiofs) does not carry unix sockets: a container cannot connect to a socket on the host. SIMRA_PROXY_RELAY=1
 * or 0 overrides the choice.
 */
export const PROXY_RELAY = process.env.SIMRA_PROXY_RELAY ? process.env.SIMRA_PROXY_RELAY === "1" : process.platform === "darwin";

/** The relay: a unix socket in /proxy, each connection forwarded to host:port. It runs as root, so it makes the socket usable by all. */
const RELAY = `const net = require("node:net"), fs = require("node:fs");
const [socket, host, port] = process.argv.slice(1);
net.createServer((c) => { const u = net.connect(Number(port), host); c.pipe(u).pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); })
	.listen(socket, () => fs.chmodSync(socket, 0o666));`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A TCP port on 127.0.0.1 that is free now. */
function freePort() {
	return new Promise((resolvePort, reject) => {
		const srv = createNetServer().on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolvePort(port));
		});
	});
}

/** True when something accepts a TCP connection on 127.0.0.1:port. */
function accepts(port) {
	return new Promise((r) => {
		const c = connect(port, "127.0.0.1", () => (c.destroy(), r(true))).on("error", () => r(false));
	});
}

/** The environment of the engine client: no key, only PATH and the variables that select the engine. */
export function engineEnv() {
	return Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "PATH" || k.startsWith("DOCKER_") || k.startsWith("CONTAINER") || k === "XDG_RUNTIME_DIR" || k === "HOME"));
}

/**
 * Start the model proxy. It gets the key in its environment, not on its command line. Returns { proxy, proxyDir,
 * stop }: proxyDir is the source of the mount at /proxy in the sandbox, which holds model.sock.
 *
 * Without a relay: the proxy listens on <run>/proxy/model.sock, and proxyDir is that host directory.
 * With a relay (engine and imageId are needed): the proxy listens on 127.0.0.1:<free port> on this host. A relay
 * container (no key, no host files) makes model.sock in a new engine volume and forwards it to the proxy through
 * the engine's host address. proxyDir is the volume. The sandbox itself still has no network. The relay has the
 * default network but no key and no host files. While the run lasts, any process on this host can use the proxy port.
 */
export async function startProxy(run, key, upstream, { engine, imageId, relay = PROXY_RELAY, headers } = {}) {
	const log = join(run, "models.jsonl");
	const spawnProxy = (where) =>
		spawn(process.execPath, [join(repo, "evals", "model-proxy.mjs"), where, log, ...(upstream ? [upstream] : [])], {
			env: { PATH: process.env.PATH, MODEL_API_KEY: key, ...(headers ? { MODEL_API_HEADERS: JSON.stringify(headers) } : {}) },
			stdio: ["ignore", "ignore", "inherit"],
		});
	if (!relay) {
		const proxyDir = join(run, "proxy");
		mkdirSync(proxyDir, { recursive: true });
		const socket = join(proxyDir, "model.sock");
		// A unix socket path has a limit of 107 bytes on Linux (103 on macOS).
		if (Buffer.byteLength(socket) > 103) throw new Error(`socket path is too long (${Buffer.byteLength(socket)} bytes, limit 103): ${socket}. Use a shorter --runs directory.`);
		const proxy = spawnProxy(socket);
		for (let i = 0; i < 100 && !existsSync(socket); i++) await sleep(50);
		if (!existsSync(socket)) throw new Error("model proxy did not start");
		return { proxy, proxyDir, stop: () => proxy.kill("SIGTERM") };
	}

	if (!engine || !imageId) throw new Error("the proxy relay needs the engine and the image");
	const port = await freePort();
	const proxy = spawnProxy(String(port));
	let up = false;
	for (let i = 0; i < 100 && !(up = await accepts(port)); i++) await sleep(50);
	const volume = `simra-proxy-${randomBytes(6).toString("hex")}`;
	const cli = (args) => spawnSync(engine, args, { env: engineEnv(), encoding: "utf8" });
	const stop = () => {
		proxy.kill("SIGTERM");
		cli(["rm", "-f", volume]);
		cli(["volume", "rm", "-f", volume]);
	};
	if (!up) {
		stop();
		throw new Error("model proxy did not start");
	}
	const host = engine === "podman" ? "host.containers.internal" : "host.docker.internal";
	const r = cli(["run", "-d", "--rm", "--name", volume, "--init", "--pull", "never", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"-u", "0:0", "-v", `${volume}:${PROXY_DIR}`, imageId, "node", "-e", RELAY, `${PROXY_DIR}/model.sock`, host, String(port)]);
	if (r.status !== 0) {
		stop();
		throw new Error(`the proxy relay did not start: ${r.stderr.trim()}`);
	}
	let ready = false;
	for (let i = 0; i < 100 && !(ready = cli(["exec", volume, "test", "-S", `${PROXY_DIR}/model.sock`]).status === 0); i++) await sleep(100);
	if (!ready) {
		stop();
		throw new Error("the proxy relay made no socket");
	}
	return { proxy, proxyDir: volume, stop };
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

/**
 * The model access of the codex arm: the access token and the account of the Codex login on this host
 * ($CODEX_HOME/auth.json, default ~/.codex), for the proxy only. The login must be valid for the whole run
 * (run codex on the host once to renew it).
 */
export function codexAccess(minutes, home = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
	const path = join(home, "auth.json");
	if (!existsSync(path)) throw new Error(`no Codex login (${path}): run "codex login" on this host`);
	const auth = JSON.parse(readFileSync(path, "utf8"));
	const token = auth.tokens?.access_token;
	if (auth.auth_mode !== "chatgpt" || !token || !auth.tokens.account_id) throw new Error("the Codex login is not a ChatGPT login");
	const exp = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}").exp;
	if (exp && exp * 1000 < Date.now() + (minutes + 10) * 60_000) throw new Error("the Codex login expires before the run ends: run codex on this host once to renew it");
	return { key: token, headers: { "ChatGPT-Account-ID": auth.tokens.account_id } };
}

/** The agent command in the container. Configuration files go to the host directory state (mounted at STATE). */
function armCommand(arm, state, prompt, modelId) {
	const model = MODELS[modelId];
	if (arm === "simra" || arm === "pi") {
		mkdirSync(join(state, "pi-agent"), { recursive: true });
		writeFileSync(join(state, "pi-agent", "models.json"), JSON.stringify({ providers: model.pi }, null, 2));
		const ext = arm === "simra" ? ["-e", EXTENSION] : [];
		return {
			command: ["pi", "--session-dir", `${STATE}/sessions`, "-ne", ...ext, "-ns", "-np", "--model", modelId, "--thinking", "high", "--mode", "json", "-p", prompt],
			env: { PI_CODING_AGENT_DIR: `${STATE}/pi-agent`, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
		};
	}
	if (arm === "opencode") {
		mkdirSync(join(state, "opencode", "config", "opencode"), { recursive: true });
		// The sandbox is the boundary, as for pi, which has no permission checks. In "opencode run", a check that
		// asks (for example a read outside /work, such as the PDK) is rejected and ends the session.
		const permission = { "*": "allow", external_directory: "allow", doom_loop: "allow" };
		// small_model: the session title call uses the same model as the agent (else OpenCode picks a small one).
		const config = { $schema: "https://opencode.ai/config.json", permission, small_model: modelId, provider: model.opencode };
		writeFileSync(join(state, "opencode", "config", "opencode", "opencode.json"), JSON.stringify(config, null, 2));
		const xdg = `${STATE}/opencode`;
		return {
			command: ["opencode", "run", "--pure", "-m", modelId, "--variant", "high", "--format", "json", prompt],
			env: { XDG_CONFIG_HOME: `${xdg}/config`, XDG_DATA_HOME: `${xdg}/data`, XDG_CACHE_HOME: `${xdg}/cache`, XDG_STATE_HOME: `${xdg}/state` },
		};
	}
	if (arm === "codex") {
		if (!model.codex) throw new Error(`model "${modelId}" has no Codex name`);
		mkdirSync(join(state, "codex"), { recursive: true });
		// A model provider that points at the proxy, with the dummy key. The proxy puts in the subscription token.
		writeFileSync(
			join(state, "codex", "config.toml"),
			`model = "${model.codex}"\nmodel_reasoning_effort = "high"\nmodel_provider = "proxy"\n\n[model_providers.proxy]\nname = "proxy"\nbase_url = "${BASE_URL}"\nwire_api = "responses"\nenv_key = "${model.keyVar}"\n`,
		);
		// The sandbox is the boundary, as for pi: no approvals and no Codex sandbox in the container.
		return {
			command: [`${CODEX_DIR}/bin/codex`, "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--ignore-rules", prompt],
			env: { CODEX_HOME: `${STATE}/codex` },
			codex: true,
		};
	}
	throw new Error(`unknown arm "${arm}" (use simra, pi, opencode or codex)`);
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
	// The real path: on macOS, tmpdir() is under the /var link, which the container engine VM may not have.
	const runsArg = resolve(opt("--runs", process.env.SIMRA_EVAL_RUNS ?? join(tmpdir(), "simra-evals")));
	mkdirSync(runsArg, { recursive: true });
	const runs = realpathSync(runsArg);
	const timeoutMin = Number(opt("--timeout-min", "30"));
	const modelId = opt("--model", DEFAULT_MODEL);
	const model = MODELS[modelId];
	if (!model) throw new Error(`unknown model "${modelId}" (use ${Object.keys(MODELS).join(" or ")})`);
	const upstream = opt("--upstream", arm === "codex" ? CODEX_UPSTREAM : model.upstream);
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	// Two runs of the same task and arm that start in the same second get distinct directories.
	let runName = `${task.name}-${arm}-${stamp}`;
	for (let n = 2; existsSync(join(runs, runName)); n += 1) runName = `${task.name}-${arm}-${stamp}-${n}`;
	const run = join(runs, runName);
	const ws = join(run, "ws");
	const state = join(run, "state");
	mkdirSync(join(state, "home"), { recursive: true });
	const env = makeWorkspace(taskDir, task, ws);
	const engine = env.engine ?? "podman";
	const imageId = containerImageId(engine, env.image);
	if (env.image_id && env.image_id !== imageId) throw new Error(`image ${env.image} is ${imageId}, expected ${env.image_id}`);

	const prompt = readFileSync(join(taskDir, task.prompt), "utf8");
	const cmd = armCommand(arm, state, prompt, modelId);
	const readOnly = {};
	if (cmd.codex) {
		const dir = opt("--codex-dir", process.env.SIMRA_CODEX_DIR);
		if (!dir || !existsSync(join(dir, "bin", "codex"))) throw new Error("the codex arm needs --codex-dir <vendor/<target> directory of the Linux Codex package>");
		readOnly[realpathSync(dir)] = CODEX_DIR;
		const pkg = join(dir, "codex-package.json");
		cmd.version = existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).version : null;
		// The image PATH, with the rg of the Codex package in front.
		const path = spawnSync(engine, ["image", "inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", imageId], { env: engineEnv(), encoding: "utf8" })
			.stdout.split("\n").find((l) => l.startsWith("PATH="))?.slice(5);
		cmd.env.PATH = `${CODEX_DIR}/codex-path:${path ?? "/usr/local/bin:/usr/bin:/bin"}`;
		// Codex CLI panics ("failed printing to stdout: Resource temporarily unavailable") when a large event (for
		// example a tool output of 100 kB and more) goes to the non-blocking stdout pipe of the sandbox. Its event
		// stream goes to a file in the state mount instead, and the run copies it to transcript.jsonl.
		cmd.command = ["/bin/sh", "-c", `exec "$0" "$@" > ${STATE}/transcript.jsonl`, ...cmd.command];
	}
	const companion = task.companion ? companionDir(taskDir, task.companion, join(run, "companion")) : null;
	if (companion) {
		readOnly[companion.dir] = COMPANION_DIR;
		cmd.command = companionCommand(companion.script, cmd.command);
	}

	const access = cmd.codex ? codexAccess(timeoutMin) : { key: process.env[model.keyVar] ?? loadDotEnv()[model.keyVar] };
	if (!access.key) throw new Error(`${model.keyVar} is not set`);
	const { proxyDir, stop: stopProxy } = await startProxy(run, access.key, upstream, { engine, imageId, headers: access.headers });

	const name = `simra-arm-${runName}`;
	const toolEnv = sandboxToolEnv(env);
	// The Simra extension tells the agent how much session time is left (other arms ignore the variable).
	const deadline = new Date(Date.now() + timeoutMin * 60_000).toISOString();
	const argv = sandboxArgs({ engine, imageId, name, ws, state, proxyDir, keyVar: model.keyVar, env: { ...toolEnv, ...cmd.env, SIMRA_SESSION_DEADLINE: deadline }, readOnly, command: cmd.command });
	const started = new Date();
	const child = spawn(engine, argv, { env: engineEnv(), stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.pipe(createWriteStream(join(run, cmd.codex ? "stdout.log" : "transcript.jsonl")));
	child.stderr.pipe(createWriteStream(join(run, "stderr.log")));
	const exit = await waitExit(child, timeoutMin * 60_000, () => spawnSync(engine, ["kill", name], { stdio: "ignore" }));
	stopProxy();
	if (cmd.codex) {
		const file = join(state, "transcript.jsonl");
		writeFileSync(join(run, "transcript.jsonl"), existsSync(file) ? readFileSync(file) : "");
	}

	const log = join(run, "models.jsonl");
	const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	// Chat Completions API: prompt_tokens / completion_tokens. Responses API: input_tokens / output_tokens.
	const tokens = calls.reduce(
		(a, c) => ({ prompt: a.prompt + (c.usage?.prompt_tokens ?? c.usage?.input_tokens ?? 0), completion: a.completion + (c.usage?.completion_tokens ?? c.usage?.output_tokens ?? 0) }),
		{ prompt: 0, completion: 0 },
	);
	// The sandbox prevents access to host files. These checks remain as a second line.
	const transcript = readFileSync(join(run, "transcript.jsonl"), "utf8");
	const contamination = [
		["task directory", new RegExp(`${escape(taskDir)}|expected\\.json|target\\.json|cross_check|layout-(?:drc-fix|block-fix|false-pass|long-job|stale-state)/|(?:cell|block|flat)-(?:seeded|clean|cheat)\\.gds|v[12]-(?:seeded|clean)\\.gds|${COMPANION_DIR}/`)],
		["this repository", new RegExp(escape(repo))],
		["another run", new RegExp(`${escape(dirname(runs))}/(?!${escape(`${basename(runs)}/${runName}`)})`)],
	]
		.filter(([, re]) => re.test(transcript))
		.map(([what]) => what);
	const summary = {
		task: task.name,
		arm,
		model: modelId,
		model_access: cmd.codex ? "subscription" : "api",
		...(cmd.codex ? { codex_version: cmd.version } : {}),
		request_models: [...new Set(calls.map((c) => c.request_model))],
		response_models: [...new Set(calls.map((c) => c.response_model))],
		model_calls: calls.length,
		tokens,
		started_at: started.toISOString(),
		duration_s: Math.round((Date.now() - started.getTime()) / 1000),
		exit,
		sandbox: { engine, image: env.image, image_id: imageId, network: "none", read_only_root: true, mounts: { [WORK]: "ws", [STATE]: "state", [PROXY_DIR]: "proxy", ...(cmd.codex ? { [CODEX_DIR]: "codex package (read-only)" } : {}), ...(companion ? { [COMPANION_DIR]: "companion (read-only)" } : {}) } },
		contamination,
		score: await score(ws, undefined, WORK),
	};
	writeFileSync(join(run, "score.json"), `${JSON.stringify(summary, null, 2)}\n`);
	const s = summary.score;
	const parts = Object.entries(s.max).map(([k, max]) => `${k} ${s[k]}/${max}`);
	console.log(`${run}\n${contamination.length ? `CONTAMINATED (${contamination.join(", ")}) ` : ""}${task.name} ${arm}: ${parts.join(", ")}, ${summary.model_calls} model calls, ${summary.duration_s} s`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
