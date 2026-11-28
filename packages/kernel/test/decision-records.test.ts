// Decision records under stress: two writers, a record that is incomplete, an answer after an answer, a run that waits
// in the queue, a check that cites a decision, and the ways in which a result can depend on a decision. On the fake
// adapter.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ackAnswers,
	acquireHeavyLock,
	answerDecision,
	buildDigest,
	currentStatement,
	DECISION_LOCK,
	type DecisionInput,
	decisionDependents,
	decisionInbox,
	findDecision,
	formatDecision,
	formatDigest,
	formatOutcome,
	formatVerdict,
	listDecisions,
	readDecisions,
	readStatus,
	recordDecision,
	type ResultRecord,
	runCheck,
	runExperiment,
	validateRequirements,
	waitExperiments,
} from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function designRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "simra-decision-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	return root;
}
const run = (root: string, opts: { decisions?: string[]; passRule?: { id?: string; text?: string; file?: string } } = {}, extra: Record<string, unknown> = {}) =>
	runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok", ...extra }, purpose: "decision test", ...opts });
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const recordPath = (root: string, id: string) => join(root, "simra/decisions", `${id}.json`);

const variant: DecisionInput = {
	class: "A",
	statement: "Use one stage",
	alternative: "two stages: more area, more margin",
	why: "one stage meets the clock period at the typical corner",
	reverse: "add the second stage and run synthesis again (about 1 hour)",
	affects: ["file:rtl/mul.v"],
};
const direction: DecisionInput = { ...variant, class: "B" };

const amplifier = {
	schema: "simra.requirements/0",
	conditions: { tt: { inputs: { values: { gain_db: 62 } } }, ss: { inputs: { values: { gain_db: 59 } }, assumptions: ["slow_model"] } },
	experiments: { ac: { adapter: "fake", operation: "run", inputs: { mode: "values", units: { gain_db: "dB" } } } },
	requirements: [{ id: "gain", experiment: "ac", measurement: "gain_db", unit: "dB", op: ">=", limit: 58, conditions: ["tt"], reported: { conditions: ["ss"], reason: "the slow model is not final" } }],
	assumptions: { slow_model: { description: "slow corner model of the kit", value: 1, unit: "" } },
};

test("an answer after a changed answer keeps the statement of the owner and the line on the earlier results", async (t) => {
	const root = designRoot(t);
	const d = recordDecision(root, direction);
	const before = await run(root, { decisions: [d.id] });
	answerDecision(root, d.id, { answer: "changed", by: "owner", statement: "Use two stages" }, new Date("2026-11-28T08:00:00.000Z"));
	const after = await run(root, { decisions: [d.id] });
	const confirmed = answerDecision(root, d.id, { answer: "confirmed", by: "owner" }, new Date("2026-11-28T09:00:00.000Z"));
	assert.equal(confirmed.status, "confirmed");
	assert.equal(currentStatement(confirmed), "Use two stages");
	assert.match(formatOutcome(root, before.experiment, before.result), /^DECISION CHANGED: the owner \(owner\) changed decision \S+ on 2026-11-28T08:00:00.000Z: now "Use two stages"\. This result depended on the earlier statement\./m);
	assert.doesNotMatch(formatOutcome(root, after.experiment, after.result), /DECISION CHANGED|DECISION REVERSED|UNCONFIRMED/);
	assert.match(formatOutcome(root, after.experiment, after.result), /class B, confirmed by owner 2026-11-28T09:00:00.000Z.*: "Use two stages"$/m);
	// A reversal after that marks both results; the line names the reversal.
	answerDecision(root, d.id, { answer: "reversed", by: "owner" }, new Date("2026-11-28T10:00:00.000Z"));
	for (const r of [before, after]) assert.match(formatOutcome(root, r.experiment, r.result), /^DECISION REVERSED: the owner \(owner\) reversed decision \S+ on 2026-11-28T10:00:00.000Z/m);
});

test("an answer is not lost: a lock that this kernel did not write is never removed for its age; a lock of a process that is gone is taken over", async (t) => {
	const root = designRoot(t);
	const d = recordDecision(root, variant);
	const lock = `${recordPath(root, d.id)}.lock`;
	DECISION_LOCK.wait_ms = 300;
	t.after(() => {
		DECISION_LOCK.wait_ms = 5000;
	});
	// A lock directory that is 2 minutes old: its writer can be paused between the read and the write.
	mkdirSync(lock);
	const old = new Date(Date.now() - 120_000);
	utimesSync(lock, old, old);
	assert.throws(() => answerDecision(root, d.id, { answer: "reversed", by: "owner" }), /is locked by another process/);
	assert.deepEqual(readDecisions(root).decisions[0].answers, []);
	assert.equal(existsSync(lock), true);
	rmSync(lock, { recursive: true });
	// A lock of a process of this host that lives: waited for, also when it is old.
	const holder = spawn("node", ["-e", "setTimeout(() => {}, 60000)"]);
	t.after(() => holder.kill());
	symlinkSync(`pid:${holder.pid}:other`, lock);
	assert.throws(() => answerDecision(root, d.id, { answer: "reversed", by: "owner" }), /is locked by another process \(process \d+\)/);
	assert.deepEqual(readDecisions(root).decisions[0].answers, []);
	// The process is gone: its lock is taken over, and the answer is recorded.
	holder.kill();
	await once(holder, "exit");
	assert.equal(answerDecision(root, d.id, { answer: "reversed", by: "owner" }).status, "reversed");
	assert.equal(lstatSync(lock, { throwIfNoEntry: false }), undefined);
});

test("the inbox follows the records: the last answer of the record is named, and a read of an earlier answer keeps a newer one", (t) => {
	const root = designRoot(t);
	const d = recordDecision(root, variant, new Date("2026-11-28T08:00:00.000Z"));
	// The marker file of a waiting decision is lost: the decision is still named.
	rmSync(join(root, "simra/inbox", `decision-${d.id}.json`));
	assert.deepEqual(decisionInbox(root).map((m) => [m.kind, m.decision]), [["decision", d.id]]);
	const first = answerDecision(root, d.id, { answer: "confirmed", by: "owner" }, new Date("2026-11-28T08:10:00.000Z"));
	answerDecision(root, d.id, { answer: "reversed", by: "owner" }, new Date("2026-11-28T08:20:00.000Z"));
	// Another process wrote the marker of the first answer after the second answer, and left a marker of the waiting decision.
	writeFileSync(join(root, "simra/inbox", `answer-${d.id}.json`), JSON.stringify({ schema: "simra.inbox/0", kind: "answer", decision: d.id, class: "A", statement: d.statement, at: "2026-11-28T08:10:00.000Z", answer: "confirmed", by: "owner" }));
	writeFileSync(join(root, "simra/inbox", `decision-${d.id}.json`), JSON.stringify({ schema: "simra.inbox/0", kind: "decision", decision: d.id, class: "A", statement: d.statement, at: d.created_at }));
	assert.deepEqual(decisionInbox(root).map((m) => [m.kind, m.decision, m.answer, m.at]), [["answer", d.id, "reversed", "2026-11-28T08:20:00.000Z"]]);
	// A reader that holds the first answer does not take the second answer out of the inbox.
	assert.deepEqual(ackAnswers(root, [first]), []);
	assert.deepEqual(decisionInbox(root).map((m) => m.answer), ["reversed"]);
	assert.deepEqual(ackAnswers(root, [findDecision(root, d.id)]), [d.id]);
	assert.deepEqual(decisionInbox(root), []);
});

test("a record that is not complete is not read: a run that cites it does not start, and the digest names the file", async (t) => {
	const root = designRoot(t);
	const a = recordDecision(root, variant);
	const b = recordDecision(root, direction);
	const { status: _status, ...noStatus } = json(recordPath(root, a.id));
	writeFileSync(recordPath(root, a.id), JSON.stringify(noStatus));
	writeFileSync(recordPath(root, b.id), JSON.stringify({ ...json(recordPath(root, b.id)), affects: [null] }));
	const { decisions, unreadable } = readDecisions(root);
	assert.deepEqual(decisions, []);
	assert.deepEqual(unreadable.sort(), [`simra/decisions/${a.id}.json`, `simra/decisions/${b.id}.json`].sort());
	await assert.rejects(run(root, { decisions: [a.id] }), new RegExp(`the run did not start: the record of decision ${a.id} cannot be read \\(simra/decisions/${a.id}\\.json\\)`));
	assert.equal(existsSync(join(root, "simra/experiments")), false);
	const digest = spawnSync("node", [cli, "--root", root, "digest"], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	assert.equal(digest.status, 0, digest.stderr);
	for (const id of [a.id, b.id]) assert.match(digest.stdout, new RegExp(`^DECISION RECORD NOT READ: simra/decisions/${id}\\.json`, "m"));
	const list = spawnSync("node", [cli, "--root", root, "decision", "list"], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	for (const id of [a.id, b.id]) assert.match(list.stdout, new RegExp(`^DECISION RECORD NOT READ: simra/decisions/${id}\\.json cannot be read\\.$`, "m"));
	// A status that does not agree with the answers is not a status: class A without an answer waits.
	writeFileSync(recordPath(root, a.id), JSON.stringify({ ...noStatus, status: "confirmed" }));
	assert.deepEqual(readDecisions(root).unreadable.includes(`simra/decisions/${a.id}.json`), true);
});

test("a run that waits in the queue does not start after the owner reverses its decision", async (t) => {
	const root = designRoot(t);
	const lock = join(root, "locks", "heavy.lock");
	const before = process.env.SIMRA_HEAVY_LOCK;
	process.env.SIMRA_HEAVY_LOCK = lock;
	t.after(() => {
		if (before === undefined) delete process.env.SIMRA_HEAVY_LOCK;
		else process.env.SIMRA_HEAVY_LOCK = before;
	});
	const a = recordDecision(root, variant);
	answerDecision(root, a.id, { answer: "confirmed", by: "owner" });
	const held = await acquireHeavyLock({ lock, experiment: "holder", pollMs: 20 });
	assert.ok(held);
	const started = await runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" }, heavy: true, detached: true, decisions: [a.id] });
	for (let i = 0; readStatus(root, started.id)?.status !== "queued" && i < 200; i++) await sleep(25);
	assert.equal(readStatus(root, started.id)?.status, "queued");
	answerDecision(root, a.id, { answer: "reversed", by: "owner" });
	held.release();
	const [outcome] = await waitExperiments(root, [started.id], { timeoutS: 30 });
	assert.equal(outcome.status, "error");
	const dir = join(root, "simra/experiments", started.id);
	const result = json(join(dir, "result.json")) as ResultRecord;
	assert.match(result.errors.join("\n"), new RegExp(`^the adapter did not start: the owner \\(owner\\) reversed decision ${a.id} `));
	assert.equal(existsSync(join(dir, "response.json")), false);
	assert.match(formatOutcome(root, json(join(dir, "experiment.json")), result), /^DECISION REVERSED: /m);
});

test("simra check: an experiment of the requirements file cites its decisions; a decision that waits stops the check before a run", async (t) => {
	const root = designRoot(t);
	const a = recordDecision(root, variant);
	const file = { ...amplifier, experiments: { ac: { ...amplifier.experiments.ac, decisions: [a.id.slice(-6)] } } };
	writeFileSync(join(root, "requirements.json"), JSON.stringify(file));
	await assert.rejects(runCheck({ root }), new RegExp(`the check did not start: experiment "ac": decision ${a.id} \\(class A\\) waits for the owner`));
	assert.equal(existsSync(join(root, "simra/experiments")), false);
	assert.equal(existsSync(join(root, "simra/checks")), false);
	answerDecision(root, a.id, { answer: "confirmed", by: "owner" });
	const { verdict } = await runCheck({ root });
	assert.equal(verdict.experiments.length, 2);
	for (const e of verdict.experiments) assert.deepEqual(json(join(root, "simra/experiments", e.id, "experiment.json")).decisions, [a.id]);
	// The reversal marks the check through its experiments.
	const reversed = answerDecision(root, a.id, { answer: "reversed", by: "owner" });
	assert.ok(reversed.answers[1].marked.some((m) => m.kind === "check" && m.id === verdict.id));
	const errors = validateRequirements({ ...file, experiments: { ac: { ...file.experiments.ac, decisions: "x" } } } as never);
	assert.match(errors.join("\n"), /experiment "ac": decisions must be a list of decision ids/);
});

test("a result depends on a decision through the file of its pass rule, and a check through a reported row", async (t) => {
	const root = designRoot(t);
	writeFileSync(join(root, "rule.txt"), "gain_db >= 58\n");
	const ruled = await run(root, { passRule: { id: "gain", file: "rule.txt" } });
	const byFile = recordDecision(root, { ...variant, statement: "Lower the gain limit", affects: ["pass_rule:rule.txt"] });
	assert.match(formatOutcome(root, ruled.experiment, ruled.result), new RegExp(`^UNCONFIRMED DECISION: this result rests on decision ${byFile.id} `, "m"));
	rmSync(recordPath(root, byFile.id));
	const byId = recordDecision(root, { ...variant, statement: "Lower the gain limit", affects: ["pass_rule:gain"] });
	assert.deepEqual(decisionDependents(root, byId), [{ kind: "experiment", id: ruled.id, via: "pass rule gain" }]);
	rmSync(recordPath(root, byId.id));
	// A file of the design root is "." or a path under it.
	const everything = recordDecision(root, { ...direction, affects: ["file:."] });
	assert.deepEqual(decisionDependents(root, everything).map((m) => m.id), [ruled.id]);
	rmSync(recordPath(root, everything.id));

	writeFileSync(join(root, "requirements.json"), JSON.stringify(amplifier));
	const { verdict } = await runCheck({ root });
	assert.deepEqual(verdict.reported?.map((r) => [r.condition, r.value, r.assumptions]), [["ss", 59, ["slow_model"]]]);
	const model = recordDecision(root, { ...variant, statement: "Use the draft slow model", affects: ["assumption:slow_model"] });
	assert.match(formatVerdict(root, verdict), new RegExp(`^UNCONFIRMED DECISION: this check rests on decision ${model.id} `, "m"));
	assert.deepEqual(decisionDependents(root, model), [{ kind: "check", id: verdict.id, via: "assumption slow_model (reported row)" }]);
});

test("a run without a result is not a result: it is counted apart, and its mark says so", async (t) => {
	const root = designRoot(t);
	const d = recordDecision(root, direction);
	const done = await run(root, { decisions: [d.id] });
	const open = await run(root, { decisions: [d.id] });
	rmSync(join(root, "simra/experiments", open.id, "result.json"));
	assert.deepEqual(decisionDependents(root, d), [
		{ kind: "experiment", id: done.id, via: "cited by the run" },
		{ kind: "experiment", id: open.id, via: "cited by the run", no_result: true },
	]);
	assert.equal(buildDigest(root, new Date(Date.now() - 3_600_000)).listed[0].dependents, 1);
	assert.match(formatDecision(root, d), /^ {2}results that rest on it now: 1\n {4}experiment \S+ \(cited by the run\)\n {2}runs without a result that rest on it now: 1\n/m);
	const reversed = answerDecision(root, d.id, { answer: "reversed", by: "owner" });
	assert.deepEqual(reversed.answers[0].marked.map((m) => m.no_result ?? false), [false, true]);
	assert.match(formatDecision(root, reversed), /marked 1 result that depended on it, and 1 run without a result:/);
	assert.match(formatDigest(buildDigest(root, new Date(Date.now() - 3_600_000))), /^ {2}B \w{6} reversed by owner: /m);
});

test("evidence: a link to a file outside the design root is refused; a file name that starts with two dots is a file of the root", (t) => {
	const root = designRoot(t);
	const outside = mkdtempSync(join(tmpdir(), "simra-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	writeFileSync(join(outside, "secret.txt"), "abc");
	symlinkSync(join(outside, "secret.txt"), join(root, "alias"));
	assert.throws(() => recordDecision(root, { ...direction, evidence: ["alias"] }), /the evidence alias is a link to a file that is not in the design root/);
	assert.deepEqual(listDecisions(root), []);
	writeFileSync(join(root, "report.txt"), "abc");
	symlinkSync(join(root, "report.txt"), join(root, "inside"));
	writeFileSync(join(root, "..timing"), "abc");
	const d = recordDecision(root, { ...direction, evidence: ["inside", "..timing"] });
	assert.deepEqual(d.evidence.map((e) => [e.path, e.bytes]), [["inside", 3], ["..timing", 3]]);
});

test("a decision that names an experiment or a check that is not there is refused", async (t) => {
	const root = designRoot(t);
	assert.throws(() => recordDecision(root, { ...direction, affects: ["experiment:20261128-000000-aaaaaa"] }), /affects names the experiment 20261128-000000-aaaaaa, and simra\/experiments has no such record/);
	assert.throws(() => recordDecision(root, { ...direction, affects: ["check:20261128-000000-bbbbbb"] }), /affects names the check 20261128-000000-bbbbbb, and simra\/checks has no such record/);
	assert.equal(listDecisions(root).length, 0);
	const done = await run(root);
	assert.equal(recordDecision(root, { ...direction, affects: [`experiment:${done.id}`] }).affects[0].ref, done.id);
});

test("simra decision answer: an option without its value is an error, and nothing is recorded", (t) => {
	const root = designRoot(t);
	const d = recordDecision(root, variant);
	const simra = (...args: string[]) => spawnSync("node", [cli, "--root", root, ...args], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	const bad = simra("decision", "answer", d.id, "confirmed", "--by", "--note", "owner");
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /simra: the option --by needs a value/);
	assert.deepEqual(readDecisions(root).decisions[0].answers, []);
	const good = simra("decision", "answer", d.id, "confirmed", "--by", "Ada Owner", "--note", "by phone");
	assert.equal(good.status, 0, good.stderr);
	assert.equal(readDecisions(root).decisions[0].answers[0].by, "Ada Owner");
});
