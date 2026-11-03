import assert from "node:assert/strict";
import { test } from "node:test";
import { formatOutcome, type ExperimentRecord, type ResultRecord } from "../src/index.ts";

const root = "/design";
const id = "20261102-120000-abc123";

const experiment = {
	schema: "simra.experiment/0",
	id,
	created_at: "2026-11-02T12:00:00Z",
	purpose: "test",
	adapter: { name: "fake", version: "1", dir: "/adapters/fake", files: [] },
	operation: "run",
	inputs: {},
	environment: { name: "local" },
	design: { root, git_commit: null, git_dirty: null },
	simra: { kernel_version: "0" },
} as ExperimentRecord;

function result(outputs: ResultRecord["outputs"]): ResultRecord {
	return {
		schema: "simra.result/0",
		experiment: id,
		status: "completed",
		started_at: "2026-11-02T12:00:00Z",
		finished_at: "2026-11-02T12:00:01Z",
		duration_s: 1,
		exit_code: 0,
		signal: null,
		errors: [],
		tool: { name: "fake", version: "1" },
		input_files: { files: [{ path: "tb.spice", sha256: "a".repeat(64), bytes: 10, role: "deck" }], complete: true },
		outputs,
		measurements: { x: { value: 1.5, unit: "V", status: "measured" } },
		diagnostics: [{ severity: "error", message: "M1.a: 4 markers", source: "work/drc/x.lyrdb" }],
		logs: { adapter_stdout: "adapter.stdout.log", adapter_stderr: "adapter.stderr.log" },
	};
}

test("the summary lists the outputs after the input files, in the order of the response, with their sizes", () => {
	const dir = `simra/experiments/${id}`;
	const text = formatOutcome(root, experiment, result([
		{ path: `${dir}/work/drc.json`, sha256: "b".repeat(64), bytes: 5120 },
		{ path: `${dir}/work/drc.log`, sha256: "c".repeat(64), bytes: 812 },
		{ path: `${dir}/work/drc/x.lyrdb`, sha256: "d".repeat(64) },
	]));
	const lines = text.split("\n");
	const at = lines.indexOf("outputs:");
	assert.ok(at > lines.findIndex((l) => l.startsWith("  deck tb.spice")), text);
	assert.ok(at < lines.indexOf("measurements:"), text);
	assert.deepEqual(lines.slice(at + 1, at + 4), [
		`  ${dir}/work/drc.json (5120 bytes)`,
		`  ${dir}/work/drc.log (812 bytes)`,
		`  ${dir}/work/drc/x.lyrdb`,
	]);
});

test("an output with a role is listed with the role, for example an image", () => {
	const dir = `simra/experiments/${id}`;
	const text = formatOutcome(root, experiment, result([
		{ path: `${dir}/work/render.json`, sha256: "b".repeat(64), bytes: 300 },
		{ path: `${dir}/work/render.png`, sha256: "c".repeat(64), bytes: 98000, role: "image" },
	]));
	const lines = text.split("\n");
	const at = lines.indexOf("outputs:");
	assert.deepEqual(lines.slice(at + 1, at + 3), [`  ${dir}/work/render.json (300 bytes)`, `  image ${dir}/work/render.png (98000 bytes)`]);
});

test("a summary without outputs has no outputs line", () => {
	assert.doesNotMatch(formatOutcome(root, experiment, result([])), /^outputs:/m);
});

test("the summary gives one command line for each entry of commands, after the tool line", () => {
	const r = result([]);
	r.commands = [
		{ argv: ["klayout", "-b", "-r", "/pdk/deck dir/drc.lydrc", "-rd", "cell=idac"], exit_code: 1, runtime_s: 12.4 },
		{ argv: ["probe"], exit_code: null, runtime_s: null },
	];
	const lines = formatOutcome(root, experiment, r).split("\n");
	const at = lines.indexOf("tool: fake 1");
	assert.deepEqual(lines.slice(at + 1, at + 3), [
		'command: klayout -b -r "/pdk/deck dir/drc.lydrc" -rd cell=idac (exit 1, 12.4 s)',
		"command: probe (no exit code)",
	]);
});

test("a summary without commands has no command line", () => {
	assert.doesNotMatch(formatOutcome(root, experiment, result([])), /^command:/m);
});

test("the summary prints the report lines as they are, after the measurements and before the diagnostics", () => {
	const r = result([]);
	r.report = ["[1] at (0.000,0.000;1.000,1.000): 1 layers, 0 instances (deepest), 0 texts", "  layer Metal1 8/0  shapes=1  area=1.000"];
	const lines = formatOutcome(root, experiment, r).split("\n");
	const at = lines.indexOf("report:");
	assert.ok(at > lines.indexOf("  x = 1.5 V"), lines.join("\n"));
	assert.deepEqual(lines.slice(at + 1, at + 4), [...r.report, "error (work/drc/x.lyrdb): M1.a: 4 markers"]);
});

test("a summary without a report has no report line", () => {
	assert.doesNotMatch(formatOutcome(root, experiment, result([])), /^report:/m);
	const r = result([]);
	r.report = [];
	assert.doesNotMatch(formatOutcome(root, experiment, r), /^report:/m);
});
