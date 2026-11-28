// The decision tools and hooks of the extension against a fake pi API: record_decision (class A says STOP and stops a
// run that cites it), the command /decision of the user, the inbox note for a decision that waits and for an answer,
// the tool decisions, the command /digest, and the note for an answer from the shell of the agent.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerDecision, decisionInbox, findDecision, listDecisions, readDecisionInbox, recordDecision } from "@simra-tech/kernel";
import extension, { ANSWER_NOTE, answerNote, INBOX_TYPE, parseDecisionCommand } from "../index.ts";

const fakeAdapters = new URL("../../kernel/test/fixtures/adapters", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function session(t: { after: (fn: () => void) => void }, root?: string) {
	const own = root === undefined;
	root ??= mkdtempSync(join(tmpdir(), "simra-decide-"));
	const before = process.env.SIMRA_INBOX_POLL_S;
	process.env.SIMRA_INBOX_POLL_S = "0.05";
	if (own) writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [fakeAdapters] }));
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const sent: { message: any; options: any }[] = [];
	const notified: { message: string; type: string }[] = [];
	extension({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (name: string, h: any) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	} as any);
	const ctx = { cwd: root, ui: { notify: (message: string, type: string) => notified.push({ message, type }) } };
	const emit = async (name: string, event: any, c: any = ctx) => {
		let last;
		for (const h of handlers.get(name) ?? []) last = (await h(event, c)) ?? last;
		return last;
	};
	const dir = root;
	t.after(async () => {
		await emit("session_shutdown", {});
		if (before === undefined) delete process.env.SIMRA_INBOX_POLL_S;
		else process.env.SIMRA_INBOX_POLL_S = before;
		if (own) rmSync(dir, { recursive: true, force: true });
	});
	return { root, tools, commands, emit, sent, notified, ctx };
}
const call = async (s: ReturnType<typeof session>, tool: string, params: unknown) => (await s.tools.get(tool).execute("c1", params, undefined, undefined, s.ctx)).content[0].text as string;
const bashResult = { toolName: "bash", toolCallId: "c1", input: { command: "ls" }, content: [{ type: "text", text: "src" }], isError: false };
const longRun = {
	class: "A",
	statement: "Start the full flow of the block for about 6 hours",
	alternative: "run the flow to the global route only (10 minutes)",
	why: "the timing with extracted wires needs the detailed route",
	reverse: "stop the run; the hours that it used are lost",
	affects: [{ kind: "file", ref: "runs/full" }],
};

test("record_decision class A says STOP; a run that cites it does not start until the user confirms it with /decision", async (t) => {
	const s = session(t);
	const text = await call(s, "record_decision", longRun);
	assert.match(text, /class A, waiting for owner/);
	assert.match(text, /^STOP: this is a class A decision\. It waits for the owner\./m);
	const [decision] = listDecisions(s.root);
	const run = s.tools.get("run_experiment");
	assert.equal(run.parameters.properties.decisions.type, "array");
	const params = { adapter: "fake", operation: "run", inputs: { mode: "ok" }, purpose: "full flow", decisions: [decision.id] };
	await assert.rejects(run.execute("c2", params, undefined, undefined, s.ctx), /the run did not start: decision .* \(class A\) waits for the owner/);
	// The agent has no tool that answers a decision.
	assert.deepEqual([...s.tools.keys()].filter((n) => /answer|confirm/.test(n)), []);
	// The user of the session answers.
	await s.commands.get("decision").handler(`${decision.id.slice(-6)} confirmed go ahead tonight`, s.ctx);
	assert.equal(s.notified.at(-1)?.type, "info");
	const answered = findDecision(s.root, decision.id);
	assert.equal(answered.status, "confirmed");
	assert.deepEqual({ ...answered.answers[0], at: "" }, { answer: "confirmed", at: "", by: "user of the session", via: "session", terminal: false, note: "go ahead tonight", marked: [] });
	const done = await run.execute("c3", params, undefined, undefined, s.ctx);
	assert.match(done.content[0].text, /^decision: .* class A, confirmed by user of the session /m);
	assert.doesNotMatch(done.content[0].text, /UNCONFIRMED/);
});

test("record_decision class B continues, and an invalid decision is an error with every problem", async (t) => {
	const s = session(t);
	const text = await call(s, "record_decision", { ...longRun, class: "B" });
	assert.match(text, /Class B: the work continues/);
	assert.doesNotMatch(text, /STOP/);
	assert.deepEqual(readDecisionInbox(s.root), []);
	await assert.rejects(call(s, "record_decision", { class: "B", statement: "x", why: "y", affects: [{ kind: "claim", ref: "z" }] }), /invalid decision:\n- alternative is required for class B[\s\S]*class B with a claim in affects/);
	assert.equal(listDecisions(s.root).length, 1);
});

test("/decision: changed takes the statement of the user; a wrong form is an error and changes nothing; no argument lists what waits", async (t) => {
	const s = session(t);
	await s.commands.get("decision").handler("", s.ctx);
	assert.deepEqual(s.notified.at(-1), { message: "no class A decision waits for the owner", type: "info" });
	const d = recordDecision(s.root, longRun as Parameters<typeof recordDecision>[1]);
	await s.commands.get("decision").handler("", s.ctx);
	assert.match(s.notified.at(-1)?.message ?? "", new RegExp(`^decision ${d.id}: class A, waiting for owner`));
	for (const bad of [`${d.id} approved`, d.id, `${d.id} changed`, "zzzzzz confirmed"]) {
		await s.commands.get("decision").handler(bad, s.ctx);
		assert.equal(s.notified.at(-1)?.type, "error", bad);
	}
	assert.equal(findDecision(s.root, d.id).status, "waiting for owner");
	await s.commands.get("decision").handler(`${d.id} changed Run the flow to the global route first`, s.ctx);
	const changed = findDecision(s.root, d.id);
	assert.equal(changed.status, "changed");
	assert.equal(changed.answers[0].statement, "Run the flow to the global route first");
	assert.deepEqual(parseDecisionCommand(" abc123  reversed  not now "), { id: "abc123", answer: "reversed", text: "not now" });
});

test("a decision of another session that waits is named one time in the next tool result; the own decision is not", async (t) => {
	const s = session(t);
	await call(s, "record_decision", longRun);
	// The own decision was named by the tool: the next tool result has no inbox note.
	assert.equal(await s.emit("tool_result", bashResult), undefined);
	// Another session of the design root records a class A decision.
	const other = recordDecision(s.root, { ...longRun, statement: "Report the area from the placement estimate", affects: ["claim:area of the block"] } as Parameters<typeof recordDecision>[1]);
	const first = await s.emit("tool_result", bashResult);
	const note = first.content.at(-1).text as string;
	assert.match(note, /Simra inbox: 1 class A decision waits for the owner\. Work that depends on it does not start\./);
	assert.match(note, new RegExp(`^  ${other.id}: Report the area from the placement estimate`, "m"));
	assert.match(note, /Name each decision that waits in your report to the owner\. Do not answer a decision yourself\./);
	assert.equal(await s.emit("tool_result", bashResult), undefined, "named one time");
});

test("an idle session starts a turn when a class A decision waits, and again when the owner answers; reading the answer takes it out", async (t) => {
	const s = session(t);
	await s.emit("session_start", {}, { ...s.ctx, isIdle: () => true });
	const d = recordDecision(s.root, longRun as Parameters<typeof recordDecision>[1]);
	for (let i = 0; i < 100 && s.sent.length < 1; i++) await sleep(20);
	assert.equal(s.sent.length, 1);
	assert.equal(s.sent[0].message.customType, INBOX_TYPE);
	assert.deepEqual(s.sent[0].options, { triggerTurn: true });
	assert.match(s.sent[0].message.content, /1 class A decision waits for the owner/);
	await sleep(200);
	assert.equal(s.sent.length, 1, "the decision is named one time");
	answerDecision(s.root, d.id, { answer: "reversed", by: "owner" });
	for (let i = 0; i < 100 && s.sent.length < 2; i++) await sleep(20);
	assert.equal(s.sent.length, 2);
	assert.match(s.sent[1].message.content, /Simra inbox: the owner answered 1 decision, and the answer was not read\n.*reversed by owner.*\nread: decisions with the id/);
	assert.doesNotMatch(s.sent[1].message.content, /waits for the owner/);
	// The agent reads the decision: the marker of the answer leaves the inbox.
	assert.match(await call(s, "decisions", { id: d.id.slice(-6) }), /class A, reversed by owner/);
	assert.deepEqual(readDecisionInbox(s.root), []);
	assert.match(await call(s, "decisions", {}), new RegExp(`^A ${d.id} reversed \\(owner\\): `));
	assert.equal(await call(s, "decisions", { waiting: true }), "no decision is recorded in simra/decisions");
});

test("the agent ends its work while a decision of another session waits: one more turn with the note", async (t) => {
	const s = session(t);
	recordDecision(s.root, longRun as Parameters<typeof recordDecision>[1]);
	const settle = await s.emit("agent_before_settle", { entries: [] });
	assert.equal(settle.continue, true);
	assert.match(settle.entries[0].content, /1 class A decision waits for the owner/);
	assert.equal(await s.emit("agent_before_settle", { entries: [] }), undefined);
});

test("/digest shows the owner digest of the fixture, and a wrong time is an error", async (t) => {
	const fixture = new URL("../../kernel/test/fixtures/owner-digest", import.meta.url).pathname;
	const s = session(t, fixture);
	await s.commands.get("digest").handler("2026-11-27", s.ctx);
	assert.equal(s.notified.at(-1)?.type, "info");
	assert.match(s.notified.at(-1)?.message ?? "", /^digest of owner-digest since 2026-11-27 00:00 UTC [\s\S]*^WAITING FOR OWNER: 1 class A decision$/m);
	await s.commands.get("digest").handler("soon", s.ctx);
	assert.deepEqual([s.notified.at(-1)?.type, /give an ISO date or time/.test(s.notified.at(-1)?.message ?? "")], ["error", true]);
});

test("a shell command of the agent that records an answer gets a note; a command that only prints the words gets none", async (t) => {
	const s = session(t);
	const d = recordDecision(s.root, longRun as Parameters<typeof recordDecision>[1]);
	const bash = async (id: string, command: string, during: () => void = () => {}) => {
		await s.emit("tool_call", { toolName: "bash", toolCallId: id, input: { command } });
		during();
		const result = await s.emit("tool_result", { ...bashResult, toolCallId: id, input: { command } });
		return ((result?.content ?? []) as { text: string }[]).map((c) => c.text).filter((x) => x.startsWith(ANSWER_NOTE));
	};
	// The words of the command are not an answer: the records decide.
	assert.deepEqual(await bash("c2", "echo 'simra decision answer 3fa2c1 confirmed --by owner'"), []);
	// An answer from a terminal and an answer of the user in the session are the word of the owner: no note.
	assert.deepEqual(await bash("c3", "ls", () => answerDecision(s.root, d.id, { answer: "confirmed", by: "owner", via: "cli", terminal: true })), []);
	assert.deepEqual(await bash("c4", "ls", () => answerDecision(s.root, d.id, { answer: "confirmed", by: "user of the session", via: "session" })), []);
	// A script of the agent answers: the note names the decision, whatever the command text is.
	const notes = await bash("c5", "sh tools/finish.sh", () => answerDecision(s.root, d.id, { answer: "reversed", by: "owner", via: "cli", terminal: false }));
	assert.deepEqual(notes, [`${ANSWER_NOTE}\nRecorded: ${d.id} reversed by owner`]);
	// The next command gets no note for the same answer, and another tool gets none.
	await sleep(20);
	assert.deepEqual(await bash("c6", "ls"), []);
	assert.equal(answerNote({ toolName: "read" }, s.root, 0), null);
	assert.match(answerNote({ toolName: "bash" }, s.root, 0) ?? "", /Recorded: \S+ reversed by owner$/);
});

test("the tool decisions takes the answer that it shows out of the inbox, and keeps a newer answer", async (t) => {
	const s = session(t);
	const d = recordDecision(s.root, longRun as Parameters<typeof recordDecision>[1]);
	answerDecision(s.root, d.id, { answer: "confirmed", by: "owner" });
	// The marker of a waiting decision that another process left behind does not bring the decision back.
	writeFileSync(join(s.root, "simra/inbox", `decision-${d.id}.json`), JSON.stringify({ schema: "simra.inbox/0", kind: "decision", decision: d.id, class: "A", statement: d.statement, at: d.created_at }));
	const first = await s.emit("tool_result", bashResult);
	assert.match(first.content.at(-1).text, /the owner answered 1 decision/);
	assert.doesNotMatch(first.content.at(-1).text, /waits for the owner/);
	assert.match(await call(s, "decisions", { id: d.id }), /class A, confirmed by owner/);
	assert.deepEqual(decisionInbox(s.root), []);
	answerDecision(s.root, d.id, { answer: "reversed", by: "owner" });
	const second = await s.emit("tool_result", bashResult);
	assert.match(second.content.at(-1).text, new RegExp(`${d.id}: reversed by owner`));
});
