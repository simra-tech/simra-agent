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

test("a summary without outputs has no outputs line", () => {
	assert.doesNotMatch(formatOutcome(root, experiment, result([])), /^outputs:/m);
});
