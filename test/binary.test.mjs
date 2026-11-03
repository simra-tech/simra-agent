// Tests of the simra binary (packages/launcher). They run when SIMRA_BINARY is the path of a built binary
// (node packages/launcher/build.ts); otherwise they are reported as skipped. The first test always runs: the pi modules
// that the launcher imports by path exist in the pinned pi.
// They need no model, no API key and no network: fake servers on 127.0.0.1 stand in for the model API and the
// releases. The RC run needs ngspice and python3, the first-run test python3 (for a terminal), the proxy test openssl.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makePdf } from "../packages/kernel/test/pdf-fixture.ts";
import { SIMRA_PREAMBLE } from "../packages/pi-extension/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const launcher = join(root, "packages", "launcher");
const fixtures = join(root, "packages", "kernel", "test", "fixtures");
const binary = process.env.SIMRA_BINARY && resolve(process.env.SIMRA_BINARY);
const skip = !binary && "SIMRA_BINARY is not set";
const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
const piVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["@earendil-works/pi-coding-agent"];
/** The environment without provider keys and without proxy settings of the machine. */
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/_API_KEY$|^(https?|no)_proxy$/i.test(name)));

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
		env: { ...cleanEnv, SIMRA_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", SIMRA_CACHE_DIR: join(agentDir, "cache"), ...env },
		encoding: "utf8",
		timeout: 60_000,
	});
}

/** As simra(), without blocking the event loop, so that a fake server of the test can answer. */
async function simraAsync(t, cwd, args, { env = {} } = {}) {
	const agentDir = tempDir(t, "agent");
	const child = spawn(binary, args, { cwd, env: { ...cleanEnv, SIMRA_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (c) => (stdout += c));
	child.stderr.on("data", (c) => (stderr += c));
	const status = await new Promise((r) => child.on("exit", r));
	return { status, stdout, stderr };
}

/** Send commands to the binary in RPC mode; give the records that it wrote until it answered all of them. */
async function rpc(t, env, commands) {
	const child = spawn(binary, ["--mode", "rpc", "--no-session"], { cwd: tempDir(t, "cwd"), env: { ...cleanEnv, PI_OFFLINE: "1", ...env }, stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => child.kill());
	let stderr = "";
	child.stderr.on("data", (c) => (stderr += c));
	const records = [];
	await new Promise((resolve, reject) => {
		child.on("exit", (code) => reject(new Error(`simra exited early (code ${code}). stderr:\n${stderr}`)));
		createInterface({ input: child.stdout }).on("line", (line) => {
			records.push(JSON.parse(line));
			if (commands.every(({ id }) => records.some((r) => r.type === "response" && r.id === id))) resolve();
		});
		for (const command of commands) child.stdin.write(`${JSON.stringify(command)}\n`);
	});
	return records;
}

/** A design root whose adapters are the test adapters of the kernel, then the built-in ones. */
function designRoot(t, files = {}) {
	const dir = tempDir(t, "design");
	writeFileSync(join(dir, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
	return dir;
}

test("the pi modules that the launcher imports by path are in the pinned pi", async () => {
	for (const file of ["main.ts", "help.ts", "first-run.ts", "src/utils/image-resize-worker.ts", "src/extensions/codemode/worker.ts"]) {
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
		assert.match(help.stdout, /^simra - a chip-design agent built on pi\n/);
		assert.match(help.stdout, /Usage:\n {2}simra \[options\]/);
		assert.match(help.stdout, /Commands:\n {2}simra run <spec\.json> +Run one experiment[^]* {2}simra update +Update simra/);
		assert.match(help.stdout, /SIMRA_CODING_AGENT_DIR +- Config directory \(default: ~\/\.config\/simra\)\n[^]* {2}SIMRA_NO_UPDATE_CHECK +- /);
		assert.doesNotMatch(help.stdout, /AI coding assistant|Update pi|simra list +List installed|PI_SELF_UPDATE_COMMAND|~\/\.simra\/agent/);
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
	// pi's own update never runs: it would install pi. Only the updates of packages and model catalogs go to pi.
	for (const args of [["update", "--all"], ["update", "pi"], ["update", "--self"], ["update", "--extensions", "--self"]]) {
		const update = simra(t, dir, args);
		assert.equal(update.status, 2, `${args.join(" ")}: ${update.stdout}${update.stderr}`);
		assert.match(update.stderr, /^usage: simra update/);
	}
	const models = simra(t, dir, ["update", "--models"]);
	assert.equal(models.status, 0, models.stderr);
	assert.match(models.stdout, /Model catalogs refreshed/);
});

/** A Chat Completions API. It answers a request that offers codemode with one codemode call, and else with "done". */
function modelApi(requests) {
	return async (req, res) => {
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
	};
}

/** A releases page: <base>/latest redirects to the tag of the version, <base>/latest/download/install.sh is a script. */
function releasesApi(version, requests) {
	return (req, res) => {
		requests.push(req.url);
		if (req.url.endsWith("/releases/latest")) res.writeHead(302, { location: `${req.url.replace(/latest$/, "")}tag/v${version}` }).end();
		else if (req.url.endsWith("/releases/latest/download/install.sh")) res.end(`echo "install.sh of ${version} ran"\n`);
		else res.writeHead(404).end();
	};
}

/** Listen on 127.0.0.1; give the base URL. */
async function listen(t, server, scheme = "http") {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	t.after(() => server.close());
	return `${scheme}://127.0.0.1:${server.address().port}`;
}

/** Run one prompt of the binary against a model API (default: a fake one on 127.0.0.1); give the requests. */
async function prompt(t, extra, { cwd = tempDir(t, "cwd"), agentDir = tempDir(t, "agent"), env = {}, url, requests = [] } = {}) {
	url ??= `${await listen(t, createServer(modelApi(requests)))}/v1`;
	const models = { providers: { fake: { baseUrl: url, api: "openai-completions", apiKey: "fake", models: [{ id: "fake" }] } } };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
	const args = ["--provider", "fake", "--model", "fake", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", ...extra, "-p", "hello"];
	const child = spawn(binary, args, { cwd, env: { ...cleanEnv, SIMRA_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (c) => (output += c));
	child.stderr.on("data", (c) => (output += c));
	const code = await new Promise((r) => child.on("exit", r));
	assert.equal(code, 0, output);
	return requests;
}

/** The system prompt of a request to the model API. */
const systemPrompt = (request) => {
	const { content } = request.messages.find((m) => m.role === "system" || m.role === "developer");
	return typeof content === "string" ? content : content.map((p) => p.text).join("");
};

test("the extension loads its tools and its preamble", { skip, timeout: 60_000 }, async (t) => {
	const [request] = await prompt(t, []);
	const tools = request.tools.map((tool) => tool.function.name);
	for (const name of ["run_experiment", "wait_experiments", "check_requirements", "design_record"]) assert.ok(tools.includes(name), `no tool ${name}: ${tools}`);
	assert.ok(systemPrompt(request).startsWith(SIMRA_PREAMBLE));
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

test("simra update runs the install.sh of the latest release", { skip, timeout: 60_000 }, async (t) => {
	const requests = [];
	const url = await listen(t, createServer(releasesApi("9.9.9", requests)));
	const update = await simraAsync(t, tmpdir(), ["update"], { env: { SIMRA_RELEASES_URL: `${url}/releases` } });
	assert.equal(update.status, 0, update.stderr);
	assert.equal(update.stdout, "install.sh of 9.9.9 ran\n");
	assert.deepEqual(requests, ["/releases/latest/download/install.sh"]);
});

test("the update notice: from the last check, one check a day, none with SIMRA_NO_UPDATE_CHECK=1", { skip, timeout: 90_000 }, async (t) => {
	const requests = [];
	const url = await listen(t, createServer(releasesApi("99.0.0", requests)));
	const agentDir = tempDir(t, "agent");
	const state = join(agentDir, "update-check.json");
	const env = { SIMRA_CODING_AGENT_DIR: agentDir, SIMRA_RELEASES_URL: `${url}/releases`, PI_OFFLINE: "" };
	const commands = [{ id: "commands", type: "get_commands" }];
	const notices = (records) => records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => r.message);
	// The first start has no earlier check, so no notice. It checks in the background and saves the result.
	assert.deepEqual(notices(await rpc(t, env, commands)), []);
	for (let i = 0; i < 100 && !existsSync(state); i++) await new Promise((r) => setTimeout(r, 100));
	assert.equal(JSON.parse(readFileSync(state, "utf8")).latest, "99.0.0");
	// The second start shows the notice and does not check again on the same day.
	assert.deepEqual(notices(await rpc(t, env, commands)), ["simra 99.0.0 is available: run simra update"]);
	assert.deepEqual(requests, ["/releases/latest"]);
	rmSync(state);
	assert.deepEqual(notices(await rpc(t, { ...env, SIMRA_NO_UPDATE_CHECK: "1" }, commands)), []);
	await new Promise((r) => setTimeout(r, 1000));
	assert.deepEqual(requests, ["/releases/latest"]);
	assert.ok(!existsSync(state));
});

test("/simra-version, the settings in ~/.config/simra and the project folder .simra", { skip, timeout: 90_000 }, async (t) => {
	const { version } = JSON.parse(readFileSync(join(dirname(realpathSync(binary)), "package.json"), "utf8"));
	const records = await rpc(t, { SIMRA_CODING_AGENT_DIR: tempDir(t, "agent") }, [{ id: "version", type: "prompt", message: "/simra-version" }]);
	assert.deepEqual(records.filter((r) => r.method === "notify").map((r) => r.message), [`simra-agent ${version} (pi ${piVersion})`]);
	// Without SIMRA_CODING_AGENT_DIR, pi's files go to $XDG_CONFIG_HOME/simra.
	const config = tempDir(t, "config");
	const models = simra(t, tmpdir(), ["update", "--models"], { env: { SIMRA_CODING_AGENT_DIR: "", XDG_CONFIG_HOME: config } });
	assert.equal(models.status, 0, models.stderr);
	assert.ok(existsSync(join(config, "simra", "models-store.json")));
	// The project folder is .simra, not .pi.
	const project = tempDir(t, "project");
	for (const [folder, text] of [[".simra", "SIMRA_PROJECT_FOLDER"], [".pi", "PI_PROJECT_FOLDER"]]) {
		mkdirSync(join(project, folder));
		writeFileSync(join(project, folder, "APPEND_SYSTEM.md"), text);
	}
	const agentDir = tempDir(t, "agent");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	const [request] = await prompt(t, [], { cwd: project, agentDir });
	assert.match(systemPrompt(request), /SIMRA_PROJECT_FOLDER/);
	assert.doesNotMatch(systemPrompt(request), /PI_PROJECT_FOLDER/);
});

test("simra update and the model API work through HTTPS_PROXY with a company CA", { skip: skip || (spawnSync("openssl", ["version"]).status !== 0 && "openssl not on PATH"), timeout: 120_000 }, async (t) => {
	// A CA and a server certificate for releases.simra.test and models.simra.test. The proxy sends both names to one
	// HTTPS server on 127.0.0.1.
	const dir = tempDir(t, "tls");
	const ssl = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
	ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=Simra Test CA");
	ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=simra.test");
	writeFileSync(join(dir, "san.cnf"), "subjectAltName=DNS:releases.simra.test,DNS:models.simra.test\n");
	ssl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "1", "-extfile", "san.cnf");
	const ca = join(dir, "ca.pem");
	const models = [];
	const releases = [];
	const [modelHandler, releaseHandler] = [modelApi(models), releasesApi("9.9.9", releases)];
	const tls = { key: readFileSync(join(dir, "server.key")), cert: readFileSync(join(dir, "server.pem")) };
	const server = createHttpsServer(tls, (req, res) => (req.url.startsWith("/v1/") ? modelHandler(req, res) : releaseHandler(req, res)));
	await listen(t, server, "https");
	const connects = [];
	const proxy = createServer((_req, res) => res.writeHead(405).end());
	proxy.on("connect", (req, socket, head) => {
		connects.push(req.url);
		const upstream = connect(server.address().port, "127.0.0.1", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			upstream.write(head);
			upstream.pipe(socket).pipe(upstream);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
	});
	const env = { HTTPS_PROXY: await listen(t, proxy), SIMRA_RELEASES_URL: "https://releases.simra.test/releases" };
	// Without the CA, the certificate check fails: the test cannot pass by accident.
	const untrusted = await simraAsync(t, tmpdir(), ["update"], { env });
	assert.notEqual(untrusted.status, 0, untrusted.stdout);
	assert.equal(releases.length, 0);
	const trusted = [{ NODE_EXTRA_CA_CERTS: ca }];
	// On Linux, SSL_CERT_FILE replaces the system store, which the binary uses (--use-system-ca).
	if (process.platform === "linux") trusted.push({ SSL_CERT_FILE: ca });
	for (const caEnv of trusted) {
		const update = await simraAsync(t, tmpdir(), ["update"], { env: { ...env, ...caEnv } });
		assert.equal(update.status, 0, `${JSON.stringify(caEnv)}: ${update.stderr}`);
		assert.equal(update.stdout, "install.sh of 9.9.9 ran\n");
	}
	await prompt(t, [], { url: "https://models.simra.test/v1", env: { ...env, NODE_EXTRA_CA_CERTS: ca }, requests: models });
	assert.equal(models.length, 1);
	assert.ok(connects.includes("releases.simra.test:443") && connects.includes("models.simra.test:443"), connects.join(" "));
});

/** Run the binary in a terminal (python3 pty). steps: [text to wait for, keys to send]. Gives the terminal output. */
function terminal(env, steps) {
	const script = `
import fcntl, json, os, pty, select, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    os.execv(sys.argv[2], sys.argv[2:])
out = b""
for wait, keys in json.loads(sys.argv[1]):
    end = time.time() + 30
    while wait.encode() not in out:
        if time.time() > end:
            sys.stdout.write(out.decode(errors="replace"))
            sys.exit("timeout: no " + repr(wait))
        if select.select([fd], [], [], 0.2)[0]:
            try:
                out += os.read(fd, 65536)
            except OSError:
                break
    os.write(fd, keys.encode())
os.kill(pid, 9)
sys.stdout.write(out.decode(errors="replace"))
`;
	const run = spawnSync("python3", ["-c", script, JSON.stringify(steps), binary], { cwd: tmpdir(), env: { ...cleanEnv, PI_OFFLINE: "1", ...env }, encoding: "utf8", timeout: 120_000 });
	assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
	return run.stdout;
}

test("the first run: a welcome, a model, an API key, then pi with the Simra header", { skip: skip || (!has("python3") && "python3 not on PATH"), timeout: 180_000 }, (t) => {
	const agentDir = tempDir(t, "agent");
	terminal({ SIMRA_CODING_AGENT_DIR: agentDir }, [
		["Welcome to Simra", "\r"],
		["Paste an API key", "sk-simra-test\r"],
		["a chip-design agent built on pi", ""],
	]);
	assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).deepseek, { type: "api_key", key: "sk-simra-test" });
	const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual([settings.defaultProvider, settings.defaultModel], ["deepseek", "deepseek-flash"]);
	// The second start has no welcome.
	assert.doesNotMatch(terminal({ SIMRA_CODING_AGENT_DIR: agentDir }, [["a chip-design agent built on pi", ""]]), /Welcome to Simra/);
	// A provider key in the environment skips the welcome.
	assert.doesNotMatch(terminal({ SIMRA_CODING_AGENT_DIR: tempDir(t, "agent"), DEEPSEEK_API_KEY: "sk-env" }, [["a chip-design agent built on pi", ""]]), /Welcome to Simra/);
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
