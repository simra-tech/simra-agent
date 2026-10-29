import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatVerdict, listExperiments, loadExperiment, runCheck, type VerdictRow } from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;

function designRoot(t: { after: (fn: () => void) => void }, requirements: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "simra-check-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	writeFileSync(join(root, "requirements.json"), JSON.stringify(requirements));
	return root;
}

// Two conditions. The fake adapter reports inputs.values; each condition replaces them.
const amplifier = {
	schema: "simra.requirements/0",
	conditions: {
		tt: { inputs: { values: { gain_db: 62, ugf_hz: 1.2e7 } } },
		ss: { inputs: { values: { gain_db: 55, ugf_hz: 8e6 } } },
	},
	experiments: {
		ac: { adapter: "fake", operation: "run", inputs: { mode: "values", units: { gain_db: "dB", ugf_hz: "Hz" }, tag: "ac_{condition}" } },
	},
	requirements: [
		{ id: "gain", experiment: "ac", measurement: "gain_db", unit: "dB", op: ">=", limit: 58, conditions: ["tt", "ss"] },
		{ id: "ugf", experiment: "ac", measurement: "ugf_hz", unit: "Hz", op: ">=", limit: { tt: 1e7, ss: 7e6 }, conditions: ["tt", "ss"] },
	],
};

const row = (rows: VerdictRow[], requirement: string, condition: string) =>
	rows.find((r) => r.requirement === requirement && r.condition === condition) as VerdictRow;

test("a check compares every row with its limit and names the experiment", async (t) => {
	const root = designRoot(t, amplifier);
	const { id, verdict } = await runCheck({ root });

	assert.equal(verdict.schema, "simra.verdict/0");
	assert.equal(verdict.status, "fail");
	assert.deepEqual(verdict.counts, { pass: 3, fail: 1, not_measured: 0, not_run: 0 });
	// Two requirements read the same experiment: one run per condition, not per row.
	assert.equal(verdict.experiments.length, 2);
	assert.equal(listExperiments(root).length, 2);

	const gainSs = row(verdict.rows, "gain", "ss");
	assert.equal(gainSs.status, "fail");
	assert.equal(gainSs.value, 55);
	assert.equal(gainSs.margin, -3);
	assert.ok(Math.abs((gainSs.margin_rel as number) + 3 / 58) < 1e-12);
	assert.equal(row(verdict.rows, "ugf", "ss").limit, 7e6, "per-condition limit");
	assert.equal(row(verdict.rows, "ugf", "ss").status, "pass");

	// The verdict row points to the experiment that gave the value, and that experiment ran at that condition.
	const source = loadExperiment(root, gainSs.experiment as string);
	assert.equal(source.experiment.inputs.tag, "ac_ss", "{condition} is substituted");
	assert.deepEqual(source.experiment.inputs.values, { gain_db: 55, ugf_hz: 8e6 });
	assert.match(source.experiment.purpose ?? "", new RegExp(`check ${id}: ac at ss`));

	const saved = JSON.parse(readFileSync(join(root, "simra", "checks", id, "verdict.json"), "utf8"));
	assert.deepEqual(saved, verdict);
	assert.equal(saved.requirements_file.path, "requirements.json");

	const text = formatVerdict(root, verdict);
	assert.match(text, /^check \S+: FAIL \(3 pass, 1 fail, 0 not measured, 0 not run; 2 experiments\)/);
	assert.match(text.split("\n")[2], /^ {2}FAIL {9}gain @ ss: 55 dB, limit >= 58 margin -5\.2% \[\S+\]$/, "failures come first");
});

test("missing values and failed experiments are reported, never passed", async (t) => {
	const root = designRoot(t, {
		...amplifier,
		conditions: {
			tt: { inputs: { values: { gain_db: 62, ugf_hz: null } } },
			ss: { inputs: { mode: "failed" } },
		},
	});
	const { verdict } = await runCheck({ root });
	assert.equal(verdict.status, "incomplete");
	assert.deepEqual(verdict.counts, { pass: 1, fail: 0, not_measured: 1, not_run: 2 });
	assert.match(row(verdict.rows, "ugf", "tt").reason ?? "", /gave no value for ugf_hz/);
	assert.match(row(verdict.rows, "gain", "ss").reason ?? "", /ended with status failed/);
	assert.match(formatVerdict(root, verdict), /does not show that the design meets its requirements/);
});

test("a measurement in another unit is not compared", async (t) => {
	const root = designRoot(t, {
		...amplifier,
		experiments: { ac: { ...amplifier.experiments.ac, inputs: { mode: "values", units: { gain_db: "V/V", ugf_hz: "Hz" } } } },
	});
	const { verdict } = await runCheck({ root, requirements: ["gain"], conditions: ["tt"] });
	const gain = row(verdict.rows, "gain", "tt");
	assert.equal(gain.status, "not_measured");
	assert.match(gain.reason ?? "", /unit is V\/V, the requirement expects dB/);
});

test("a partial check runs only the selection and is never a pass", async (t) => {
	const root = designRoot(t, amplifier);
	const { verdict } = await runCheck({ root, conditions: ["tt"] });
	assert.equal(verdict.experiments.length, 1);
	assert.deepEqual(verdict.counts, { pass: 2, fail: 0, not_measured: 0, not_run: 2 });
	assert.equal(verdict.status, "incomplete");
	assert.deepEqual(verdict.selection, { requirements: null, conditions: ["tt"] });
	assert.equal(row(verdict.rows, "gain", "ss").reason, "not selected in this check");
	assert.match(formatVerdict(root, verdict), /NOT_RUN {6}2 more rows: not selected in this check/);

	// "ugf" reads the same experiment as "gain", but it is not selected: its rows are not evaluated.
	const { verdict: one } = await runCheck({ root, requirements: ["gain"] });
	assert.deepEqual(one.counts, { pass: 1, fail: 1, not_measured: 0, not_run: 2 });
	assert.equal(row(one.rows, "ugf", "tt").reason, "not selected in this check");
	assert.equal(row(one.rows, "ugf", "tt").experiment, null);
});

test("an invalid requirements file names every problem and runs nothing", async (t) => {
	const root = designRoot(t, {
		schema: "simra.requirements/0",
		conditions: { tt: {} },
		experiments: { ac: { adapter: "fake", operation: "run", inputs: {} } },
		requirements: [
			{ id: "a", experiment: "dc", measurement: "x", op: ">=", limit: 1, conditions: ["tt"] },
			{ id: "b", experiment: "ac", measurement: "x", op: "between", limit: [2, 1], conditions: ["ff"] },
			{ id: "c", experiment: "ac", measurement: "x", op: "<=", limit: { ss: 1 }, conditions: ["tt"] },
		],
	});
	await assert.rejects(runCheck({ root }), (e: Error) => {
		assert.match(e.message, /experiment "dc" is not defined/);
		assert.match(e.message, /condition "ff" is not defined/);
		assert.match(e.message, /no valid limit for op between/);
		assert.match(e.message, /requirement "c": no valid limit for op <= at condition "tt"/);
		return true;
	});
	await assert.rejects(runCheck({ root: designRoot(t, amplifier), requirements: ["nope"] }), /requirement "nope" is not defined/);
	assert.equal(existsSync(join(root, "simra")), false);
});
