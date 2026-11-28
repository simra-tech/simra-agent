// The owner digest on the fixture test/fixtures/owner-digest (records of an invented session on the public example
// block acc): the text for a given time, what a later time leaves out and keeps, and the command line.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerDecision, buildDigest, formatDigest, formatOutcome, parseSince, recordDecision, runCheck, runExperiment } from "../src/index.ts";

const fixture = new URL("./fixtures/owner-digest/", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const now = new Date("2026-11-28T07:30:00Z");

/** Every file under a directory with its size and modification time: the digest must change none. */
function tree(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => {
			const path = join(e.parentPath, e.name);
			return `${path} ${statSync(path).size} ${statSync(path).mtimeMs}`;
		})
		.sort();
}

test("the digest of the fixture since 2026-11-27 is the expected text, short enough for a small screen, and writes nothing", () => {
	const before = tree(fixture);
	const digest = buildDigest(fixture, new Date("2026-11-27T00:00:00Z"), now);
	const text = formatDigest(digest);
	assert.equal(`${text}\n`, readFileSync(join(fixture, "expected-digest.txt"), "utf8"));
	assert.ok(text.split("\n").length <= 40, `${text.split("\n").length} lines`);
	assert.ok(Math.max(...text.split("\n").map((l) => l.length)) <= 200);
	assert.deepEqual(tree(fixture), before);

	// The class A decision of 2026-11-20 is older than the time of the digest. It waits, so it is in the digest.
	assert.deepEqual(digest.waiting.map((w) => [w.decision.id, w.dependents]), [["20261120-141000-a1b2c3", 4]]);
	assert.deepEqual(digest.answered.map((w) => w.decision.status), ["confirmed", "reversed"]);
	// The class B decision of 2026-11-10 is older and has no answer since: it is not in the digest.
	assert.deepEqual(digest.listed.map((w) => w.decision.id), ["20261127-120000-7f8e9d"]);
	assert.equal(digest.logged, 1);
	assert.deepEqual(digest.unreadable, ["simra/decisions/20261127-130000-ffffff.json"]);
	// The run of 2026-11-10 ended before the time of the digest.
	assert.deepEqual(digest.counts, { experiments: 5, checks: 1 });
	assert.deepEqual(digest.pass_rule.changed.map((r) => r.id), ["20261127-130000-d4e5f6", "20261127-140000-a7b8c9"]);
	assert.deepEqual(digest.pass_rule.failed.map((r) => [r.kind, r.id]), [["openroad.timing", "20261127-140000-a7b8c9"], ["check", "20261127-133000-9a8b7c"]]);
	assert.equal(digest.pass_rule.not_applied, 3);
	assert.deepEqual(digest.not_run.map((n) => [n.where, n.count]), [["run 20261127-140000-a7b8c9 openroad.timing", 1], ["check 20261127-133000-9a8b7c", 3]]);
	assert.deepEqual(digest.not_completed, { failed: 1, timeout: 1 });
});

test("negative control: a time after the last record leaves only the decision that waits, and no result", () => {
	const digest = buildDigest(fixture, new Date("2026-11-28T00:00:00Z"), now);
	assert.deepEqual(digest.waiting.map((w) => w.decision.id), ["20261120-141000-a1b2c3"]);
	assert.deepEqual([digest.answered.length, digest.listed.length, digest.logged], [0, 0, 0]);
	assert.deepEqual(digest.counts, { experiments: 0, checks: 0 });
	assert.deepEqual([digest.pass_rule.changed.length, digest.pass_rule.failed.length, digest.pass_rule.not_applied, digest.not_run.length], [0, 0, 0, 0]);
	const text = formatDigest(digest);
	assert.match(text, /^WAITING FOR OWNER: 1 class A decision$/m);
	assert.match(text, /^PASS RULE: 0 changed, 0 failed$/m);
	assert.match(text, /^NOT RUN: 0 items in 0 records$/m);
	// The record that cannot be read is named at every time: it could be a decision that waits.
	assert.match(text, /^DECISION RECORD NOT READ: simra\/decisions\/20261127-130000-ffffff\.json/m);
});

test("an answer since the time brings an older decision back into the digest; a long list is cut and its count is not", (t) => {
	const root = mkdtempSync(join(tmpdir(), "simra-digest-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	cpSync(fixture, root, { recursive: true });
	answerDecision(root, "112233", { answer: "confirmed", by: "owner" }, new Date("2026-11-28T06:00:00Z"));
	answerDecision(root, "a1b2c3", { answer: "changed", by: "owner", statement: "State the clock rate as an estimate of the global route" }, new Date("2026-11-28T06:10:00Z"));
	const digest = buildDigest(root, new Date("2026-11-28T00:00:00Z"), now);
	assert.deepEqual(digest.waiting, []);
	assert.deepEqual(digest.listed.map((w) => w.decision.id), ["20261110-080000-112233"]);
	const text = formatDigest(digest);
	assert.match(text, /^  A a1b2c3 changed by owner 2026-11-28 06:10; marked 4 results: State the clock rate as an estimate of the global route$/m);
	assert.match(text, /^  B 112233 confirmed by owner: Set the core utilization of acc to 40 %$/m);
	// Eight more class A decisions wait: five are shown, and the count is eight.
	for (let i = 0; i < 8; i++) {
		recordDecision(root, { class: "A", statement: `Report number ${i} to the partner`, alternative: "wait", why: "the report is due", reverse: "send a correction", affects: [`claim:number ${i}`] }, new Date(Date.parse("2026-11-28T07:00:00Z") + i * 1000));
	}
	const long = formatDigest(buildDigest(root, new Date("2026-11-28T00:00:00Z"), now));
	assert.match(long, /^WAITING FOR OWNER: 8 class A decisions$/m);
	assert.equal(long.match(/^  A \w{6} since /gm)?.length, 5);
	assert.match(long, /^  \.\.\. 3 more \(simra decision list --class A --status waiting\)$/m);
});

test("parseSince takes an ISO time or a duration, and refuses another text", () => {
	assert.equal(parseSince("2026-11-27T18:00:00Z", now).toISOString(), "2026-11-27T18:00:00.000Z");
	assert.equal(parseSince("2026-11-27", now).toISOString(), "2026-11-27T00:00:00.000Z");
	assert.equal(parseSince("90m", now).toISOString(), "2026-11-28T06:00:00.000Z");
	assert.equal(parseSince("24h", now).toISOString(), "2026-11-27T07:30:00.000Z");
	assert.equal(parseSince("3d", now).toISOString(), "2026-11-25T07:30:00.000Z");
	assert.equal(parseSince("2w", now).toISOString(), "2026-11-14T07:30:00.000Z");
	for (const bad of ["yesterday", "24", "h", "", "27.11.2026"]) assert.throws(() => parseSince(bad, now), /give an ISO date or time/, bad);
});

test("simra digest prints the digest; --json gives the record; a wrong time is an error", () => {
	const simra = (...args: string[]) => spawnSync("node", [cli, "--root", fixture, ...args], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	const text = simra("digest", "--since", "2026-11-27");
	assert.equal(text.status, 0, text.stderr);
	assert.match(text.stdout, /^digest of owner-digest since 2026-11-27 00:00 UTC /);
	assert.match(text.stdout, /^WAITING FOR OWNER: 1 class A decision\n  A a1b2c3 since 2026-11-20 14:10: /m);
	const json = simra("digest", "--since", "2026-11-27", "--json");
	assert.equal(JSON.parse(json.stdout).waiting[0].decision.id, "20261120-141000-a1b2c3");
	const bad = simra("digest", "--since", "last week");
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /simra: since "last week": give an ISO date or time/);
});

const adapters = new URL("./fixtures/adapters", import.meta.url).pathname;
const hourAgo = () => new Date(Date.now() - 3_600_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function designRoot(t: { after: (fn: () => void) => void }, requirements?: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "simra-digest-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [adapters] }));
	if (requirements) writeFileSync(join(root, "requirements.json"), JSON.stringify(requirements));
	return root;
}

test("NOT RUN: two checks of one run that did not run are two items, and one check that is recorded two times is one item", async (t) => {
	const root = designRoot(t);
	const values = (inputs: Record<string, unknown>) => runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "values", values: {}, ...inputs } });
	const two = await values({ report: ["timing check: not run"], diagnostics: [{ severity: "warning", message: "pin check: not run" }] });
	const one = await values({ report: ["timing check: not run"], diagnostics: [{ severity: "warning", message: "timing check: not run (no clock in the netlist)" }] });
	const digest = buildDigest(root, hourAgo());
	assert.deepEqual(digest.not_run.map((x) => [x.where.split(" ")[1], x.count, x.items]), [
		[two.id, 2, ["timing check: not run", "pin check: not run"]],
		[one.id, 1, ["timing check: not run"]],
	]);
	assert.match(formatDigest(digest), /^NOT RUN: 3 items in 2 records$/m);
});

test("NOT RUN: the rows of a check that are not measured are named, and a corner that was not selected counts as not selected in each row", async (t) => {
	const root = designRoot(t, {
		schema: "simra.requirements/0",
		conditions: { tt: { inputs: { values: { gain_db: null } } }, ss: { inputs: { values: { gain_db: 59 } } } },
		experiments: { ac: { adapter: "fake", operation: "run", inputs: { mode: "values" } } },
		requirements: [{ id: "gain", experiment: "ac", measurement: "gain_db", op: ">=", limit: 58, conditions: ["tt", "ss"] }],
		gates: { corners: { required: ["tt", "ss"] } },
	});
	const { verdict } = await runCheck({ root, conditions: ["tt"] });
	assert.deepEqual(verdict.counts, { pass: 0, fail: 0, not_measured: 1, not_run: 3 });
	const digest = buildDigest(root, hourAgo());
	assert.deepEqual(digest.not_run.map((x) => [x.count, x.not_selected, x.not_measured]), [[3, 2, 1]]);
	const text = formatDigest(digest);
	assert.match(text, /^NOT RUN: 3 items in 1 record; NOT MEASURED: 1 row$/m);
	assert.match(text, new RegExp(`^  check ${verdict.id}: 3 not run \\(2 not selected\\), 1 not measured$`, "m"));
	assert.match(text, /^ {4}gain @ tt: not measured: experiment \S+ gave no value for gain_db$/m);
});

test("PASS RULE: a rule file that changes after the given time is named, also when its run ended before", async (t) => {
	const root = designRoot(t);
	writeFileSync(join(root, "rule.txt"), "gain_db >= 58\n");
	const run = await runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" }, passRule: { file: "rule.txt" } });
	await sleep(30);
	const since = new Date();
	assert.deepEqual(buildDigest(root, since).pass_rule.changed, []);
	await sleep(30);
	writeFileSync(join(root, "rule.txt"), "gain_db >= 50\n");
	assert.match(formatOutcome(root, run.experiment, run.result), /^PASS RULE CHANGED: file rule.txt changed after this run started/m);
	const digest = buildDigest(root, since);
	assert.deepEqual(digest.pass_rule.changed.map((r) => r.id), [run.id]);
	assert.equal(digest.counts.experiments, 0);
	assert.match(formatDigest(digest), new RegExp(`^PASS RULE: 1 changed, 0 failed\\n  CHANGED ${run.id} fake.run: file rule.txt changed after this run started`, "m"));
});

test("the digest gives the full name of who answered, names a class C decision that the owner answered, and refuses a time that is no date", (t) => {
	const root = designRoot(t);
	const b = recordDecision(root, { class: "B", statement: "Use a two-stage pipeline", alternative: "one stage", why: "setup fails", reverse: "remove the register", affects: ["file:rtl/mul.v"] });
	const c = recordDecision(root, { class: "C", statement: "Use the run tag try3", why: "try2 exists" });
	answerDecision(root, b.id, { answer: "confirmed", by: "Ada Owner" });
	answerDecision(root, c.id, { answer: "reversed", by: "Ada Owner" });
	const text = formatDigest(buildDigest(root, hourAgo()));
	assert.match(text, new RegExp(`^  B ${b.id.slice(-6)} confirmed by Ada Owner: Use a two-stage pipeline$`, "m"));
	assert.match(text, new RegExp(`^CLASS C: 1 logged, 1 answered by the owner\\n  C ${c.id.slice(-6)} reversed by Ada Owner \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d; marked 0 results: Use the run tag try3$`, "m"));
	assert.throws(() => parseSince("999999999999999d"), /since "999999999999999d": give an ISO date or time/);
	assert.throws(() => parseSince("2026-13-45"), /since "2026-13-45": give an ISO date or time/);
});
