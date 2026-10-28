// Logging proxy for model API calls in evaluations.
// It forwards each request to the upstream API without change and writes one JSON line per request:
// time, path, the model name in the request, thinking settings, the model name in the response, and token usage.
// It never logs headers, so the API key does not appear in the log.
//
// Usage: node evals/model-proxy.mjs <port> <log.jsonl> [upstream]   (default upstream: https://api.deepseek.com)

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [port, logPath, upstream = "https://api.deepseek.com"] = process.argv.slice(2);
if (!port || !logPath) {
	console.error("usage: node evals/model-proxy.mjs <port> <log.jsonl> [upstream]");
	process.exit(2);
}

/** Model name and usage from a JSON body or from the "data:" lines of a server-sent event stream. */
function scanResponse(text) {
	let response_model = null;
	let usage = null;
	const bodies = text.trimStart().startsWith("{") ? [text] : text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => l.slice(6));
	for (const body of bodies) {
		try {
			const j = JSON.parse(body);
			response_model ??= j.model ?? null;
			if (j.usage) usage = j.usage;
		} catch {}
	}
	return { response_model, usage };
}

createServer(async (req, res) => {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = Buffer.concat(chunks);
	const entry = { time: new Date().toISOString(), method: req.method, path: req.url };
	try {
		const j = JSON.parse(body.toString("utf8"));
		Object.assign(entry, {
			request_model: j.model ?? null,
			stream: j.stream ?? null,
			thinking: j.thinking ?? null,
			reasoning_effort: j.reasoning_effort ?? null,
			messages: Array.isArray(j.messages) ? j.messages.length : null,
			tools: Array.isArray(j.tools) ? j.tools.map((t) => t.function?.name ?? t.name) : null,
		});
	} catch {}

	const headers = { ...req.headers };
	delete headers.host;
	delete headers["content-length"];
	delete headers["accept-encoding"];
	try {
		const up = await fetch(upstream + req.url, { method: req.method, headers, body: body.length ? body : undefined });
		entry.status = up.status;
		const out = [];
		res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k))));
		if (up.body) {
			for await (const c of up.body) {
				out.push(Buffer.from(c));
				res.write(c);
			}
		}
		res.end();
		const text = Buffer.concat(out).toString("utf8");
		Object.assign(entry, { response_model: null, usage: null }, scanResponse(text));
		if (up.status >= 400) entry.error = text.slice(0, 300);
	} catch (err) {
		entry.status = 502;
		entry.error = String(err);
		if (!res.headersSent) res.writeHead(502);
		res.end();
	}
	appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}).listen(Number(port), "127.0.0.1", () => console.error(`model proxy on 127.0.0.1:${port} -> ${upstream}, log ${logPath}`));
