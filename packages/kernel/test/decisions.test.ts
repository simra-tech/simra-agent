// Decision records: the class rule (A waits for the owner, B is listed, C is logged), the gate of a run that cites a
// decision, the lines on a result that rests on a decision, the answer of the owner, and the marks of a changed or
// reversed decision. On the fake adapter.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	answerDecision,
	citeDecisions,
	type DecisionInput,
	type DecisionRecord,
	decisionDependents,
	experimentDecisionFlags,
	findDecision,
	formatDecision,
	formatDecisionInbox,
	formatOutcome,
	formatRecorded,
	formatVerdict,
	listDecisions,
	readDecisionInbox,
	readDecisions,
	readInbox,
	recordDecision,
	runCheck,
	runExperiment,
	runJobs,
	validateDecision,
} from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

function designRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "simra-decision-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	return root;
}
const run = (root: string, extra: Record<string, unknown> = {}, opts: { decisions?: string[]; passRule?: { id?: string; text?: string } } = {}) =>
	runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok", ...extra }, purpose: "decision test", ...opts });

const variant: DecisionInput = {
	class: "A",
	statement: "Keep the carry-select adder and drop the ripple adder",
	alternative: "the ripple adder: half the area, two times the delay",
	why: "the ripple adder does not meet the clock period at the slow corner",
	reverse: "restore rtl/adder_ripple.v and run synthesis again (about 1 hour)",
	affects: [{ kind: "file", ref: "rtl/adder.v" }, "claim:the block meets 100 MHz"],
};
const direction: DecisionInput = {
	class: "B",
	statement: "Use a two-stage pipeline for the multiplier",
	alternative: "one stage with a relaxed clock",
	why: "the one-stage version fails setup by 0.4 ns",
	reverse: "remove the pipeline register and the valid delay (one day of work)",
	affects: ["file:rtl/mul.v"],
};
const routine: DecisionInput = { class: "C", statement: "Name the scratch run directory runs/try3", why: "try2 exists" };

test("class A waits for the owner and enters the inbox; class B and C are adopted by policy and do not", (t) => {
	const root = designRoot(t);
	mkdirSync(join(root, "reports"));
	writeFileSync(join(root, "reports/timing.txt"), "slack -0.31 ns at the slow corner\n");
	const a = recordDecision(root, { ...variant, evidence: ["reports/timing.txt"], decided_by: "agent 2" });
	assert.equal(a.schema, "simra.decision/0");
	assert.equal(a.status, "waiting for owner");
	assert.equal(a.authority, "policy");
	assert.deepEqual(a.answers, []);
	assert.equal(a.evidence[0].path, "reports/timing.txt");
	assert.match(a.evidence[0].sha256, /^[0-9a-f]{64}$/);
	assert.deepEqual(a.affects, [{ kind: "file", ref: "rtl/adder.v" }, { kind: "claim", ref: "the block meets 100 MHz" }]);
	// The record is a plain file that another tool can read.
	const onDisk = JSON.parse(readFileSync(join(root, "simra/decisions", `${a.id}.json`), "utf8")) as DecisionRecord;
	assert.deepEqual(onDisk, a);
	assert.deepEqual(readDecisionInbox(root).map((m) => [m.kind, m.decision, m.class]), [["decision", a.id, "A"]]);
	assert.match(formatRecorded(root, a), /^STOP: this is a class A decision\. It waits for the owner\./m);

	const b = recordDecision(root, direction);
	const c = recordDecision(root, routine);
	assert.equal(b.status, "adopted");
	assert.equal(c.status, "adopted");
	assert.equal(c.alternative, null);
	assert.equal(readDecisionInbox(root).length, 1, "only the class A decision is in the inbox");
	assert.doesNotMatch(formatRecorded(root, b), /STOP/);
	assert.match(formatDecision(root, b), /class B, adopted by policy \(no answer of the owner\)/);
	assert.deepEqual(listDecisions(root).map((d) => d.class).sort(), ["A", "B", "C"]);
	// The markers of decisions are not ended runs.
	assert.deepEqual(readInbox(root), []);
});

test("an invalid decision names every problem and writes nothing", (t) => {
	const root = designRoot(t);
	const errors = validateDecision({ class: "A", statement: " ", why: "" } as DecisionInput);
	assert.deepEqual(errors, [
		"statement is required: what was decided",
		"why is required",
		"alternative is required for class A: the alternative that was not taken",
		"reverse is required for class A: how to reverse the decision, and what that costs",
		"affects is required for class A: name at least one experiment, check, pass_rule, file, requirement, assumption or claim",
	]);
	assert.match(validateDecision({ ...routine, class: "D" } as unknown as DecisionInput)[0], /^class is "D", expected A /);
	assert.match(validateDecision({ ...routine, cost: 3 } as unknown as DecisionInput)[0], /^cost: unknown field/);
	assert.match(validateDecision({ ...direction, affects: ["rtl/mul.v"] })[0], /^affects entry "rtl\/mul.v": give \{kind, ref\} or "kind:ref"/);
	assert.throws(() => recordDecision(root, { class: "B", statement: "x", why: "y" } as DecisionInput), /invalid decision:\n- alternative is required for class B/);
	assert.equal(existsSync(join(root, "simra/decisions")), false);
});

test("the class has a floor: a claim makes class A, and a pass rule, a requirement or an assumption makes at least class B", () => {
	assert.deepEqual(validateDecision({ ...direction, affects: ["claim:the block meets 100 MHz"] }), ["class B with a claim in affects: a decision that affects a claim for a reader outside the project is class A"]);
	assert.deepEqual(validateDecision({ ...routine, affects: ["pass_rule:timing", "requirement:setup"] }), ["class C with pass_rule, requirement in affects: a decision that changes what passes is class B or A"]);
	assert.deepEqual(validateDecision({ ...routine, affects: ["assumption:tx_leak"] }), ["class C with assumption in affects: a decision that changes what passes is class B or A"]);
	// Negative control: the same lists are valid at the class of the floor.
	assert.deepEqual(validateDecision({ ...variant, affects: ["claim:the block meets 100 MHz"] }), []);
	assert.deepEqual(validateDecision({ ...direction, affects: ["pass_rule:timing", "requirement:setup"] }), []);
	assert.deepEqual(validateDecision({ ...routine, affects: ["file:runs/try3"] }), []);
});

test("evidence is a file of the design root with its hash, or the id of an experiment; a path to nothing stops the record", async (t) => {
	const root = designRoot(t);
	assert.throws(() => recordDecision(root, { ...direction, evidence: ["reports/none.txt"] }), /the evidence reports\/none\.txt is not a file of the design root/);
	assert.throws(() => recordDecision(root, { ...direction, evidence: ["../outside.txt"] }), /the evidence \.\.\/outside\.txt is not in the design root/);
	assert.throws(() => recordDecision(root, { ...direction, affects: ["file:../../etc/passwd"] }), /is not in the design root/);
	assert.equal(listDecisions(root).length, 0);
	const done = await run(root);
	const d = recordDecision(root, { ...direction, evidence: [done.id] });
	assert.equal(d.evidence[0].path, join("simra/experiments", done.id, "result.json"));
	// The evidence changes after the decision: the text of the decision says so.
	writeFileSync(join(root, d.evidence[0].path), "{}\n");
	assert.match(formatDecision(root, d), /evidence: simra\/experiments\/.*result\.json sha256:[0-9a-f]{12} \(changed after the decision, now sha256:[0-9a-f]{12}\)/);
});

test("a run that cites a class A decision that waits does not start; after the owner confirms, it starts and records the decision", async (t) => {
	const root = designRoot(t);
	const a = recordDecision(root, variant);
	await assert.rejects(run(root, {}, { decisions: [a.id] }), new RegExp(`the run did not start: decision ${a.id} \\(class A\\) waits for the owner`));
	assert.equal(existsSync(join(root, "simra/experiments")), false, "no experiment record of a run that did not start");
	await assert.rejects(run(root, {}, { decisions: ["ffffff"] }), /decision "ffffff" is not in simra\/decisions/);
	answerDecision(root, a.id, { answer: "confirmed", by: "owner" });
	// The end of the id is enough to cite it.
	const done = await run(root, {}, { decisions: [a.id.slice(-6)] });
	assert.deepEqual(done.experiment.decisions, [a.id]);
	const summary = formatOutcome(root, done.experiment, done.result);
	assert.match(summary, new RegExp(`^decision: ${a.id} class A, confirmed by owner .*: "Keep the carry-select adder and drop the ripple adder"$`, "m"));
	assert.doesNotMatch(summary, /UNCONFIRMED DECISION|DECISION REVERSED|DECISION CHANGED/);
	// A class B decision does not stop a run: the summary names it and says that the owner did not answer.
	const b = recordDecision(root, direction);
	const withB = await run(root, {}, { decisions: [b.id] });
	assert.match(formatOutcome(root, withB.experiment, withB.result), new RegExp(`^decision: ${b.id} class B, adopted by policy \\(no answer of the owner\\)`, "m"));
	// A reversed decision stops a run that cites it.
	answerDecision(root, b.id, { answer: "reversed", by: "owner" });
	await assert.rejects(run(root, {}, { decisions: [b.id] }), /the run did not start: the owner \(owner\) reversed decision/);
	assert.throws(() => citeDecisions(root, [""]), /give a list of decision ids/);
});

test("a result that rests on an unconfirmed class A decision has the line UNCONFIRMED DECISION; another result has none", async (t) => {
	const root = designRoot(t);
	mkdirSync(join(root, "rtl"));
	writeFileSync(join(root, "rtl/adder.v"), "module adder; endmodule\n");
	const onFile = await run(root, { deck: "rtl/adder.v" });
	const onRule = await run(root, {}, { passRule: { id: "timing", text: "setup slack >= 0 ns" } });
	const other = await run(root, { deck: "rtl/mul.v" }, { passRule: { id: "area", text: "area <= 1000 um2" } });
	// Negative control: without a decision, no summary has a decision line.
	for (const o of [onFile, onRule, other]) assert.doesNotMatch(formatOutcome(root, o.experiment, o.result), /DECISION|^decision:/m);

	const a = recordDecision(root, { ...variant, affects: ["file:rtl/adder.v", "pass_rule:timing"] });
	const line = new RegExp(`^UNCONFIRMED DECISION: this result rests on decision ${a.id} \\(class A, waiting for owner since .*\\): "Keep the carry-select adder and drop the ripple adder"\\. The owner did not confirm it\\.$`, "m");
	assert.match(formatOutcome(root, onFile.experiment, onFile.result), line);
	assert.match(formatOutcome(root, onRule.experiment, onRule.result), line);
	assert.doesNotMatch(formatOutcome(root, other.experiment, other.result), /DECISION/);
	assert.deepEqual(decisionDependents(root, a).map((m) => [m.kind, m.id, m.via]), [
		["experiment", onFile.id, "file rtl/adder.v"],
		["experiment", onRule.id, "pass rule timing"],
	]);
	// A class B decision on the same file gives no flag: it is listed, not waited for.
	recordDecision(root, { ...direction, affects: ["file:rtl/adder.v"] });
	assert.equal(experimentDecisionFlags(root, onFile.experiment, onFile.result).length, 1);
	// The owner confirms: the line goes.
	answerDecision(root, a.id, { answer: "confirmed", by: "owner", note: "agreed in the review" });
	assert.doesNotMatch(formatOutcome(root, onFile.experiment, onFile.result), /DECISION/);
	assert.equal(findDecision(root, a.id).authority, "owner");
});

test("the answer of the owner is on the record; a reversed decision marks the results that depended on it", async (t) => {
	const root = designRoot(t);
	const b = recordDecision(root, direction);
	const cited = await run(root, {}, { decisions: [b.id] });
	const onFile = await run(root, { deck: "rtl/mul.v" });
	const other = await run(root, { deck: "rtl/adder.v" });
	const at = new Date("2026-11-28T09:30:00.000Z");
	const answered = answerDecision(root, b.id.slice(-6), { answer: "reversed", by: "owner", note: "the latency budget does not allow a second stage", via: "session" }, at);
	assert.equal(answered.status, "reversed");
	assert.equal(answered.authority, "owner");
	assert.deepEqual(answered.answers, [
		{
			answer: "reversed",
			at: "2026-11-28T09:30:00.000Z",
			by: "owner",
			via: "session",
			terminal: false,
			note: "the latency budget does not allow a second stage",
			marked: [
				{ kind: "experiment", id: cited.id, via: "cited by the run" },
				{ kind: "experiment", id: onFile.id, via: "file rtl/mul.v" },
			],
		},
	]);
	assert.deepEqual(findDecision(root, b.id), answered, "the answer is in the file");
	const line = new RegExp(`^DECISION REVERSED: the owner \\(owner\\) reversed decision ${b.id} on 2026-11-28T09:30:00.000Z: "Use a two-stage pipeline for the multiplier"\\. This result depended on it\\. Do not use it for a claim\\.$`, "m");
	assert.match(formatOutcome(root, cited.experiment, cited.result), line);
	assert.match(formatOutcome(root, onFile.experiment, onFile.result), line);
	assert.doesNotMatch(formatOutcome(root, other.experiment, other.result), /DECISION/);
	// A run on the same file after the reversal is not marked: the answer marks the results that existed.
	const later = await run(root, { deck: "rtl/mul.v" });
	assert.doesNotMatch(formatOutcome(root, later.experiment, later.result), /DECISION/);
	assert.match(formatDecision(root, answered), /answer: reversed by owner, 2026-11-28T09:30:00.000Z \(command of the user in a session\): the latency budget does not allow a second stage\n\s+marked 2 results that depended on it:/);
});

test("a changed decision needs the statement of the owner, marks the earlier results, and lets a new run cite it", async (t) => {
	const root = designRoot(t);
	const a = recordDecision(root, { ...variant, affects: ["pass_rule:timing"] });
	const before = await run(root, {}, { passRule: { id: "timing", text: "setup slack >= 0 ns" } });
	assert.throws(() => answerDecision(root, a.id, { answer: "changed", by: "owner" }), /answer changed: give the statement that replaces the decision/);
	assert.throws(() => answerDecision(root, a.id, { answer: "confirmed", by: "owner", statement: "x" }), /statement is for the answer changed only/);
	assert.throws(() => answerDecision(root, a.id, { answer: "confirmed", by: " " }), /give who answers/);
	assert.throws(() => answerDecision(root, a.id, { answer: "approved" as "confirmed", by: "owner" }), /answer is "approved", expected confirmed, changed, reversed/);
	assert.equal(findDecision(root, a.id).status, "waiting for owner", "a refused answer changes nothing");
	const changed = answerDecision(root, a.id, { answer: "changed", by: "owner", statement: "Keep both adders until the routed timing exists" });
	assert.equal(changed.statement, variant.statement, "the statement of the agent stays in the record");
	assert.equal(changed.answers[0].statement, "Keep both adders until the routed timing exists");
	assert.match(formatOutcome(root, before.experiment, before.result), new RegExp(`^DECISION CHANGED: the owner \\(owner\\) changed decision ${a.id} on .*: now "Keep both adders until the routed timing exists"\\. This result depended on the earlier statement\\. Judge it again, or run again\\.$`, "m"));
	const after = await run(root, {}, { decisions: [a.id] });
	const summary = formatOutcome(root, after.experiment, after.result);
	assert.match(summary, /^decision: .* class A, changed by owner .*: "Keep both adders until the routed timing exists"$/m);
	assert.doesNotMatch(summary, /DECISION CHANGED|UNCONFIRMED/);
	// The owner can answer again: the status is the last answer, and the earlier answer stays.
	const again = answerDecision(root, a.id, { answer: "confirmed", by: "owner" });
	assert.deepEqual(again.answers.map((x) => x.answer), ["changed", "confirmed"]);
	assert.doesNotMatch(formatOutcome(root, before.experiment, before.result), /DECISION/);
});

const amplifier = {
	schema: "simra.requirements/0",
	conditions: { tt: { inputs: { values: { gain_db: 62 } } }, ss: { inputs: { values: { gain_db: 59 } }, assumptions: ["load"] } },
	experiments: { ac: { adapter: "fake", operation: "run", inputs: { mode: "values", units: { gain_db: "dB" } } } },
	requirements: [{ id: "gain", experiment: "ac", measurement: "gain_db", unit: "dB", op: ">=", limit: 58, conditions: ["tt", "ss"] }],
	assumptions: { load: { description: "load of the next stage", value: 2, unit: "pF" } },
};

test("a check rests on a decision through a requirement, an assumption, the requirements file or one of its experiments", async (t) => {
	const root = designRoot(t);
	writeFileSync(join(root, "requirements.json"), JSON.stringify(amplifier));
	const { verdict } = await runCheck({ root });
	assert.equal(verdict.status, "pass");
	assert.doesNotMatch(formatVerdict(root, verdict), /DECISION/);
	const cases: [string, string][] = [
		["requirement:gain", "requirement gain"],
		["assumption:load", "assumption load"],
		["file:requirements.json", "file requirements.json"],
		[`check:${verdict.id}`, "named by the decision"],
		[`experiment:${verdict.experiments[1].id}`, `experiment ${verdict.experiments[1].id}`],
	];
	for (const [affect, via] of cases) {
		const d = recordDecision(root, { ...variant, statement: `Lower the gain limit (${affect})`, affects: [affect] });
		assert.deepEqual(decisionDependents(root, d).filter((m) => m.kind === "check"), [{ kind: "check", id: verdict.id, via }], affect);
		assert.match(formatVerdict(root, verdict), new RegExp(`^UNCONFIRMED DECISION: this check rests on decision ${d.id} `, "m"), affect);
		const reversed = answerDecision(root, d.id, { answer: "reversed", by: "owner" });
		assert.ok(reversed.answers[0].marked.some((m) => m.kind === "check" && m.id === verdict.id), affect);
		assert.match(formatVerdict(root, verdict), new RegExp(`^DECISION REVERSED: the owner \\(owner\\) reversed decision ${d.id} .*This check depended on it\\.`, "m"), affect);
		rmSync(join(root, "simra/decisions", `${d.id}.json`));
	}
	// Negative control: a decision on another requirement does not touch the check.
	const other = recordDecision(root, { ...variant, affects: ["requirement:noise", "file:rtl/adder.v"] });
	assert.deepEqual(decisionDependents(root, other), []);
	assert.doesNotMatch(formatVerdict(root, verdict), /DECISION/);
	// The status of the check does not change: the line is a statement, not a verdict.
	assert.equal(verdict.status, "pass");
});

test("the inbox: a waiting decision is named until the owner answers, then the answer is named until it is read", (t) => {
	const root = designRoot(t);
	assert.equal(formatDecisionInbox(readDecisionInbox(root)), "");
	const a = recordDecision(root, variant, new Date("2026-11-28T08:00:00.000Z"));
	assert.equal(
		formatDecisionInbox(readDecisionInbox(root)),
		[
			"inbox: 1 class A decision waits for the owner. Work that depends on it does not start.",
			`  ${a.id}: Keep the carry-select adder and drop the ripple adder (since 2026-11-28T08:00:00.000Z)`,
			"the owner answers: simra decision answer <id> confirmed|changed|reversed --by <name>",
		].join("\n"),
	);
	answerDecision(root, a.id, { answer: "confirmed", by: "owner" }, new Date("2026-11-28T08:45:00.000Z"));
	assert.equal(
		formatDecisionInbox(readDecisionInbox(root)),
		["inbox: the owner answered 1 decision, and the answer was not read", `  ${a.id}: confirmed by owner, 2026-11-28T08:45:00.000Z: Keep the carry-select adder and drop the ripple adder`, "read: simra decision show <id>"].join("\n"),
	);
	// The command line: show reads the answer, and the marker leaves the inbox.
	const show = spawnSync("node", [cli, "--root", root, "decision", "show", a.id.slice(-6)], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	assert.equal(show.status, 0, show.stderr);
	assert.match(show.stdout, /class A, confirmed by owner/);
	assert.deepEqual(readDecisionInbox(root), []);
});

test("a decision is found by its id, its start or its end; two matches are an error", (t) => {
	const root = designRoot(t);
	const first = recordDecision(root, routine, new Date("2026-11-28T08:00:00.000Z"));
	const second = recordDecision(root, routine, new Date("2026-11-28T08:00:00.000Z"));
	assert.notEqual(first.id, second.id);
	assert.equal(findDecision(root, first.id.slice(-6)).id, first.id);
	assert.throws(() => findDecision(root, "20261128-0800"), /2 decisions match/);
	assert.throws(() => findDecision(root, "abc"), /give the id, or at least 4 characters/);
	// A record that cannot be read is named, not dropped without a word.
	writeFileSync(join(root, "simra/decisions/20261128-090000-zzzzzz.json"), "{not json");
	const { decisions, unreadable } = readDecisions(root);
	assert.equal(decisions.length, 2);
	assert.deepEqual(unreadable, ["simra/decisions/20261128-090000-zzzzzz.json"]);
});

test("simra decide: class A exits with 3 and says STOP; class B exits with 0; an answer needs --by", (t) => {
	const root = designRoot(t);
	const simra = (...args: string[]) => spawnSync("node", [cli, "--root", root, ...args], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	writeFileSync(join(root, "a.json"), JSON.stringify(variant));
	writeFileSync(join(root, "b.json"), JSON.stringify(direction));
	writeFileSync(join(root, "bad.json"), JSON.stringify({ class: "A", statement: "x", why: "y" }));
	const a = simra("decide", join(root, "a.json"));
	assert.equal(a.status, 3, a.stderr);
	assert.match(a.stdout, /class A, waiting for owner[\s\S]*^STOP: this is a class A decision/m);
	const b = simra("decide", join(root, "b.json"));
	assert.equal(b.status, 0, b.stderr);
	assert.match(b.stdout, /Class B: the work continues\. The decision is listed for the owner \(simra digest\)\./);
	const bad = simra("decide", join(root, "bad.json"));
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /simra: invalid decision:\n- alternative is required for class A/);
	const id = /^decision (\S+): class A/.exec(a.stdout)?.[1] as string;
	assert.equal(readdirSync(join(root, "simra/decisions")).length, 2);
	const inbox = simra("inbox");
	assert.match(inbox.stdout, /^inbox: no ended run waits for a read\ninbox: 1 class A decision waits for the owner/);
	const noName = simra("decision", "answer", id, "confirmed");
	assert.equal(noName.status, 1);
	assert.match(noName.stderr, /give who answers with --by <name>/);
	const answer = simra("decision", "answer", id, "changed", "--by", "owner", "--statement", "Keep both adders", "--note", "see the review");
	assert.equal(answer.status, 0, answer.stderr);
	// The command did not run in a terminal: the record says so.
	assert.match(answer.stdout, /answer: changed by owner, .* \(command line, not from a terminal\): see the review\n\s+statement of the owner: Keep both adders/);
	const list = simra("decision", "list", "--class", "a");
	assert.match(list.stdout, new RegExp(`^A ${id} changed \\(owner\\): "Keep both adders"$`, "m"));
	assert.doesNotMatch(list.stdout, /^B /m);
	assert.match(simra("decision", "list", "--status", "waiting").stdout, /^no decision is recorded/);
});

test("run_jobs: a job that cites a waiting class A decision does not start; the other job runs", async (t) => {
	const root = designRoot(t);
	const a = recordDecision(root, variant);
	const outcome = await runJobs({
		root,
		jobs: [
			{ adapter: "fake", operation: "run", inputs: { mode: "ok" }, decisions: [a.id] },
			{ adapter: "fake", operation: "run", inputs: { mode: "ok" } },
		],
	});
	assert.deepEqual(outcome.jobs.map((j) => j.status), ["error", "completed"]);
	assert.match(outcome.jobs[0].errors[0], /the run did not start: decision .* \(class A\) waits for the owner/);
});
