// The system prompt that the pinned pi sends with the Simra extension loaded, captured by a fake model API.
// It needs no API key and no network.
//
// 1. The prompt starts with the chip-design preamble. It lists each tool once, keeps the rules of the tools (with the
//    rule to run DRC and LVS through run_experiment, and the check_requirements rule only for a design with a
//    requirements.json), and has no pi documentation section.
// 2. A prompt that the user gives (--system-prompt) stays as it is.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SIMRA_PREAMBLE } from "../packages/pi-extension/index.ts";

const root = new URL("..", import.meta.url).pathname;
const piBin = join(root, "node_modules", ".bin", "pi");
const extensionDir = join(root, "packages", "pi-extension");

/** A Chat Completions API that answers "done" and keeps the system message of the first request. */
async function fakeModelApi() {
	const systems = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		let body = {};
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {}
		const system = (body.messages ?? []).find((m) => m.role === "system" || m.role === "developer");
		if (system) systems.push(typeof system.content === "string" ? system.content : system.content.map((p) => p.text).join(""));
		const base = { id: "fake", object: "chat.completion.chunk", created: 0, model: "deepseek-flash" };
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, systems, close: () => server.close() };
}

/** Run one pi prompt with the extension and give the system prompt that the model API received. */
async function systemPrompt(t, extra = []) {
	const api = await fakeModelApi();
	t.after(() => api.close());
	const agentDir = mkdtempSync(join(tmpdir(), "simra-prompt-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { deepseek: { baseUrl: api.url } } }));
	const args = ["--no-session", "-ne", "-ns", "-np", "-nc", "--no-themes", "-e", extensionDir, "--model", "deepseek/deepseek-flash", ...extra, "-p", "hello"];
	const child = spawn(piBin, args, {
		cwd: root,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, DEEPSEEK_API_KEY: "dummy", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(code, 0, `pi exited with code ${code}. stderr:\n${stderr}`);
	assert.equal(api.systems.length >= 1, true, "the model API received no system message");
	return api.systems[0];
}

test("pi sends the chip-design preamble, the tools and their rules, and no pi documentation", { timeout: 60_000 }, async (t) => {
	const prompt = await systemPrompt(t);
	assert.ok(prompt.startsWith(SIMRA_PREAMBLE), `the prompt does not start with the preamble:\n${prompt}`);
	assert.doesNotMatch(prompt, /operating inside pi|Pi documentation|<docs>/);
	assert.match(prompt, /<tools>\n[^]*- run_experiment: run and record one simulation[^]*\n<\/tools>/);
	assert.match(prompt, /- check_requirements: run the experiments in requirements\.json/);
	assert.doesNotMatch(prompt, /run_experiment: run_experiment|check_requirements: check_requirements/);
	assert.match(prompt, /<rules>\n[^]*- Run simulations with run_experiment[^]*- When the design has a requirements\.json, run check_requirements without a selection before you say that the design meets its requirements, and give its check id\.\n[^]*<\/rules>/);
	assert.doesNotMatch(prompt, /- Before you say that the design meets/);
	assert.match(prompt, /<rules>\n[^]*- Use the requirements and conditions parameters to check one row quickly[^]*- Report rows that are not measured or not run as such\.[^]*<\/rules>/);
	assert.match(prompt, /<rules>\n[^]*- Run DRC and LVS with run_experiment \(adapter klayout, operations drc and lvs\), not with a DRC or LVS shell script\.[^]*<\/rules>/);
});

test("a system prompt that the user gives stays as it is", { timeout: 60_000 }, async (t) => {
	const prompt = await systemPrompt(t, ["--system-prompt", "You are a test assistant."]);
	assert.ok(prompt.startsWith("You are a test assistant."), `the user's prompt was replaced:\n${prompt}`);
	assert.ok(!prompt.includes(SIMRA_PREAMBLE));
});
