import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assumptionUses, formatAssumptionUses, formatVerdict, listExperiments, loadExperiment, runCheck, validateRequirements, type RequirementsFile, type VerdictRow } from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

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

const row = (rows: VerdictRow[], requirement: string, condition: string | null) =>
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

test("a file with a top-level design section is rejected, so its design check is not lost", async (t) => {
	// The SKY130 file of ota-synthesis before the design check became an experiment.
	const old = JSON.parse(readFileSync(join(fixtures, "design-section-requirements.json"), "utf8"));
	const errors = validateRequirements(old);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /^design: this field is not supported\. Put the design check in experiments \(adapter ngspice, operation check_design/);
	assert.match(errors[0], /requirements without conditions on its measurements design_errors \(<= 0\) and area_um2$/);
	const root = designRoot(t, old);
	await assert.rejects(runCheck({ root }), /invalid requirements file requirements\.json:\n- design: this field is not supported/);
	assert.equal(existsSync(join(root, "simra")), false);
	assert.deepEqual(validateRequirements({ ...amplifier, limits: {} } as RequirementsFile), [
		"limits: unknown field; the fields are schema, conditions, experiments, requirements, assumptions, gates",
	]);
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

// The amplifier with every row inside its limit, and a design check: requirements without conditions read it once.
const design = { adapter: "fake", operation: "run", inputs: { mode: "values", values: { design_errors: 0, area_um2: 17.5 }, units: { area_um2: "um2" } } };
const designRows = [
	{ id: "design_errors", experiment: "design", measurement: "design_errors", op: "<=", limit: 0 },
	{ id: "area", experiment: "design", measurement: "area_um2", unit: "um2", op: "<=", limit: 40 },
];
const checked = (inputs: Record<string, unknown> = {}) => ({
	...amplifier,
	conditions: { ...amplifier.conditions, ss: { inputs: { values: { gain_db: 60, ugf_hz: 8e6 } } } },
	experiments: { ...amplifier.experiments, design: { ...design, inputs: { ...design.inputs, ...inputs } } },
	requirements: [...designRows, ...amplifier.requirements],
});

test("a requirement without conditions has one limit and an experiment without {condition}", () => {
	assert.deepEqual(validateRequirements(checked() as RequirementsFile), []);
	const file = checked();
	file.requirements = [
		{ ...designRows[0], limit: { tt: 0 } },
		{ ...designRows[1], experiment: "ac" },
		{ ...amplifier.requirements[0], conditions: [] },
	] as typeof file.requirements;
	assert.deepEqual(validateRequirements(file as RequirementsFile), [
		'requirement "design_errors": no valid limit for op <=',
		'requirement "area": experiment "ac" uses {condition}, so the requirement needs conditions',
		'requirement "gain": give at least one condition, or no conditions field',
	]);
});

test("a requirement without conditions runs its experiment once, with the template inputs", async (t) => {
	const root = designRoot(t, checked());
	const { id, verdict } = await runCheck({ root });
	assert.equal(verdict.status, "pass");
	assert.deepEqual(verdict.counts, { pass: 6, fail: 0, not_measured: 0, not_run: 0 });
	assert.deepEqual(
		verdict.experiments.map((e) => [e.experiment, e.condition]),
		[["design", null], ["ac", "tt"], ["ac", "ss"]],
	);
	const errors = row(verdict.rows, "design_errors", null);
	assert.equal(errors.value, 0);
	const source = loadExperiment(root, errors.experiment as string);
	assert.deepEqual(source.experiment.inputs, design.inputs);
	assert.equal(source.experiment.purpose, `check ${id}: design`);
	assert.match(formatVerdict(root, verdict), /\n {2}PASS {9}area: 17\.5 um2, limit <= 40 margin 56\.3% \[\S+\]\n/);
});

test("design errors fail the check, with their file and line", async (t) => {
	const diagnostics = [
		{ severity: "error", message: "V1: a voltage source is not allowed", source: "amp.spice:2" },
		{ severity: "info", message: "not kept", source: "adapter" },
	];
	const root = designRoot(t, checked({ values: { design_errors: 1, area_um2: 17.5 }, diagnostics }));
	const { verdict } = await runCheck({ root });
	assert.equal(verdict.status, "fail");
	assert.equal(verdict.counts.pass, 5);
	assert.deepEqual(verdict.experiments[0].diagnostics, [diagnostics[0]]);
	assert.deepEqual(verdict.experiments[1].diagnostics, []);
	const text = formatVerdict(root, verdict);
	assert.match(text, /^check \S+: FAIL \(5 pass, 1 fail/);
	assert.match(text, /\n {2}design \[\S+\]:\n {4}error \(amp\.spice:2\): V1: a voltage source is not allowed\n {2}FAIL {9}design_errors: 1, limit <= 0 /);
	assert.doesNotMatch(text, /not kept|ac @ tt \[/);
});

test("a design check that does not complete or is not selected is not run, never a pass", async (t) => {
	const diagnostics = [{ severity: "error", message: "fake design failure", source: "adapter" }];
	const failed = await runCheck({ root: designRoot(t, checked({ mode: "failed", diagnostics })) });
	assert.equal(failed.verdict.status, "incomplete");
	assert.equal(row(failed.verdict.rows, "design_errors", null).status, "not_run");
	assert.match(formatVerdict("/", failed.verdict), /\n {2}design \[\S+\]:\n {4}error: fake design failure\n/);

	const root = designRoot(t, checked());
	// A selection of requirements leaves the design rows out.
	const { verdict: some } = await runCheck({ root, requirements: ["gain", "ugf"] });
	assert.deepEqual([some.status, some.counts.pass, some.counts.not_run], ["incomplete", 4, 2]);
	assert.equal(row(some.rows, "area", null).reason, "not selected in this check");
	// A selection of conditions keeps the rows without a condition. A selection is never a pass, also when it has every row.
	for (const selection of [{ conditions: ["tt", "ss"] }, { requirements: ["design_errors", "area", "gain", "ugf"] }]) {
		const { verdict } = await runCheck({ root, ...selection });
		assert.deepEqual([verdict.status, verdict.counts.pass], ["incomplete", 6]);
	}
});

// Touchstone kinds: an amplifier 2-port, unconditionally stable at tt (S12 = 0.01) and not at ss (S12 = 0.5).
const amp = (s12: number) =>
	["# GHZ S RI R 50", ...[10, 20, 30, 40].map((f) => `${f} 0.5 0 ${(4 - f / 20).toFixed(2)} 0 ${s12} 0 0.4 0`)].join("\n") + "\n";

const sparams = {
	schema: "simra.requirements/0",
	conditions: {
		tt: { inputs: { files: { "amp.s2p": amp(0.01) } } },
		ss: { inputs: { files: { "amp.s2p": amp(0.5) } } },
	},
	experiments: {
		sp: { adapter: "fake", operation: "run", inputs: { mode: "touchstone", tag: "sp_{condition}" } },
		two: { adapter: "fake", operation: "run", inputs: { mode: "touchstone", files: { "a.s2p": amp(0.01), "b.s2p": amp(0.01) } } },
	},
	requirements: [
		{ id: "gain", experiment: "sp", kind: "s_db", entry: [2, 1], band_hz: [10e9, 30e9], op: ">=", limit: 7, unit: "dB", conditions: ["tt", "ss"] },
		{ id: "gain_at_f0", experiment: "sp", kind: "s_db", entry: [2, 1], band_hz: [20e9, 20e9], op: "between", limit: [9, 10], conditions: ["tt"] },
		{ id: "stable", experiment: "sp", kind: "mu", band_hz: [10e9, 40e9], op: ">=", limit: 1, conditions: ["tt", "ss"] },
		{ id: "outside", experiment: "sp", kind: "mu", band_hz: [1e9, 40e9], op: ">=", limit: 1, conditions: ["tt"] },
		{ id: "which", experiment: "two", kind: "s_db", entry: [1, 1], band_hz: [10e9, 40e9], op: "<=", limit: -3 },
		{ id: "named", experiment: "two", kind: "s_db", entry: [1, 1], band_hz: [10e9, 40e9], op: "<=", limit: -3, touchstone: "b.s2p" },
	],
};

test("Touchstone kinds: |S21| in dB and mu over a band, from the Touchstone output of the experiment", async (t) => {
	const root = designRoot(t, sparams);
	const { verdict } = await runCheck({ root });
	const gainTt = row(verdict.rows, "gain", "tt");
	// The worst point in 10 to 30 GHz is 30 GHz: |S21| = 4 - 1.5 = 2.5.
	assert.equal(gainTt.status, "pass");
	assert.ok(Math.abs((gainTt.value as number) - 20 * Math.log10(2.5)) < 1e-12);
	assert.deepEqual(gainTt.at, { f_hz: 30e9 });
	assert.equal(gainTt.measurement, "S21 dB");
	assert.equal(gainTt.unit, "dB");
	const f0 = row(verdict.rows, "gain_at_f0", "tt");
	assert.ok(Math.abs((f0.value as number) - 20 * Math.log10(3)) < 1e-12);
	assert.equal(f0.status, "pass");
	// mu = (1 - |S11|^2) / (|S22 - conj(S11) Delta| + |S12 S21|), with S11 = 0.5 and S22 = 0.4 (real).
	const stableTt = row(verdict.rows, "stable", "tt");
	assert.equal(stableTt.status, "pass");
	const stableSs = row(verdict.rows, "stable", "ss");
	assert.equal(stableSs.status, "fail");
	assert.deepEqual(stableSs.at, { f_hz: 10e9 }, "the largest S21 gives the smallest mu");
	const s21 = 3.5;
	const expected = 0.75 / (Math.abs(0.4 - 0.5 * (0.2 - 0.5 * s21)) + 0.5 * s21);
	assert.ok(Math.abs((stableSs.value as number) - expected) < 1e-12, `${stableSs.value} != ${expected}`);
	// A band outside the data, two files without a name, and a named file.
	assert.equal(row(verdict.rows, "outside", "tt").status, "not_measured");
	assert.match(row(verdict.rows, "outside", "tt").reason ?? "", /covers 10000000000 to 40000000000 Hz/);
	assert.match(row(verdict.rows, "which", null).reason ?? "", /2 Touchstone files; name one/);
	assert.equal(row(verdict.rows, "named", null).status, "pass");
	assert.match(formatVerdict(root, verdict), /FAIL\s+stable @ ss: 0\.2564 @ f_hz=10000000000, limit >= 1/);
});

test("Touchstone kinds: a file that changed after the run is not measured, and the fields are checked", async (t) => {
	const root = designRoot(t, { ...sparams, requirements: [sparams.requirements[0]] });
	const first = await runCheck({ root, conditions: ["tt"] });
	const id = row(first.verdict.rows, "gain", "tt").experiment as string;
	const out = loadExperiment(root, id).result?.outputs[0].path as string;
	writeFileSync(out, amp(0.02));
	const { evaluateRow } = await import("../src/index.ts");
	const again = evaluateRow(sparams.requirements[0] as never, "tt", { id, result: loadExperiment(root, id).result as never }, "", root);
	assert.equal(again.status, "not_measured");
	assert.match(again.reason ?? "", /changed after experiment/);

	const bad = validateRequirements({
		...sparams,
		requirements: [
			{ id: "a", experiment: "sp", kind: "s_db", band_hz: [2, 1], op: ">=", limit: 1, unit: "V", measurement: "x" },
			{ id: "b", experiment: "sp", kind: "mu", entry: [1, 1], op: ">=", limit: 1 },
			{ id: "c", experiment: "sp", kind: "nf" as never, op: ">=", limit: 1 },
			{ id: "d", experiment: "sp", measurement: "x", band_hz: [1, 2], op: ">=", limit: 1 },
		],
	} as unknown as RequirementsFile);
	for (const text of ["remove measurement", "needs band_hz", "needs entry", "unit of kind s_db is dB", "entry is only for kind s_db", "kind is nf", "band_hz and touchstone are for the kinds"]) {
		assert.ok(bad.some((e) => e.includes(text)), `${text}: ${bad.join("; ")}`);
	}
});

// Kind sweep: a reducer over a column of the sweep table (role "sweep") of the experiment, with the bracket rule.
const table = (gain: (number | null)[]) => ({ sweep: "pin_dbm", columns: ["gain_db"], rows: gain.map((g, k) => ({ pin_dbm: -10 + 5 * k, gain_db: g })) });
const swept = {
	schema: "simra.requirements/0",
	conditions: { tt: { inputs: { table: table([10, 9.8, 9.4, 8.6, 7.0]) } }, ss: { inputs: { table: table([10, 9.8, null, 8.6, 7.0]) } } },
	experiments: { hb: { adapter: "fake", operation: "run", inputs: { mode: "sweep" } } },
	requirements: [
		{ id: "ip1db", experiment: "hb", kind: "sweep", column: "gain_db", reduce: { kind: "compression", db: 1 }, op: ">=", limit: 0, unit: "dBm", conditions: ["tt", "ss"] },
		{ id: "gmin", experiment: "hb", kind: "sweep", column: "gain_db", reduce: { kind: "min" }, op: ">=", limit: 6, unit: "dB", conditions: ["tt"] },
	],
};

test("kind sweep: the reduced value of a sweep table; a failed point inside the bracket is not measured, never a value", async (t) => {
	const root = designRoot(t, swept);
	const { verdict } = await runCheck({ root });
	const tt = row(verdict.rows, "ip1db", "tt");
	assert.equal(tt.status, "pass");
	assert.ok(Math.abs((tt.value as number) - 2.5) < 1e-12);
	assert.deepEqual(tt.at, { pin_dbm: 2.5 });
	assert.equal(tt.measurement, "gain_db compression");
	const ss = row(verdict.rows, "ip1db", "ss");
	assert.equal(ss.status, "not_measured");
	assert.equal(ss.value, null);
	assert.match(ss.reason as string, /^gain_db compression: failed \(the point 0 has no value and is inside the bracket of the 1 dB compression\)$/);
	assert.deepEqual([row(verdict.rows, "gmin", "tt").value, row(verdict.rows, "gmin", "tt").at], [7, { pin_dbm: 10 }]);
	assert.equal(verdict.status, "incomplete");
	assert.match(formatVerdict(root, verdict), /NOT_MEASURED {1}ip1db @ ss: -, limit >= 0 \[\S+\] \(gain_db compression: failed \(the point 0 has no value/);
	const bad = { ...swept, requirements: [{ id: "x", experiment: "hb", kind: "sweep", column: "g", reduce: { kind: "mean" }, measurement: "m", op: ">=", limit: 0 }] };
	await assert.rejects(runCheck({ root: designRoot(t, bad) }), /remove measurement[\s\S]*reduce\.kind must be one of/);
});

// The stability gate: each listed stage needs a mu requirement over the gate band at each listed condition.
const gated = (requirements: unknown[], band_hz?: [number, number]) => ({
	...sparams,
	gates: { stability: { stages: ["lna", "buf"], conditions: ["tt", "ss"], ...(band_hz ? { band_hz } : {}) } },
	requirements,
});
const muReq = (id: string, stage: string, band: [number, number], conditions = ["tt", "ss"]) => ({ id, experiment: "sp", kind: "mu", stage, band_hz: band, op: ">=", limit: 1, conditions });

test("stability gate: a stage without a mu record at a corner is not run, so the block cannot pass", async (t) => {
	// The data covers 10 to 40 GHz; the gate band here is 10 to 40 GHz (the default is 1 to 300 GHz).
	const root = designRoot(t, gated([muReq("mu_lna", "lna", [10e9, 40e9])], [10e9, 40e9]));
	const { verdict } = await runCheck({ root });
	const gate = verdict.rows.filter((r) => r.gate);
	assert.equal(gate.length, 4);
	assert.equal(row(gate, "gate stability lna", "tt").status, "pass");
	assert.equal(row(gate, "gate stability lna", "tt").reason, "from requirement mu_lna");
	assert.equal(row(gate, "gate stability lna", "ss").status, "fail", "mu < 1 at ss");
	const buf = row(gate, "gate stability buf", "tt");
	assert.equal(buf.status, "not_run");
	assert.match(buf.reason as string, /^no mu requirement of stage buf with op >= and a limit of at least 1 covers 10000000000 to 40000000000 Hz at condition tt$/);
	assert.equal(verdict.status, "fail");

	// Only tt passes everywhere: with both stages at tt only, the gate at ss is still not run.
	const ttOnly = designRoot(t, gated([muReq("mu_lna", "lna", [10e9, 40e9], ["tt"]), muReq("mu_buf", "buf", [10e9, 40e9], ["tt"])], [10e9, 40e9]));
	const v2 = (await runCheck({ root: ttOnly })).verdict;
	assert.deepEqual(v2.rows.filter((r) => r.gate).map((r) => [r.requirement, r.condition, r.status]), [
		["gate stability lna", "tt", "pass"], ["gate stability lna", "ss", "not_run"], ["gate stability buf", "tt", "pass"], ["gate stability buf", "ss", "not_run"],
	]);
	assert.equal(v2.status, "incomplete");
});

test("stability gate: a narrower band than the gate (default 1 to 300 GHz) does not cover it; the file is checked", async (t) => {
	const { verdict } = await runCheck({ root: designRoot(t, gated([muReq("mu_lna", "lna", [10e9, 40e9]), muReq("mu_buf", "buf", [10e9, 40e9])])) });
	for (const r of verdict.rows.filter((r) => r.gate)) {
		assert.equal(r.status, "not_run");
		assert.match(r.reason as string, /covers 1000000000 to 300000000000 Hz/);
	}
	const bad = { ...gated([{ ...muReq("m", "lna", [1e9, 3e11]), kind: "s_db", entry: [2, 1] }]), gates: { stability: { stages: [], conditions: ["hot"], band_hz: [5, 1] }, other: {} } };
	await assert.rejects(runCheck({ root: designRoot(t, bad) }), (e: Error) =>
		["stage is for kind mu", "stages must list", 'condition "hot" is not defined', "band_hz must be", "gates.other: unknown gate"].every((m) => e.message.includes(m)));
});

// Assumption ids: rows cite them through the requirement, its experiment or its condition; a query lists the rows.
const assumed = {
	...amplifier,
	assumptions: { tx_leak: { description: "TX leakage at the LNA input", value: -34, unit: "dBm", source: "system level plan" }, vdd: { description: "supply" } },
	conditions: { ...amplifier.conditions, ss: { ...amplifier.conditions.ss, assumptions: ["vdd"] } },
	experiments: { ac: { ...amplifier.experiments.ac, assumptions: ["tx_leak"] } },
};

test("assumptions: each row lists the assumptions it depends on, and a query lists the rows of an assumption", async (t) => {
	const root = designRoot(t, assumed);
	const { verdict } = await runCheck({ root });
	assert.deepEqual(row(verdict.rows, "gain", "tt").assumptions, ["tx_leak"]);
	assert.deepEqual(row(verdict.rows, "gain", "ss").assumptions, ["tx_leak", "vdd"]);
	assert.match(formatVerdict(root, verdict), / \{assumes tx_leak, vdd\}\n/);
	const uses = assumptionUses(assumed as never);
	assert.deepEqual(uses.map((u) => [u.assumption, u.requirements.map((r) => [r.id, r.via.join("+"), r.conditions.join("+")])]), [
		["tx_leak", [["gain", "experiment ac", "tt+ss"], ["ugf", "experiment ac", "tt+ss"]]],
		["vdd", [["gain", "condition ss", "ss"], ["ugf", "condition ss", "ss"]]],
	]);
	const text = formatAssumptionUses(assumptionUses(assumed as never, "vdd"), verdict);
	assert.match(text, /^assumption vdd: supply\n {2}requirement gain via condition ss; conditions ss\n/);
	assert.match(text, new RegExp(`rows in check ${verdict.id}: 2\\n {4}\\S+ +gain @ ss: 55 dB\\n {4}\\S+ +ugf @ ss: `));
	// The CLI: the newest check of the same requirements file.
	const r = spawnSync(process.execPath, [cli, "assumptions", "tx_leak", "--root", root], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^assumption tx_leak: TX leakage at the LNA input = -34 dBm \(source: system level plan\)$/m);
	assert.match(r.stdout, new RegExp(`rows in check ${verdict.id}: 4`));
	assert.match(spawnSync(process.execPath, [cli, "assumptions", "nope", "--root", root], { encoding: "utf8" }).stderr, /assumption "nope" is not defined/);
	const bad = { ...assumed, requirements: [{ ...amplifier.requirements[0], assumptions: ["unknown"] }], assumptions: { "a b": { description: "" } } };
	await assert.rejects(runCheck({ root: designRoot(t, bad) }), (e: Error) =>
		['assumption "unknown" is not defined', 'assumption "a b": an id has', 'assumption "a b": description is required'].every((m) => e.message.includes(m)));
});

test("gates.limits: an experiment that no row cites runs at every condition of the check", async (t) => {
	const file = {
		...amplifier,
		experiments: { ...amplifier.experiments, dc: { adapter: "ngspice", operation: "simulate", inputs: { deck: "dc.spice" } } },
		gates: { limits: { experiments: ["dc"] } },
	};
	const root = designRoot(t, file);
	const { verdict } = await runCheck({ root });
	// The fixture adapters have no ngspice, so each device_limits run has no table: one not-run gate row per condition.
	const gate = verdict.rows.filter((r) => r.gate?.name === "limits");
	assert.deepEqual(gate.map((r) => [r.condition, r.status]).sort(), [["ss", "not_run"], ["tt", "not_run"]]);
	// A row without a condition does not add a gate run without a condition.
	const withEm = { ...file, experiments: { ...file.experiments, em: { adapter: "fake", operation: "run", inputs: { mode: "values", units: { s21_db: "dB" }, values: { s21_db: -0.2 } } } }, requirements: [...file.requirements, { id: "s21", experiment: "em", measurement: "s21_db", unit: "dB", op: ">=", limit: -0.5 }] };
	const { verdict: v2 } = await runCheck({ root: designRoot(t, withEm) });
	assert.deepEqual(v2.rows.filter((r) => r.gate?.name === "limits").map((r) => r.condition).sort(), ["ss", "tt"]);
	assert.equal(verdict.status, "fail");
});

test("requirements: experiment_inputs of a condition apply to one experiment only, after inputs", async () => {
	const { experimentInputs } = await import("../src/requirements.ts");
	const file = {
		schema: "simra.requirements/0",
		conditions: { hot: { inputs: { libs: ["ngspice.lib"], temp_c: 125 }, experiment_inputs: { hb: { libs: ["xyce.lib"] } } } },
		experiments: { sp: { adapter: "ngspice", operation: "simulate", inputs: { deck: "sp.spice" } }, hb: { adapter: "xyce", operation: "hb", inputs: { deck: "hb.spice" } } },
		requirements: [{ id: "p", experiment: "hb", measurement: "p_dbm", op: ">=", limit: 0, conditions: ["hot"] }],
	} as unknown as RequirementsFile;
	assert.deepEqual(validateRequirements(file), []);
	assert.deepEqual(experimentInputs(file, "sp", "hot"), { deck: "sp.spice", libs: ["ngspice.lib"], temp_c: 125 });
	assert.deepEqual(experimentInputs(file, "hb", "hot"), { deck: "hb.spice", libs: ["xyce.lib"], temp_c: 125 });
	const bad = { ...file, conditions: { hot: { experiment_inputs: { nope: {} } } } } as unknown as RequirementsFile;
	assert.match(validateRequirements(bad).join("\n"), /experiment_inputs.nope: experiment "nope" is not defined/);
});
