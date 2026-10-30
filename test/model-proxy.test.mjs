// The model proxy (evals/model-proxy.mjs) with a fake upstream on this host. It needs no container and no key.
//
// 1. Chat Completions API: the proxy logs reasoning_effort, the message count, the model and the usage.
// 2. Responses API: the proxy logs reasoning.effort as reasoning_effort, input.length as the message count,
//    and the model and the usage of the "response.completed" event.
// 3. Responses API as pi 1.4.0 sends it: a fixed reasoning.effort "medium" and the thinking level in a
//    "configuration_update" input item, and the tools in an "additional_tools" input item. The proxy logs the
//    effort and the tools of these items.
// In both cases, the proxy puts the key from MODEL_API_KEY in the request, and the key is not in the log.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startProxy } from "../evals/run-arm.mjs";

/** A fake upstream that answers each POST with a server-sent event stream for its path. */
async function fakeUpstream() {
	const seen = [];
	const server = createServer(async (req, res) => {
		for await (const _ of req);
		seen.push({ path: req.url, authorization: req.headers.authorization });
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (req.url.endsWith("/responses")) {
			const response = { id: "resp_1", object: "response", model: "gpt-6.1-sol-2026-10-01" };
			res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...response, usage: null } })}\n\n`);
			res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "done" })}\n\n`);
			const usage = { input_tokens: 120, output_tokens: 7, total_tokens: 127 };
			return res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { ...response, usage } })}\n\n`);
		}
		const base = { id: "fake", object: "chat.completion.chunk", created: 0, model: "deepseek-flash" };
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() };
}

/** POST a JSON body to the proxy socket and read the full answer. */
async function post(socket, path, body) {
	return new Promise((res, rej) => {
		const req = request({ socketPath: socket, path, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer dummy" } }, (r) => {
			let text = "";
			r.on("data", (d) => (text += d));
			r.on("end", () => res({ status: r.statusCode, text }));
		});
		req.on("error", rej);
		req.end(JSON.stringify(body));
	});
}

test("model proxy: logs Chat Completions and Responses API calls", async () => {
	const key = `sk-test-${randomBytes(16).toString("hex")}`;
	const dir = mkdtempSync(join(tmpdir(), "simra-proxy-"));
	const up = await fakeUpstream();
	let proxy;
	try {
		({ proxy } = await startProxy(dir, key, up.url));
		const socket = join(dir, "proxy", "model.sock");
		const chat = await post(socket, "/chat/completions", { model: "deepseek-flash", stream: true, reasoning_effort: "high", messages: [{}, {}], tools: [{ type: "function", function: { name: "bash" } }] });
		assert.equal(chat.status, 200);
		const resp = await post(socket, "/responses", { model: "gpt-6.1-sol", stream: true, reasoning: { effort: "high" }, input: [{}, {}, {}], tools: [{ type: "function", name: "read" }] });
		assert.equal(resp.status, 200);
		assert.match(resp.text, /response\.completed/);
		const update = { type: "configuration_update", reasoning: { effort: "high" } };
		const pi = await post(socket, "/responses", { model: "gpt-6.1-sol", stream: true, reasoning: { effort: "medium", summary: "auto" }, input: [{ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "bash" }] }, { role: "user" }, update] });
		assert.equal(pi.status, 200);
		// The proxy writes the log line after it ends the answer.
		const lines = () => (existsSync(join(dir, "models.jsonl")) ? readFileSync(join(dir, "models.jsonl"), "utf8").trim().split("\n").length : 0);
		for (let i = 0; i < 50 && lines() < 3; i++) await new Promise((r) => setTimeout(r, 20));
		const log = readFileSync(join(dir, "models.jsonl"), "utf8");
		const [c, r, p] = log.trim().split("\n").map((l) => JSON.parse(l));

		assert.equal(c.path, "/chat/completions");
		assert.equal(c.request_model, "deepseek-flash");
		assert.equal(c.reasoning_effort, "high");
		assert.equal(c.messages, 2);
		assert.deepEqual(c.tools, ["bash"]);
		assert.equal(c.response_model, "deepseek-flash");
		assert.deepEqual(c.usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });

		assert.equal(r.path, "/responses");
		assert.equal(r.request_model, "gpt-6.1-sol");
		assert.equal(r.reasoning_effort, "high");
		assert.equal(r.messages, 3);
		assert.deepEqual(r.tools, ["read"]);
		assert.equal(r.response_model, "gpt-6.1-sol-2026-10-01");
		assert.deepEqual(r.usage, { input_tokens: 120, output_tokens: 7, total_tokens: 127 });

		assert.equal(r.reasoning_effort_field, undefined);

		assert.equal(p.reasoning_effort, "high", "the effort of the configuration_update item");
		assert.equal(p.reasoning_effort_field, "medium");
		assert.equal(p.messages, 3);
		assert.deepEqual(p.tools, ["bash"], "the tools of the additional_tools item");

		assert.deepEqual(up.seen.map((s) => s.path), ["/v1/chat/completions", "/v1/responses", "/v1/responses"]);
		assert.ok(up.seen.every((s) => s.authorization === `Bearer ${key}`), "the proxy puts in the key from MODEL_API_KEY");
		assert.ok(!log.includes(key), "the key is in the log");
	} finally {
		proxy?.kill("SIGTERM");
		up.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
