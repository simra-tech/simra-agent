import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { listExperiments, loadExperiment, queryAdapter, runExperiment } from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;

function designRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "simra-kernel-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	return root;
}

const run = (root: string, mode: string, extra: { timeoutS?: number; signal?: AbortSignal } = {}) =>
	runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode }, purpose: `mode ${mode}`, ...extra });

test("a completed run writes both records", async (t) => {
	const root = designRoot(t);
	const { id, dir, result } = await run(root, "ok");
	assert.equal(result.status, "completed");
	assert.deepEqual(result.measurements.x, { value: 1.5, unit: "V", status: "measured" });
	assert.deepEqual(result.errors, []);

	const loaded = loadExperiment(root, id);
	assert.equal(loaded.experiment.schema, "simra.experiment/0");
	assert.equal(loaded.experiment.purpose, "mode ok");
	assert.deepEqual(loaded.experiment.inputs, { mode: "ok" });
	assert.equal(loaded.experiment.environment.kind, "local");
	assert.deepEqual(
		loaded.experiment.adapter.files.map((f) => f.path),
		["adapter.json", "fake.mjs"],
	);
	assert.equal(loaded.result?.schema, "simra.result/0");
	const request = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
	assert.equal(request.contract, "simra.adapter/0");
	assert.equal(request.work_dir, join(dir, "work"));
});

test("execution status is separate from runner errors", async (t) => {
	const root = designRoot(t);
	const cases: [string, string, RegExp | null][] = [
		["failed", "failed", null],
		["crash", "error", /wrote no response \(exit code 3\)/],
		["invalid-json", "error", /not valid JSON/],
		["wrong-contract", "error", /contract other\/1/],
		["bad-exit", "error", /exited with code 1/],
	];
	for (const [mode, status, error] of cases) {
		const { result } = await run(root, mode);
		assert.equal(result.status, status, mode);
		if (error) assert.match(result.errors.join("\n"), error, mode);
		else assert.deepEqual(result.errors, [], mode);
	}
	assert.equal(listExperiments(root).length, cases.length);
});

test("a run that exceeds its timeout is stopped", async (t) => {
	const root = designRoot(t);
	const { result } = await run(root, "sleep", { timeoutS: 1 });
	assert.equal(result.status, "timeout");
	assert.ok(result.duration_s < 15);
});

test("a cancelled run is recorded as cancelled", async (t) => {
	const root = designRoot(t);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 300);
	const { result } = await run(root, "sleep", { signal: controller.signal });
	assert.equal(result.status, "cancelled");
});

test("configuration errors create no experiment", async (t) => {
	const root = designRoot(t);
	await assert.rejects(runExperiment({ root, adapter: "nope", operation: "run", inputs: {} }), /adapter "nope" not found/);
	await assert.rejects(runExperiment({ root, adapter: "fake", operation: "nope", inputs: {} }), /no operation "nope"/);
	await assert.rejects(
		runExperiment({ root, adapter: "fake", operation: "run", inputs: {}, environment: "eda" }),
		/environment "eda" is not defined/,
	);
	assert.equal(listExperiments(root).length, 0);
});

test("queryAdapter returns the response and writes no record", async (t) => {
	const root = designRoot(t);
	const ok = await queryAdapter({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" } });
	assert.equal(ok.status, "completed");
	assert.deepEqual(ok.measurements.x, { value: 1.5, unit: "V", status: "measured" });
	assert.equal(existsSync(join(root, "simra")), false);
	const crash = await queryAdapter({ root, adapter: "fake", operation: "run", inputs: { mode: "crash" } });
	assert.equal(crash.status, "error");
	assert.match(crash.errors[0], /wrote no response/);
});
