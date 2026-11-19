import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { simraOAuth } from "../packages/pi-extension/src/hosted.ts";

async function fixture(t) {
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
		requests.push({ path: req.url, body });
		const reply = (value) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
		if (req.url === "/pilot/device") return reply({ device_code: "poll-fixture", user_code: "CODE", expires_in: 60, interval: 0.01 });
		if (req.url === "/pilot/token")
			return reply({ access: "fixture-access", refresh: "fixture-refresh", expires_in: 900, inference: true });
		if (req.url === "/pilot/grants") return reply({ inference: true, accepted: true });
		if (req.url === "/pilot/preflight") return reply({});
		if (req.url.endsWith("/chat/completions")) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end('data: {"choices":[{"index":0,"delta":{"content":"fixture reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	t.after(() => server.close());
	return { origin: "http://127.0.0.1:" + server.address().port, requests };
}

test("device login uses Pi callbacks and honors cancellation", async (t) => {
	const { origin, requests } = await fixture(t);
	const old = process.env.SIMRA_FLOW_URL;
	process.env.SIMRA_FLOW_URL = origin;
	t.after(() => {
		if (old === undefined) delete process.env.SIMRA_FLOW_URL;
		else process.env.SIMRA_FLOW_URL = old;
	});
	const controller = new AbortController();
	const callbacks = {
		onPrompt: async () => "engineer@example.test",
		onDeviceCode: (info) => {
			assert.equal(info.verificationUri, origin + "/pilot/verify");
			assert.equal(info.userCode, "CODE");
		},
	};
	const cred = await simraOAuth.login(callbacks);
	assert.equal(simraOAuth.getApiKey(cred), "fixture-access");
	await simraOAuth.refreshToken(cred, controller.signal);
	assert.deepEqual(requests.at(-1).body, { credential: "fixture-refresh", refresh: true });
	const count = requests.length;
	await assert.rejects(simraOAuth.login({ ...callbacks, signal: controller.signal, onDeviceCode: () => controller.abort() }));
	assert.equal(requests.length, count + 1);
});

test(
	"Pi blocks private history before transport and starts clean for hosted print",
	{
		skip: !process.env.SIMRA_BINARY && "SIMRA_BINARY not set",
		timeout: 120000,
	},
	async (t) => {
		const { origin, requests } = await fixture(t);
		const root = mkdtempSync(join(tmpdir(), "simra-hosted-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const agent = join(root, "agent");
		mkdirSync(agent);
		writeFileSync(
			join(agent, "models.json"),
			JSON.stringify({
				providers: { own: { baseUrl: origin + "/own", api: "openai-completions", apiKey: "own", models: [{ id: "own" }] } },
			}),
		);
		writeFileSync(
			join(agent, "auth.json"),
			JSON.stringify({
				simra: {
					type: "oauth",
					access: "fixture-access",
					refresh: "fixture-refresh",
					expires: Date.now() + 600000,
					service: origin + "/pilot",
				},
			}),
		);
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
		async function run(args, url = origin) {
			const proc = spawn(process.env.SIMRA_BINARY, args, {
				cwd: root,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					SIMRA_CODING_AGENT_DIR: agent,
					SIMRA_FLOW_URL: url,
					PI_OFFLINE: "1",
					SIMRA_NO_ANALYTICS: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			proc.stdout.on("data", (c) => (output += c));
			proc.stderr.on("data", (c) => (output += c));
			const code = await new Promise((resolve) => proc.on("close", resolve));
			return { code, output };
		}
		const sessionDir = join(root, "sessions");
		const marker = "private-tool-" + randomUUID();
		const own = await run(
			["--provider", "own", "--model", "own", "--session-dir", sessionDir, "-p", "private conversation"],
			"http://127.0.0.1:1",
		);
		assert.equal(own.code, 0, own.output);
		const session = join(
			sessionDir,
			readdirSync(sessionDir).find((f) => f.endsWith(".jsonl")),
		);
		const entries = readFileSync(session, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const tool = {
			type: "message",
			id: "b2312190",
			parentId: entries.at(-1).id,
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolName: "read",
				toolCallId: "private-call",
				content: [{ type: "text", text: marker }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		const compact = {
			type: "compaction",
			id: "b2312191",
			parentId: tool.id,
			timestamp: tool.timestamp,
			summary: marker,
			firstKeptEntryId: tool.id,
			tokensBefore: 100,
		};
		appendFileSync(session, [tool, compact].map((e) => JSON.stringify(e) + "\n").join(""));
		for (const selection of [
			["--session", session],
			["--fork", session],
			["--session-dir", sessionDir, "--continue"],
		]) {
			const blocked = await run(["--provider", "simra", "--model", "simra-hosted", ...selection, "-p", "continue"]);
			assert.notEqual(blocked.code, 0);
			assert.match(blocked.output, /simra hosted/);
			assert.deepEqual(
				requests.filter((r) => r.path.startsWith("/pilot")),
				[],
			);
		}
		const hosted = await run(["hosted", "-p", "new hosted prompt"]);
		assert.equal(hosted.code, 0, hosted.output);
		assert.match(hosted.output, /tool results recorded/);
		const sent = requests.filter((r) => r.path === "/pilot/v1/chat/completions");
		assert.equal(sent.length, 1, hosted.output);
		assert.match(JSON.stringify(sent), /new hosted prompt/);
		assert.ok(!JSON.stringify(sent).includes(marker));
	},
);
