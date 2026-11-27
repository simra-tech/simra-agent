// The inbox hooks of the extension against a fake pi API: a detached run that ends is named in the next tool result,
// in one more turn when the agent ends, or in a turn that the extension starts while the session is idle. Each run is
// named one time; a wait takes it out of the inbox. The tools take pass_rule and heavy.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readInbox, waitExperiments } from "@simra-tech/kernel";
import extension, { INBOX_TYPE } from "../index.ts";

const fakeAdapters = new URL("../../kernel/test/fixtures/adapters", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function session(t: { after: (fn: () => void) => void }) {
	const root = mkdtempSync(join(tmpdir(), "simra-inbox-"));
	const before = { lock: process.env.SIMRA_HEAVY_LOCK, poll: process.env.SIMRA_INBOX_POLL_S };
	process.env.SIMRA_HEAVY_LOCK = join(root, "locks", "heavy.lock");
	process.env.SIMRA_INBOX_POLL_S = "0.05";
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [fakeAdapters] }));
	const tools = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const sent: { message: any; options: any }[] = [];
	extension({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (name: string, h: any) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	} as any);
	const emit = async (name: string, event: any, ctx: any) => {
		let last;
		for (const h of handlers.get(name) ?? []) last = (await h(event, ctx)) ?? last;
		return last;
	};
	t.after(async () => {
		await emit("session_shutdown", {}, { cwd: root });
		for (const [key, value] of [["SIMRA_HEAVY_LOCK", before.lock], ["SIMRA_INBOX_POLL_S", before.poll]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	return { root, tools, emit, sent };
}
async function ended(root: string, count: number): Promise<void> {
	for (let i = 0; i < 300 && readInbox(root).length < count; i++) await sleep(50);
	assert.equal(readInbox(root).length, count, "the run did not end in the inbox");
}
const bashResult = { toolName: "bash", toolCallId: "c1", input: { command: "ls" }, content: [{ type: "text", text: "src" }], isError: false };

test("a heavy detached run with a pass rule: the tool result names both, and the next tool result names the ended run once", async (t) => {
	const { root, tools, emit } = session(t);
	const run = tools.get("run_experiment");
	assert.equal(run.parameters.properties.heavy.type, "boolean");
	assert.ok(run.parameters.properties.pass_rule.properties.text && run.parameters.properties.pass_rule.properties.file);
	assert.ok(tools.get("run_jobs").parameters.properties.jobs.items.properties.pass_rule);
	assert.ok(run.promptGuidelines.some((g: string) => /Write the pass rule of a check before you see its result/.test(g)));
	assert.ok(run.promptGuidelines.some((g: string) => /Start a heavy job .* with heavy true and detached true/.test(g)));
	// Another tool holds the lock: the run is queued.
	mkdirSync(process.env.SIMRA_HEAVY_LOCK as string, { recursive: true });
	const ctx = { cwd: root };
	const started = await run.execute("call-1", { adapter: "fake", operation: "run", inputs: { mode: "ok" }, purpose: "route", detached: true, heavy: true, pass_rule: { id: "timing", text: "setup slack >= 0 ns" } }, undefined, undefined, ctx);
	const id = started.details.id;
	assert.equal(started.details.status, "queued");
	assert.match(started.content[0].text, new RegExp(`^experiment ${id}: queued \\(detached; a heavy job: it starts when the heavy-job lock is free; held by another tool`));
	assert.match(started.content[0].text, /^pass rule: timing: "setup slack >= 0 ns" sha256:[0-9a-f]{12}/m);
	// The agent works on: a tool result while the run is queued has no note.
	assert.equal(await emit("tool_result", bashResult, ctx), undefined);
	rmSync(process.env.SIMRA_HEAVY_LOCK as string, { recursive: true });
	await ended(root, 1);
	const noted = await emit("tool_result", { ...bashResult, toolCallId: "c2" }, ctx);
	const text = noted.content.map((c: any) => c.text).join("\n");
	assert.match(text, new RegExp(`Simra inbox: 1 detached run ended and its result was not read\\n {2}${id} fake\\.run: completed, ended .*, heavy job \\(route\\)\\nread: wait_experiments with ids \\["${id}"\\]`));
	assert.equal(await emit("tool_result", { ...bashResult, toolCallId: "c3" }, ctx), undefined, "the run is named one time");
	// The wait gives the summary and takes the run out of the inbox.
	const waited = await tools.get("wait_experiments").execute("call-2", { ids: [id] }, undefined, undefined, ctx);
	assert.match(waited.content[0].text, new RegExp(`^experiment ${id}: completed`));
	assert.deepEqual(readInbox(root), []);
});

test("the agent ends with an unread run: one more turn; an idle session: the extension starts a turn", async (t) => {
	const { root, tools, emit, sent } = session(t);
	const ctx = { cwd: root, isIdle: () => true };
	const settle = { type: "agent_before_settle", entries: [], continue: false };
	// Negative control: an empty inbox adds nothing and starts nothing.
	assert.equal(await emit("agent_before_settle", settle, ctx), undefined);
	const run = tools.get("run_experiment");
	const first = (await run.execute("call-1", { adapter: "fake", operation: "run", inputs: { mode: "ok" }, purpose: "first", detached: true }, undefined, undefined, ctx)).details.id;
	await ended(root, 1);
	const more = await emit("agent_before_settle", settle, ctx);
	assert.equal(more.continue, true);
	assert.equal(more.entries[0].customType, INBOX_TYPE);
	assert.match(more.entries[0].content, new RegExp(`${first} fake\\.run: completed`));
	assert.equal(await emit("agent_before_settle", settle, ctx), undefined, "one more turn for a run, not a loop");
	// The idle wake: no message while the session is busy; one message when it is idle.
	let idle = false;
	await emit("session_start", { reason: "startup" }, { cwd: root, mode: "rpc", isIdle: () => idle });
	const second = (await run.execute("call-2", { adapter: "fake", operation: "run", inputs: { mode: "failed" }, purpose: "second", detached: true }, undefined, undefined, ctx)).details.id;
	await ended(root, 2);
	await sleep(300);
	assert.equal(sent.length, 0, "a busy session gets no message");
	idle = true;
	for (let i = 0; i < 100 && sent.length === 0; i++) await sleep(50);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, INBOX_TYPE);
	assert.deepEqual(sent[0].options, { triggerTurn: true });
	assert.match(sent[0].message.content, new RegExp(`Simra inbox: 1 detached run ended[^]*${second} fake\\.run: failed`));
	await sleep(300);
	assert.equal(sent.length, 1, "the run is named one time");
	await waitExperiments(root, [first, second], { timeoutS: 5 });
});

test("SIMRA_INBOX_WAKE=off: no idle wake", async (t) => {
	const { root, tools, emit, sent } = session(t);
	process.env.SIMRA_INBOX_WAKE = "off";
	t.after(() => delete process.env.SIMRA_INBOX_WAKE);
	await emit("session_start", { reason: "startup" }, { cwd: root, mode: "rpc", isIdle: () => true });
	await tools.get("run_experiment").execute("call-1", { adapter: "fake", operation: "run", inputs: { mode: "ok" }, purpose: "x", detached: true }, undefined, undefined, { cwd: root });
	await ended(root, 1);
	await sleep(300);
	assert.equal(sent.length, 0);
});
