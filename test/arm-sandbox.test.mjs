// The eval sandbox (evals/run-arm.mjs) with a fake model API on this host, so no real key is needed.
// Runs only when SIMRA_TEST_IMAGE names an environment image (optional: SIMRA_TEST_ENGINE podman or docker,
// default podman). A skipped case is reported by the test runner as skipped: that check did not run.
//
// 1. probe: a shell in the sandbox reads the task file. It cannot read a canary file on the host or see
//    expected.json at its host path, and has no real key. It finds no reference value of ota-corners in the
//    image, has no network and no writable root, and reaches the model API only through the proxy, which
//    puts in the real key.
// 2. arms: simra, pi and opencode each finish one model call through the proxy.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { containerImageId } from "../packages/kernel/src/environments.ts";
import { DUMMY_KEY, sandboxArgs, startProxy } from "../evals/run-arm.mjs";

const repo = new URL("../", import.meta.url).pathname;
const engine = process.env.SIMRA_TEST_ENGINE ?? "podman";
const image = process.env.SIMRA_TEST_IMAGE;
const skip = !image && "SIMRA_TEST_IMAGE is not set";

/** Run a command without blocking this process (it serves the fake model API). */
function runAsync(command, args, env) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("exit", (status) => resolve({ status, stdout, stderr }));
	});
}

/** An OpenAI-style chat API that answers "done" and records the Authorization header of each request. */
async function fakeModelApi() {
	const seen = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
		if (req.method !== "POST") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash", object: "model" }] }));
		}
		const base = { id: "fake", object: "chat.completion.chunk", created: 0, model: "deepseek-flash" };
		const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 };
		let body = {};
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {}
		if (body.stream === false) {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage }));
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

/**
 * A pattern for each reference value of ota-corners: its first 5 significant digits (cut and rounded), with or
 * without a decimal point between them, so that 52.1052 and 5.21052e+01 both match.
 */
function answerPattern() {
	const expected = JSON.parse(readFileSync(join(repo, "evals/ota-corners/expected.json"), "utf8"));
	const cases = [...Object.values(expected.corners), ...Object.values(expected.variants)];
	const values = cases.flatMap((c) => ["gain_db", "ugf_hz", "pm_deg", "vn_1k_nv"].map((k) => c.values[k]));
	const digits = values.flatMap((v) => [v.toExponential(6).replace(".", "").slice(0, 5), v.toPrecision(5).replace(".", "").slice(0, 5)]);
	return ["cross_check", ...[...new Set(digits)].map((d) => d.split("").join("\\.?"))].join("|");
}

const PROBE = `
canary=$1
echo "task=$(cat /work/task.txt)"
if cat "$canary" >/dev/null 2>&1; then echo "canary=READABLE"; else echo "canary=unreadable"; fi
if [ -e "$(dirname "$canary")" ]; then echo "canary_dir=EXISTS"; else echo "canary_dir=absent"; fi
if [ -e "$3" ]; then echo "host_answers=EXISTS"; else echo "host_answers=absent"; fi
echo "image_has=$(for d in evals examples test; do [ -e /opt/simra-agent/$d ] && printf '%s ' $d; done)"
echo "answers_in_image=$(grep -rlE "$2" /opt/simra-agent --exclude-dir=node_modules 2>/dev/null | tr '\n' ' ')"
if touch /root-write-test 2>/dev/null; then echo "root=WRITABLE"; else echo "root=read-only"; fi
node -e 'fetch("https://api.deepseek.com", { signal: AbortSignal.timeout(5000) }).then(() => console.log("internet=REACHED"), () => console.log("internet=unreachable"))'
node -e 'fetch("http://127.0.0.1:8080/chat/completions", { method: "POST", headers: { authorization: "Bearer " + process.env.DEEPSEEK_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-flash", stream: false, messages: [] }) }).then((r) => r.json()).then((j) => console.log("proxy=" + j.choices[0].message.content), (e) => console.log("proxy=FAILED " + e))'
echo "--- env"
env
`;

test("probe: the sandbox reads its workspace and nothing else on the host", { skip }, async () => {
	const realKey = `sk-test-${randomBytes(16).toString("hex")}`;
	const token = randomBytes(8).toString("hex");
	const secret = randomBytes(8).toString("hex");
	const dir = mkdtempSync(join(tmpdir(), "simra-sandbox-"));
	const hostOnly = mkdtempSync(join(tmpdir(), "simra-canary-"));
	const api = await fakeModelApi();
	let proxy;
	try {
		const ws = join(dir, "ws");
		const state = join(dir, "state");
		mkdirSync(ws);
		mkdirSync(join(state, "home"), { recursive: true });
		writeFileSync(join(ws, "task.txt"), token);
		const canary = join(hostOnly, "canary.txt");
		writeFileSync(canary, secret);
		({ proxy } = await startProxy(dir, realKey, api.url));
		const proxyDir = join(dir, "proxy");
		const imageId = containerImageId(engine, image);
		const args = sandboxArgs({ engine, imageId, name: `simra-test-${token}`, ws, state, proxyDir, command: ["sh", "-c", PROBE, "probe", canary, answerPattern(), join(repo, "evals/ota-corners/expected.json")] });
		const r = await runAsync(engine, args, { PATH: process.env.PATH, HOME: process.env.HOME });
		assert.equal(r.status, 0, r.stderr);
		const out = r.stdout;
		const [facts, env] = out.split("--- env\n");
		const lines = Object.fromEntries(facts.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));

		assert.equal(lines.task, token, "the workspace is mounted");
		assert.equal(lines.canary, "unreadable");
		assert.equal(lines.canary_dir, "absent");
		assert.equal(lines.host_answers, "absent", "the host path of expected.json");
		assert.equal(lines.image_has, "", "the image holds these directories of the repository");
		assert.equal(lines.answers_in_image, "", "files in the image that hold eval answers");
		assert.equal(lines.root, "read-only");
		assert.equal(lines.internet, "unreachable");
		assert.equal(lines.proxy, "done", "the model API is reachable through the proxy");
		assert.ok(!out.includes(secret), "the canary content reached the container");
		assert.ok(!out.includes(realKey), "the real key is in the container");
		assert.match(env, new RegExp(`^DEEPSEEK_API_KEY=${DUMMY_KEY}$`, "m"));

		const post = api.seen.filter((s) => s.method === "POST");
		assert.equal(post.length, 1);
		assert.equal(post[0].authorization, `Bearer ${realKey}`, "the proxy puts in the real key");
		const log = readFileSync(join(dir, "models.jsonl"), "utf8");
		assert.ok(!log.includes(realKey), "the key is in the model call log");
		assert.equal(JSON.parse(log.trim().split("\n")[0]).status, 200);
	} finally {
		proxy?.kill("SIGTERM");
		api.close();
		rmSync(dir, { recursive: true, force: true });
		rmSync(hostOnly, { recursive: true, force: true });
	}
});

for (const arm of ["simra", "pi", "opencode"]) {
	test(`arm ${arm}: one model call through the proxy`, { skip, timeout: 300_000 }, async () => {
		const realKey = `sk-test-${randomBytes(16).toString("hex")}`;
		const tmp = mkdtempSync(join(tmpdir(), "simra-arm-test-"));
		const api = await fakeModelApi();
		try {
			const task = join(tmp, "task");
			mkdirSync(task);
			writeFileSync(join(task, "task.json"), JSON.stringify({ name: "probe", prompt: "task.md", score: "score.mjs", environment: "eda", files: { "simra.config.json": "simra.config.json", "simra.local.json": "simra.local.json" } }));
			writeFileSync(join(task, "task.md"), "Reply with the word done. Do not use tools.\n");
			writeFileSync(join(task, "score.mjs"), "export const score = () => ({ correctness: 0, traceability: 0, tool: 0 });\n");
			writeFileSync(join(task, "simra.config.json"), readFileSync(join(repo, "examples/ota-sg13g2/simra.config.json")));
			writeFileSync(join(task, "simra.local.json"), JSON.stringify({ environments: { eda: { engine, image } } }));
			const runs = join(tmp, "runs");
			// Run the arm as a separate process, as a user does, with the test key in its environment.
			const r = await runAsync(process.execPath, [join(repo, "evals/run-arm.mjs"), task, arm, "--runs", runs, "--timeout-min", "4", "--upstream", api.url], { PATH: process.env.PATH, HOME: process.env.HOME, DEEPSEEK_API_KEY: realKey });
			assert.equal(r.status, 0, r.stderr);
			const [run] = readdirSync(runs);
			const summary = JSON.parse(readFileSync(join(runs, run, "score.json"), "utf8"));
			const stderr = readFileSync(join(runs, run, "stderr.log"), "utf8");
			assert.equal(summary.exit.code, 0, stderr);
			assert.ok(summary.model_calls >= 1, "no model call");
			assert.deepEqual(summary.request_models, ["deepseek-flash"]);
			const calls = readFileSync(join(runs, run, "models.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
			// OpenCode also asks for a session title, without tools and without a thinking level.
			const agentCalls = calls.filter((c) => c.tools?.length);
			assert.ok(agentCalls.length >= 1, JSON.stringify(calls));
			assert.deepEqual([...new Set(agentCalls.map((c) => c.reasoning_effort))], ["high"], JSON.stringify(calls));
			const post = api.seen.filter((s) => s.method === "POST");
			assert.ok(post.length >= 1 && post.every((s) => s.authorization === `Bearer ${realKey}`), "the proxy puts in the real key");
			for (const f of ["transcript.jsonl", "stderr.log", "models.jsonl"]) assert.ok(!readFileSync(join(runs, run, f), "utf8").includes(realKey), `the key is in ${f}`);
		} finally {
			api.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});
}
