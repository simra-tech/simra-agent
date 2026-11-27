// The pass rule of a run: recorded in experiment.json before the adapter starts, copied into result.json, and the
// three flags (another rule under the same key after a result, a rule file that changed after the run, a changed
// record). On the fake adapter.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type ExperimentRecord, formatOutcome, passRuleFlags, type ResultRecord, runExperiment, runJobs, sha256Text, waitExperiments } from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

function designRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "simra-rule-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	return root;
}
const run = (root: string, passRule?: { id?: string; text?: string; file?: string }) =>
	runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" }, purpose: "pass rule test", passRule });
const json = <T>(root: string, id: string, name: string) => JSON.parse(readFileSync(join(root, "simra/experiments", id, name), "utf8")) as T;

test("a text rule is in experiment.json before the adapter starts, and its hash is in result.json", async (t) => {
	const root = designRoot(t);
	const text = "setup slack >= 0 ns at the slow corner, with extracted wires";
	const started = await runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "slow", seconds: 2 }, passRule: { text }, detached: true });
	// The run has no result yet; the rule is already in the record.
	const before = json<ExperimentRecord>(root, started.id, "experiment.json");
	assert.equal(before.pass_rule?.sha256, sha256Text(text));
	assert.equal(before.pass_rule?.text, text);
	assert.equal(before.pass_rule?.key, null);
	const [outcome] = await waitExperiments(root, [started.id], { timeoutS: 30 });
	assert.equal(outcome.result?.pass_rule_sha256, sha256Text(text));
	assert.ok(Date.parse(before.pass_rule?.recorded_at ?? "") <= Date.parse(outcome.result?.started_at ?? ""));
	const summary = formatOutcome(root, outcome.experiment, outcome.result as ResultRecord);
	assert.match(summary, /^pass rule: "setup slack >= 0 ns at the slow corner, with extracted wires" sha256:[0-9a-f]{12}, recorded .* \(before the run\)$/m);
	assert.doesNotMatch(summary, /PASS RULE CHANGED/);
});

test("negative control: a run without a pass rule has no pass rule lines, and the same rule two times gives no flag", async (t) => {
	const root = designRoot(t);
	const plain = await run(root);
	assert.equal(plain.experiment.pass_rule, undefined);
	assert.equal(plain.result.pass_rule_sha256, undefined);
	assert.doesNotMatch(formatOutcome(root, plain.experiment, plain.result), /pass rule/i);
	writeFileSync(join(root, "pass.md"), "worst slack >= 0\n");
	await run(root, { file: "pass.md" });
	const second = await run(root, { file: "pass.md" });
	assert.deepEqual(second.experiment.pass_rule?.changed_after_results, []);
	assert.deepEqual(passRuleFlags(root, second.experiment, second.result), []);
});

test("a rule file that changes after a result is flagged: on the old run, and on the next run with the new rule", async (t) => {
	const root = designRoot(t);
	writeFileSync(join(root, "pass.md"), "worst slack >= 0\n");
	const first = await run(root, { file: "pass.md" });
	assert.equal(first.experiment.pass_rule?.key, "pass.md");
	assert.equal(first.experiment.pass_rule?.file, "pass.md");
	writeFileSync(join(root, "pass.md"), "worst slack >= -0.2\n");
	assert.match(formatOutcome(root, first.experiment, first.result), /^PASS RULE CHANGED: file pass\.md changed after this run started \(now sha256:[0-9a-f]{12}\)/m);
	const second = await run(root, { file: "pass.md" });
	assert.deepEqual(second.experiment.pass_rule?.changed_after_results.map((c) => c.experiment), [first.id]);
	assert.match(formatOutcome(root, second.experiment, second.result), new RegExp(`^PASS RULE CHANGED: experiment ${first.id} \\(ended .*\\) used sha256:[0-9a-f]{12} for the rule pass\\.md`, "m"));
});

test("a text rule with an id: another text under the same id after a result is flagged; another id is not", async (t) => {
	const root = designRoot(t);
	const first = await run(root, { id: "timing", text: "setup slack >= 0" });
	const other = await run(root, { id: "area", text: "area <= 1000 um2" });
	assert.deepEqual(other.experiment.pass_rule?.changed_after_results, []);
	const second = await run(root, { id: "timing", text: "setup slack >= -0.1" });
	assert.deepEqual(second.experiment.pass_rule?.changed_after_results.map((c) => c.experiment), [first.id]);
});

test("a record that is changed after the run is flagged", async (t) => {
	const root = designRoot(t);
	const done = await run(root, { text: "gain >= 40 dB" });
	const path = join(root, "simra/experiments", done.id, "experiment.json");
	const edited = JSON.parse(readFileSync(path, "utf8")) as ExperimentRecord;
	(edited.pass_rule as { text: string }).text = "gain >= 30 dB";
	assert.match(passRuleFlags(root, edited, done.result).join("\n"), /rule text in experiment\.json does not have the recorded sha256/);
	(edited.pass_rule as { sha256: string }).sha256 = sha256Text("gain >= 30 dB");
	assert.match(passRuleFlags(root, edited, done.result).join("\n"), /the run started with sha256:[0-9a-f]{12} \(result\.json\)/);
});

test("a rule that cannot be recorded stops the run before an experiment directory exists", async (t) => {
	const root = designRoot(t);
	await assert.rejects(run(root, { file: "none.md" }), /pass_rule: the file none\.md is not there/);
	await assert.rejects(run(root, {}), /give the rule as text or as file/);
	await assert.rejects(run(root, { text: "a", file: "b" }), /one of the two/);
	await assert.rejects(run(root, { file: "../outside.md" }), /not in the design root/);
	assert.equal(spawnSync("ls", [join(root, "simra")]).status !== 0, true, "no experiment directory was made");
});

test("simra run and simra jobs take pass_rule from the spec", async (t) => {
	const root = designRoot(t);
	writeFileSync(join(root, "pass.md"), "x >= 1 V\n");
	writeFileSync(join(root, "run.json"), JSON.stringify({ adapter: "fake", operation: "run", inputs: { mode: "ok" }, pass_rule: { file: "pass.md" } }));
	const out = spawnSync(process.execPath, [cli, "--root", root, "run", join(root, "run.json")], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /^pass rule: file pass\.md sha256:[0-9a-f]{12}/m);
	const jobs = await runJobs({ root, jobs: [{ adapter: "fake", operation: "run", inputs: { mode: "ok" }, pass_rule: { id: "x", text: "x >= 1 V" } }] });
	assert.equal(json<ExperimentRecord>(root, jobs.jobs[0].id as string, "experiment.json").pass_rule?.key, "x");
});

test("a rule file that cannot be read stops the run; one that cannot be read after the run is flagged", async (t) => {
	const root = designRoot(t);
	writeFileSync(join(root, "rule.md"), "gain >= 40 dB\n");
	chmodSync(join(root, "rule.md"), 0o000);
	t.after(() => {
		try {
			chmodSync(join(root, "rule.md"), 0o644);
		} catch {}
	});
	await assert.rejects(run(root, { file: "rule.md" }), /pass_rule: the file rule\.md cannot be read/);
	chmodSync(join(root, "rule.md"), 0o644);
	const done = await run(root, { file: "rule.md" });
	assert.match(done.experiment.pass_rule?.sha256 ?? "", /^[0-9a-f]{64}$/);
	assert.deepEqual(passRuleFlags(root, done.experiment, done.result), []);
	chmodSync(join(root, "rule.md"), 0o000);
	assert.match(passRuleFlags(root, done.experiment, done.result).join("\n"), /PASS RULE CHANGED: file rule\.md cannot be read now/);
});

test("a pass rule that is removed from experiment.json after the run is flagged, also in the summary", async (t) => {
	const root = designRoot(t);
	const done = await run(root, { text: "gain >= 40 dB" });
	const edited = JSON.parse(JSON.stringify(done.experiment)) as ExperimentRecord;
	delete edited.pass_rule;
	const flags = passRuleFlags(root, edited, done.result).join("\n");
	assert.match(flags, /PASS RULE CHANGED: experiment\.json has no pass rule; the run started with sha256:[0-9a-f]{12} \(result\.json\)/);
	assert.match(formatOutcome(root, edited, done.result), /PASS RULE CHANGED: experiment\.json has no pass rule/);
	// Negative control: a run that never had a pass rule has no flag.
	const plain = await run(root);
	assert.deepEqual(passRuleFlags(root, plain.experiment, plain.result), []);
});

test("a rule file: the record keeps the wording, so a later change of the file does not lose it", async (t) => {
	const root = designRoot(t);
	writeFileSync(join(root, "rule.md"), "gain >= 40 dB\n");
	const done = await run(root, { file: "rule.md" });
	writeFileSync(join(root, "rule.md"), "gain >= 30 dB\n");
	assert.equal(json<ExperimentRecord>(root, done.id, "experiment.json").pass_rule?.content, "gain >= 40 dB\n");
});

test("a rule file that is not UTF-8 gives no flag when it did not change", async (t) => {
	const root = designRoot(t);
	// "T <= 85°C" in Latin-1: the byte 0xB0 is not valid UTF-8.
	writeFileSync(join(root, "rule.txt"), Buffer.from([0x54, 0x20, 0x3c, 0x3d, 0x20, 0x38, 0x35, 0xb0, 0x43, 0x0a]));
	const done = await run(root, { file: "rule.txt" });
	assert.deepEqual(passRuleFlags(root, done.experiment, done.result), []);
	assert.equal(done.experiment.pass_rule?.content, undefined, "a text that does not give the bytes back is not stored");
	assert.equal(done.experiment.pass_rule?.bytes, 10);
});
