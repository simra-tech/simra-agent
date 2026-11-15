// Requirement kind monte_carlo, the operating-limit gate rows, and the result query, on hand-made records.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	evaluateRow,
	experimentCondition,
	formatQuery,
	limitsGateRows,
	queryRecords,
	type Requirement,
	type RequirementsFile,
	type ResultRecord,
	sha256File,
	validateRequirements,
} from "../src/index.ts";

function tempRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "simra-mc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function result(root: string, id: string, file: string, role: string, data: unknown, measurements: ResultRecord["measurements"] = {}): ResultRecord {
	const dir = join(root, "simra", "experiments", id, "work");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, JSON.stringify(data));
	return {
		status: "completed",
		outputs: [{ path: `simra/experiments/${id}/work/${file}`, sha256: sha256File(path), role }],
		measurements,
		diagnostics: [],
	} as unknown as ResultRecord;
}

const seeds = (values: (number | null)[]) => ({
	schema: "simra.monte_carlo/0",
	measurements: { offset_v: "V" },
	seeds: values.map((v, i) => ({ seed: i + 1, status: v === null ? "no_dc" : "ok", dc: v === null ? "none" : "newton", values: { offset_v: v } })),
});

const mcReq = (extra: Partial<Requirement> = {}): Requirement =>
	({ id: "offset", experiment: "mc", kind: "monte_carlo", measurement: "offset_v", statistic: "mean_abs_k_sigma", op: "<=", limit: 0.02, min_seeds: 4, ...extra }) as Requirement;

test("monte_carlo: |mean| + 3 sigma over the seeds, and the extreme seed", (t) => {
	const root = tempRoot(t);
	const r = result(root, "e1", "mc.json", "monte_carlo", seeds([0.001, -0.002, 0.003, 0.0, 0.002]));
	const row = evaluateRow(mcReq(), "tt", { id: "e1", result: r }, "", root);
	const v = [0.001, -0.002, 0.003, 0.0, 0.002];
	const mean = v.reduce((a, b) => a + b) / 5;
	const sigma = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / 4);
	assert.equal(row.status, "pass");
	assert.ok(Math.abs((row.value as number) - (Math.abs(mean) + 3 * sigma)) < 1e-12);
	assert.equal(row.unit, "V");
	assert.equal(row.measurement, "offset_v |mean|+3sigma");
	const worst = evaluateRow(mcReq({ statistic: "abs_max", limit: 0.0025 }), "tt", { id: "e1", result: r }, "", root);
	assert.equal(worst.status, "fail");
	assert.deepEqual(worst.at, { seed: 3 });
});

test("monte_carlo: a seed without a DC point, too few seeds, or no variation is not measured", (t) => {
	const root = tempRoot(t);
	const withHole = result(root, "e2", "mc.json", "monte_carlo", seeds([0.001, null, 0.003, 0.0, 0.002]));
	const a = evaluateRow(mcReq(), "tt", { id: "e2", result: withHole }, "", root);
	assert.equal(a.status, "not_measured");
	assert.match(a.reason as string, /no DC point: 2/);
	const few = result(root, "e3", "mc.json", "monte_carlo", seeds([0.001, 0.002]));
	assert.equal(evaluateRow(mcReq(), "tt", { id: "e3", result: few }, "", root).status, "not_measured");
	const flat = result(root, "e4", "mc.json", "monte_carlo", seeds([0.001, 0.001, 0.001, 0.001]));
	const f = evaluateRow(mcReq(), "tt", { id: "e4", result: flat }, "", root);
	assert.equal(f.status, "not_measured");
	assert.match(f.reason as string, /not active/);
});

test("monte_carlo: validation of statistic, k and min_seeds", () => {
	const file = {
		schema: "simra.requirements/0",
		conditions: { tt: {} },
		experiments: { mc: { adapter: "ngspice", operation: "monte_carlo", inputs: {} } },
		requirements: [
			{ id: "a", experiment: "mc", kind: "monte_carlo", measurement: "offset_v", statistic: "median", op: "<=", limit: 1, conditions: ["tt"] },
			{ id: "b", experiment: "mc", kind: "monte_carlo", measurement: "offset_v", statistic: "sigma", k: -1, min_seeds: 1, op: "<=", limit: 1, conditions: ["tt"] },
			{ id: "c", experiment: "mc", measurement: "offset_v", statistic: "sigma", op: "<=", limit: 1, conditions: ["tt"] },
		],
	} as unknown as RequirementsFile;
	const errors = validateRequirements(file).join("\n");
	assert.match(errors, /"a": kind monte_carlo needs statistic/);
	assert.match(errors, /"b": k must be a positive number/);
	assert.match(errors, /"b": min_seeds must be an integer/);
	assert.match(errors, /"c": statistic, k and min_seeds are for kind monte_carlo/);
});

test("gates.limits: validation of experiments, tran and extra limits", () => {
	const file = {
		schema: "simra.requirements/0",
		conditions: { tt: {} },
		experiments: { bench: { adapter: "ngspice", operation: "simulate", inputs: {} } },
		requirements: [{ id: "x", experiment: "bench", measurement: "x", op: "<=", limit: 1, conditions: ["tt"] }],
		assumptions: { vmin: { description: "a minimum" } },
		gates: {
			limits: {
				experiments: ["nope"],
				tran: { bench: { step_s: 1e-9, stop_s: 1e-10 } },
				extra_limits: [
					{ id: "ok", class: "hbt", quantity: "vcb", op: ">=", limit: 0, assumption: "vmin" },
					{ id: "bad", class: "hbt", quantity: "vce", op: ">=", limit: 0.9 },
					{ id: "bad2", class: "hbt", quantity: "vce", op: ">=", limit: 0.9, assumption: "other" },
				],
			},
		},
	} as unknown as RequirementsFile;
	const errors = validateRequirements(file).join("\n");
	assert.match(errors, /gates.limits: experiment "nope" is not defined/);
	assert.match(errors, /gates.limits.tran.bench/);
	assert.match(errors, /"bad": give a source or an assumption/);
	assert.match(errors, /"bad2": assumption "other" is not defined/);
	assert.doesNotMatch(errors, /"ok"/);
});

test("gates.limits: one row per applicable limit, assumed limits cite their assumption, a missing table is not run", (t) => {
	const root = tempRoot(t);
	const limits = {
		limits: [
			{ id: "hbt_vce_max", class: "hbt", quantity: "vce", op: "<=", limit: 1.6, source: "model card", assumption: null, description: null, at: "dc", value: 1.42, device: "q.xdut.xq1.qnpn13g2", status: "pass", reason: null },
			{ id: "hbt_ib_reverse", class: "hbt", quantity: "ib", op: ">=", limit: 0, source: null, assumption: "limit_hbt_ib_reverse", description: "no reverse base current", at: "dc", value: -1e-6, device: "q.xa.qnpn13g2", status: "fail", reason: null },
			{ id: "mos_lv_vds_max", class: "mos_lv", quantity: "vds", op: "<=", limit: 1.6, source: "x", assumption: null, description: null, at: "dc", value: null, device: null, status: "not_applicable", reason: "no device" },
			{ id: "hbt_vce_max", class: "hbt", quantity: "vce", op: "<=", limit: 1.6, source: "model card", assumption: null, description: null, at: "peak", value: 1.7, device: "q.xdut.xq1.qnpn13g2", status: "fail", reason: null },
		],
	};
	const r = result(root, "g1", "limits.json", "device_limits", limits);
	const failed = { status: "failed", outputs: [], measurements: {}, diagnostics: [] } as unknown as ResultRecord;
	const rows = limitsGateRows(
		[
			{ experiment: "bench", condition: "tt", id: "g1", result: r },
			{ experiment: "bench", condition: "ss", id: "g2", result: failed },
		],
		root,
	);
	const tt = rows.filter((x) => x.condition === "tt");
	assert.deepEqual(tt.map((x) => [x.requirement, x.status]), [["gate limits hbt_vce_max", "pass"], ["gate limits hbt_ib_reverse", "fail"], ["gate limits hbt_vce_max peak", "fail"]]);
	assert.equal(tt[1].unit, "A");
	assert.deepEqual(tt[1].assumptions, ["limit_hbt_ib_reverse"]);
	assert.match(tt[1].reason as string, /assumed: no reverse base current/);
	assert.match(tt[0].reason as string, /worst device q.xdut.xq1.qnpn13g2/);
	const ss = rows.filter((x) => x.condition === "ss");
	assert.equal(ss.length, 1);
	assert.equal(ss[0].status, "not_run");
	assert.equal(ss[0].gate?.name, "limits");
});

test("query: measurements of experiments by condition and name, and rows of the newest check", (t) => {
	const root = tempRoot(t);
	const write = (id: string, purpose: string, inputs: Record<string, unknown>, measurements: Record<string, unknown>) => {
		const dir = join(root, "simra", "experiments", id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "experiment.json"), JSON.stringify({ id, created_at: "2026-11-15T10:00:00Z", purpose, adapter: { name: "ngspice" }, operation: "simulate", inputs }));
		writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "completed", outputs: [], measurements, diagnostics: [] }));
	};
	write("20261115-100000-aaaaaa", "check 20261115-095959-cccccc: bench at slow_hot", {}, { gain_db: { value: 20, unit: "dB", status: "measured" }, idd_a: { value: 1e-3, unit: "A", status: "measured" } });
	write("20261115-100001-bbbbbb", "my sweep", { temp_c: 27, params: { vcc: 1.8 } }, { gain_db: { value: 21, unit: "dB", status: "measured" } });
	const q = queryRecords(root, { measurement: "gain" });
	assert.equal(q.matched, 2);
	assert.equal(q.rows[0].id, "20261115-100001-bbbbbb");
	assert.equal(q.rows[0].condition, "T=27 vcc=1.8");
	assert.equal(queryRecords(root, { condition: "slow_hot" }).matched, 2);
	assert.equal(queryRecords(root, { measurement: "/^idd/" }).rows[0].value, 1e-3);
	assert.equal(experimentCondition("check x: bench at tt", {}), "tt");
	assert.throws(() => queryRecords(root, { source: "checks" }), /no check/);
	const cdir = join(root, "simra", "checks", "20261115-110000-dddddd");
	mkdirSync(cdir, { recursive: true });
	writeFileSync(join(cdir, "verdict.json"), JSON.stringify({
		id: "20261115-110000-dddddd", created_at: "2026-11-15T11:00:00Z",
		experiments: [{ id: "20261115-100000-aaaaaa", experiment: "bench", condition: "slow_hot", status: "completed", diagnostics: [] }],
		rows: [
			{ requirement: "gain", condition: "slow_hot", measurement: "gain_db", op: ">=", limit: 20, value: 20, unit: "dB", margin: 0, margin_rel: 0, status: "pass", experiment: "20261115-100000-aaaaaa", reason: null, at: null },
			{ requirement: "idd", condition: "slow_hot", measurement: "idd_a", op: "<=", limit: 5e-4, value: 1e-3, unit: "A", margin: -5e-4, margin_rel: -1, status: "fail", experiment: "20261115-100000-aaaaaa", reason: null, at: null },
		],
	}));
	const c = queryRecords(root, { requirement: "idd" });
	assert.equal(c.source, "checks");
	assert.equal(c.rows.length, 1);
	assert.equal(c.rows[0].status, "fail");
	assert.match(formatQuery(c), /check 20261115-110000-dddddd: 1 rows/);
	assert.equal(queryRecords(root, { source: "checks", status: "pass", experiment: "bench" }).rows.length, 1);
});
