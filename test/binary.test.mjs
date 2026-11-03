// Tests of the simra binary (packages/launcher). They run when SIMRA_BINARY is the path of a built binary
// (node packages/launcher/build.ts); otherwise they are reported as skipped. The first test always runs: the pi modules
// that the launcher imports by path exist in the pinned pi.
// They need no model, no API key and no network. The RC run needs ngspice and python3 on the PATH.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { makePdf } from "../packages/kernel/test/pdf-fixture.ts";
import { SIMRA_PREAMBLE } from "../packages/pi-extension/index.ts";

const root = new URL("..", import.meta.url).pathname;
const launcher = join(root, "packages", "launcher");
const fixtures = join(root, "packages", "kernel", "test", "fixtures");
const binary = process.env.SIMRA_BINARY && resolve(process.env.SIMRA_BINARY);
const skip = !binary && "SIMRA_BINARY is not set";
const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

/** A temporary folder that the test removes at the end. */
function tempDir(t, name) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `simra-binary-${name}-`)));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Run the binary in cwd with a fresh agent folder; give status, stdout and stderr. */
function simra(t, cwd, args, { bin = binary, env = {} } = {}) {
	const agentDir = tempDir(t, "agent");
	return spawnSync(bin, args, {
		cwd,
		env: { ...process.env, SIMRA_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", SIMRA_CACHE_DIR: join(agentDir, "cache"), ...env },
		encoding: "utf8",
		timeout: 60_000,
	});
}

/** A design root whose adapters are the test adapters of the kernel, then the built-in ones. */
function designRoot(t, files = {}) {
	const dir = tempDir(t, "design");
	writeFileSync(join(dir, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
	return dir;
}

test("the pi modules that the launcher imports by path are in the pinned pi", async () => {
	for (const file of ["main.ts", "src/utils/image-resize-worker.ts", "src/extensions/codemode/worker.ts"]) {
		const source = readFileSync(join(launcher, file), "utf8");
		const paths = [...source.matchAll(/(?:import|from) ["'](\.\.\/[^"']+)["']|import\(["'](\.\.\/[^"']+)["']\)/g)].map((m) => m[1] ?? m[2]);
		assert.ok(paths.length > 0, `${file} imports nothing by path`);
		for (const path of paths) assert.ok(existsSync(resolve(launcher, dirname(file), path)), `${file}: ${path} does not exist`);
	}
	const { setupCli } = await import(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli/setup.js"));
	assert.equal(typeof setupCli, "function");
});

test("--version and --help say simra, also through a link", { skip }, (t) => {
	const { version } = JSON.parse(readFileSync(join(dirname(realpathSync(binary)), "package.json"), "utf8"));
	const link = join(tempDir(t, "bin"), "simra");
	symlinkSync(binary, link);
	for (const bin of [binary, link]) {
		const v = simra(t, tmpdir(), ["--version"], { bin });
		assert.equal(v.status, 0, v.stderr);
		assert.equal(v.stdout.trim(), version);
		const help = simra(t, tmpdir(), ["--help"], { bin });
		assert.equal(help.status, 0, help.stderr);
		assert.match(help.stdout, /^simra /);
		assert.match(help.stdout, /Usage:\n {2}simra \[options\]/);
	}
});

test("the kernel commands go to the kernel, the other arguments to pi", { skip }, (t) => {
	const dir = tempDir(t, "routing");
	const list = simra(t, dir, ["list"]);
	assert.equal(list.status, 0, list.stderr);
	assert.equal(list.stdout, "");
	const run = simra(t, dir, ["run"]);
	assert.equal(run.status, 2);
	assert.match(run.stderr, /^usage: simra run/);
	const install = simra(t, dir, ["install", "--help"]);
	assert.equal(install.status, 0, install.stderr);
	assert.match(install.stdout, /simra install <source>/);
});

/** A Chat Completions API. It answers a request that offers codemode with one codemode call, and else with "done". */
async function fakeModelApi(t) {
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		requests.push(body);
		const base = { id: `fake-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "fake" };
		const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		const call = (body.tools ?? []).some((tool) => tool.function?.name === "codemode") && !body.messages.some((m) => m.role === "tool");
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (call) {
			const args = JSON.stringify({ code: 'text("CODEMODE_WORKER_OK")' });
			res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "codemode", arguments: args } }] }));
			res.write(chunk({}, "tool_calls"));
		} else {
			res.write(chunk({ role: "assistant", content: "done" }));
			res.write(chunk({}, "stop"));
		}
		res.end("data: [DONE]\n\n");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	t.after(() => server.close());
	return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

/** Run one prompt of the binary against the fake model API; give the requests that the API received. */
async function prompt(t, extra) {
	const api = await fakeModelApi(t);
	const agentDir = tempDir(t, "agent");
	const models = { providers: { fake: { baseUrl: api.url, api: "openai-completions", apiKey: "fake", models: [{ id: "fake" }] } } };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
	const args = ["--provider", "fake", "--model", "fake", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", ...extra, "-p", "hello"];
	const child = spawn(binary, args, { cwd: tempDir(t, "cwd"), env: { ...process.env, SIMRA_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (c) => (output += c));
	child.stderr.on("data", (c) => (output += c));
	const code = await new Promise((r) => child.on("exit", r));
	assert.equal(code, 0, output);
	return api.requests;
}

test("the extension loads its tools and its preamble", { skip, timeout: 60_000 }, async (t) => {
	const [request] = await prompt(t, []);
	const tools = request.tools.map((tool) => tool.function.name);
	for (const name of ["run_experiment", "wait_experiments", "check_requirements", "design_record"]) assert.ok(tools.includes(name), `no tool ${name}: ${tools}`);
	const system = request.messages.find((m) => m.role === "system" || m.role === "developer").content;
	assert.ok((typeof system === "string" ? system : system.map((p) => p.text).join("")).startsWith(SIMRA_PREAMBLE));
});

test("codemode runs in its worker in the binary", { skip, timeout: 60_000 }, async (t) => {
	const requests = await prompt(t, ["--tools", "codemode"]);
	assert.equal(requests.length, 2);
	const result = requests[1].messages.find((m) => m.role === "tool");
	assert.match(JSON.stringify(result.content), /CODEMODE_WORKER_OK/);
});

test("simra run, run --detach, wait, list and show", { skip, timeout: 60_000 }, (t) => {
	const dir = designRoot(t, { "ok.json": { adapter: "fake", operation: "run", purpose: "binary", inputs: { mode: "ok" } } });
	const run = simra(t, dir, ["run", "ok.json"]);
	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /^experiment \S+: completed/);
	// The supervisor of a detached run is the binary itself: simra run --detached-worker <dir>.
	const detach = simra(t, dir, ["run", "--detach", "ok.json"]);
	assert.equal(detach.status, 0, detach.stderr);
	const id = detach.stdout.match(/^experiment (\S+): running \(detached\)/)?.[1];
	assert.ok(id, detach.stdout);
	const wait = simra(t, dir, ["wait", id, "--timeout-s", "30"]);
	assert.equal(wait.status, 0, wait.stdout + wait.stderr);
	assert.match(wait.stdout, new RegExp(`experiment ${id}: completed`));
	assert.equal(readFileSync(join(dir, "simra", "experiments", id, "supervisor.stderr.log"), "utf8"), "");
	const list = simra(t, dir, ["list"]);
	assert.equal(list.stdout.trim().split("\n").length, 2);
	assert.match(simra(t, dir, ["show", id]).stdout, new RegExp(`^experiment ${id}: completed`));
});

test("the adapters and technology packs come from the folder of the binary", { skip, timeout: 60_000 }, (t) => {
	const deck = "* fixture design\n.subckt amp in out vss\nXn out in vss vss sky130_fd_pr__nfet_01v8 w=1 l=1\n.ends\n";
	const spec = { adapter: "ngspice", operation: "check_design", inputs: { file: "inv.spice", subckt: "amp", pins: ["in", "out", "vss"], technology: "sky130" } };
	const dir = designRoot(t, { "inv.spice": deck, "spec.json": spec });
	// Run through a link, as ~/.local/bin/simra does.
	const link = join(tempDir(t, "bin"), "simra");
	symlinkSync(binary, link);
	const run = simra(t, dir, ["run", "spec.json"], { bin: link });
	assert.equal(run.status, 0, run.stdout + run.stderr);
	const id = run.stdout.match(/^experiment (\S+):/)[1];
	const result = JSON.parse(readFileSync(join(dir, "simra", "experiments", id, "result.json"), "utf8"));
	const pack = result.input_files.files.find((f) => f.role === "technology");
	assert.equal(pack?.path, join(dirname(realpathSync(binary)), "technologies", "sky130", "technology.json"));
});

test("simra check", { skip, timeout: 60_000 }, (t) => {
	const requirements = {
		schema: "simra.requirements/0",
		conditions: { tt: {} },
		experiments: { dc: { adapter: "fake", operation: "run", inputs: { mode: "values", values: { x: 2 }, units: { x: "V" } } } },
		requirements: [{ id: "x", experiment: "dc", measurement: "x", unit: "V", op: ">=", limit: 1, conditions: ["tt"] }],
	};
	const dir = designRoot(t, { "requirements.json": requirements });
	const check = simra(t, dir, ["check"]);
	assert.equal(check.status, 0, check.stdout + check.stderr);
	assert.match(check.stdout, /pass/);
	assert.ok(existsSync(join(dir, "simra", "checks")));
});

test("simra pdf gives the text and renders a page", { skip, timeout: 60_000 }, (t) => {
	const dir = tempDir(t, "pdf");
	writeFileSync(join(dir, "d.pdf"), makePdf([{ lines: ["Hello from the binary"] }, {}]));
	const text = simra(t, dir, ["pdf", "d.pdf"]);
	assert.equal(text.status, 0, text.stderr);
	assert.match(text.stdout, /\[page 1\]\nHello from the binary/);
	const render = simra(t, dir, ["pdf", "d.pdf", "--render", "2"]);
	assert.equal(render.status, 0, render.stderr);
	const png = render.stdout.trim();
	assert.match(png, /page-2\.png$/);
	assert.deepEqual([...readFileSync(png).subarray(1, 4)], [...Buffer.from("PNG")]);
});

test("simra run of the RC example with ngspice", { skip: skip || (!(has("ngspice") && has("python3")) && "ngspice or python3 not on PATH"), timeout: 120_000 }, (t) => {
	const dir = tempDir(t, "rc");
	writeFileSync(join(dir, "simra.config.json"), "{}");
	copyFileSync(join(fixtures, "rc", "rc.spice"), join(dir, "rc.spice"));
	writeFileSync(join(dir, "rc.json"), JSON.stringify({ adapter: "ngspice", operation: "simulate", inputs: { deck: "rc.spice", measurements: { f3db_hz: "Hz" } } }));
	const run = simra(t, dir, ["run", "rc.json"]);
	assert.equal(run.status, 0, run.stdout + run.stderr);
	const id = run.stdout.match(/^experiment (\S+):/)[1];
	const result = JSON.parse(readFileSync(join(dir, "simra", "experiments", id, "result.json"), "utf8"));
	const f3db = 1 / (2 * Math.PI * 1e3 * 1e-6);
	assert.ok(Math.abs(result.measurements.f3db_hz.value / f3db - 1) < 1e-3, `f3db = ${result.measurements.f3db_hz.value}`);
});
