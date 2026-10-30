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

// A sweep experiment: the fake adapter reports <name>.min and <name>.max with the sweep point in "at".
const sweep = {
	schema: "simra.requirements/0",
	conditions: {
		tt: {
			inputs: {
				values: { "gain_db.min": 52, "gain_db.max": 61, "idd_a.min": 1e-4, "idd_a.max": 1.4e-4, "pm_deg.min": 58, "pm_deg.max": 70 },
				at: {
					"gain_db.min": { vcm: 0.4 },
					"gain_db.max": { vcm: 0.55 },
					"idd_a.max": { vcm: 0.7 },
					"pm_deg.min": { vcm: 0.7 },
					"pm_deg.max": { vcm: 0.4 },
				},
			},
		},
		ss: { inputs: { values: { "gain_db.min": null, "gain_db.max": 60, "idd_a.min": 1e-4, "idd_a.max": 1.2e-4, "pm_deg.min": 62, "pm_deg.max": 89 } } },
	},
	experiments: {
		dc_sweep: { adapter: "fake", operation: "run", inputs: { mode: "values", units: { "gain_db.min": "dB", "gain_db.max": "dB", "pm_deg.min": "deg", "pm_deg.max": "deg" } } },
	},
	requirements: [
		{ id: "gain", experiment: "dc_sweep", measurement: "gain_db", unit: "dB", op: ">=", limit: 50, conditions: ["tt", "ss"] },
		{ id: "idd", experiment: "dc_sweep", measurement: "idd_a", op: "<=", limit: 1.3e-4, conditions: ["tt", "ss"] },
		{ id: "pm", experiment: "dc_sweep", measurement: "pm_deg", unit: "deg", op: "between", limit: [60, 90], conditions: ["tt", "ss"] },
	],
};

test("a sweep row uses the worst point for its op and names the point", async (t) => {
	const root = designRoot(t, sweep);
	const { verdict } = await runCheck({ root });

	// >= uses .min.
	const gain = row(verdict.rows, "gain", "tt");
	assert.deepEqual([gain.status, gain.value, gain.margin, gain.at], ["pass", 52, 2, { vcm: 0.4 }]);
	// <= uses .max.
	const idd = row(verdict.rows, "idd", "tt");
	assert.deepEqual([idd.status, idd.value, idd.at], ["fail", 1.4e-4, { vcm: 0.7 }]);
	assert.equal(row(verdict.rows, "idd", "ss").status, "pass");
	// between uses both sides; the side with the smaller margin gives the value and the point.
	const pm = row(verdict.rows, "pm", "tt");
	assert.deepEqual([pm.status, pm.value, pm.margin, pm.at], ["fail", 58, -2, { vcm: 0.7 }]);
	const pmSs = row(verdict.rows, "pm", "ss");
	assert.deepEqual([pmSs.status, pmSs.value, pmSs.margin], ["pass", 89, 1]);
	assert.equal(pmSs.at, null, "the fake adapter gives no point here");
	// A sweep entry without a value is not measured, never a pass.
	const gainSs = row(verdict.rows, "gain", "ss");
	assert.equal(gainSs.status, "not_measured");
	assert.match(gainSs.reason ?? "", /gave no value for gain_db\.min/);

	assert.match(formatVerdict(root, verdict), /FAIL {9}pm @ tt: 58 deg @ vcm=0\.7, limit 60\.\.90/);
	assert.match(formatVerdict(root, verdict), /PASS {9}gain @ tt: 52 dB @ vcm=0\.4, limit >= 50/);
});

test("a sweep comes before a scalar of the same name", async (t) => {
	const root = designRoot(t, {
		...sweep,
		conditions: { tt: { inputs: { values: { gain_db: 60, "gain_db.min": 45, "gain_db.max": 61 }, at: { "gain_db.min": { vcm: 0.4 } } } } },
		requirements: [sweep.requirements[0]].map((r) => ({ ...r, conditions: ["tt"] })),
	});
	const { verdict } = await runCheck({ root });
	assert.deepEqual([verdict.rows[0].status, verdict.rows[0].value, verdict.rows[0].at], ["fail", 45, { vcm: 0.4 }]);
});

test("parallel runs give the same verdict and keep the experiment order", async (t) => {
	const conditions = Object.fromEntries(
		["c1", "c2", "c3", "c4", "c5", "c6"].map((c, i) => [c, { inputs: { values: { gain_db: 55 + i, ugf_hz: 1e7 } } }]),
	);
	const file = {
		...amplifier,
		conditions,
		experiments: { ...amplifier.experiments, dc: { ...amplifier.experiments.ac, inputs: { ...amplifier.experiments.ac.inputs, tag: "dc_{condition}" } } },
		requirements: [
			{ ...amplifier.requirements[0], conditions: Object.keys(conditions) },
			{ ...amplifier.requirements[1], experiment: "dc", limit: 1e7, conditions: Object.keys(conditions) },
		],
	};
	const strip = (v: Awaited<ReturnType<typeof runCheck>>["verdict"]) => ({
		status: v.status,
		counts: v.counts,
		experiments: v.experiments.map((e) => [e.experiment, e.condition, e.status]),
		rows: v.rows.map(({ experiment: _, ...rest }) => rest),
	});
	const one = await runCheck({ root: designRoot(t, file), parallel: 1 });
	const four = await runCheck({ root: designRoot(t, file), parallel: 4 });
	assert.deepEqual(strip(four.verdict), strip(one.verdict));
	assert.deepEqual(
		four.verdict.experiments.map((e) => `${e.experiment}@${e.condition}`),
		[...Object.keys(conditions).map((c) => `ac@${c}`), ...Object.keys(conditions).map((c) => `dc@${c}`)],
	);
	// Each row names the experiment that ran at its condition.
	for (const r of four.verdict.rows) {
		const e = four.verdict.experiments.find((x) => x.id === r.experiment);
		assert.equal(e?.condition, r.condition);
	}
	assert.equal(four.verdict.counts.fail, 3);
});

test("an aborted check starts no new experiment", async (t) => {
	const root = designRoot(t, amplifier);
	const controller = new AbortController();
	controller.abort();
	const { verdict } = await runCheck({ root, signal: controller.signal });
	assert.equal(verdict.experiments.length, 0);
	assert.equal(verdict.counts.not_run, 4);
});
