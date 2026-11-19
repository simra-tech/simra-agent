// Detached experiments, the wait, the CLI (run --detach, wait) and the runtime estimate, on the fake adapter.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type ExperimentRecord,
	formatEstimate,
	formatOutcome,
	formatStarted,
	readStatus,
	type ResultRecord,
	runDetachedWorker,
	runExperiment,
	runtimeEstimate,
	waitExperiments,
} from "../src/index.ts";
import { telemetry } from "../src/telemetry.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

function designRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "simra-detached-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	return root;
}

const start = (root: string, inputs: Record<string, unknown>, timeoutS?: number) =>
	runExperiment({ root, adapter: "fake", operation: "run", inputs, purpose: "detached test", timeoutS, detached: true });

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("analytics metadata failures cannot stop a detached worker", async (t) => {
	const enabled = t.mock.method(telemetry, "enabled", () => false);
	for (const active of [false, true]) {
		enabled.mock.mockImplementation(() => active);
		for (const metadata of [undefined, "{invalid-json"]) {
			const root = designRoot(t);
			const id = "20990101-000000-abcdef";
			const dir = join(root, "simra", "experiments", id);
			mkdirSync(dir, { recursive: true });
			if (metadata !== undefined) writeFileSync(join(dir, "experiment.json"), metadata);
			const response = join(dir, "response.json");
			const script = `require("node:fs").writeFileSync(process.argv[1], JSON.stringify({contract:"simra.adapter/0",status:"completed",tool:{name:"fake",version:"1"},input_files:{files:[],complete:true},outputs:[],measurements:{},diagnostics:[]}));`;
			writeFileSync(join(dir, "job.json"), JSON.stringify({ root, id, command: process.execPath, args: ["-e", script, response], timeout_s: 5 }));
			const result = await runDetachedWorker(dir);
			assert.equal(result.status, "completed");
			assert.ok(existsSync(response), "the adapter must execute even if optional analytics metadata is missing or invalid");
			assert.equal(readStatus(root, id)?.status, "completed");
		}
	}
});

test("a detached run returns before the adapter ends, and the wait returns its result", async (t) => {
	const root = designRoot(t);
	const t0 = Date.now();
	const started = await start(root, { mode: "slow", seconds: 3 });
	// The call returns before the adapter ends (also on a loaded host).
	assert.ok(Date.now() - t0 < 3000, `the call took ${Date.now() - t0} ms`);
	assert.equal(started.status.status, "running");
	assert.equal(started.status.detached, true);
	assert.ok(alive(started.status.pid), "the supervisor does not run");
	assert.equal(existsSync(join(started.dir, "result.json")), false);
	assert.equal(readStatus(root, started.id)?.status, "running");
	assert.match(formatStarted(root, started.experiment, started.estimate), new RegExp(`^experiment ${started.id}: running \\(detached\\)\\nrecords: simra/experiments/${started.id}/`));

	const [outcome] = await waitExperiments(root, [started.id], { timeoutS: 30 });
	assert.ok(Date.now() - t0 >= 3000);
	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.result?.measurements.x, { value: 1.5, unit: "V", status: "measured" });
	const status = readStatus(root, started.id);
	assert.equal(status?.status, "completed");
	assert.equal(status?.pid, started.status.pid);
	assert.ok(status?.finished_at);
});

test("the wait returns the outcomes in the order asked, with running for a run that did not end at the timeout", async (t) => {
	const root = designRoot(t);
	const slow = await start(root, { mode: "slow", seconds: 8 });
	const fast = await start(root, { mode: "ok" });
	assert.equal((await waitExperiments(root, [fast.id], { timeoutS: 30 }))[0].status, "completed");
	const t0 = Date.now();
	const first = await waitExperiments(root, [slow.id, fast.id], { timeoutS: 1 });
	assert.ok(Date.now() - t0 < 2500, `the wait took ${Date.now() - t0} ms`);
	assert.deepEqual(first.map((o) => [o.id, o.status]), [[slow.id, "running"], [fast.id, "completed"]]);
	assert.equal(first[0].result, null);
	// An abort ends the wait at once; the run continues.
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);
	const aborted = await waitExperiments(root, [slow.id], { timeoutS: 30, signal: controller.signal });
	assert.equal(aborted[0].status, "running");
	const second = await waitExperiments(root, [slow.id], { timeoutS: 30 });
	assert.equal(second[0].status, "completed");
	await assert.rejects(waitExperiments(root, ["20990101-000000-000000"]), /experiment "20990101-000000-000000" not found/);
	await assert.rejects(waitExperiments(root, [".."]), /not found/);
});

test("a detached run applies its timeout", async (t) => {
	const root = designRoot(t);
	const started = await start(root, { mode: "sleep" }, 1);
	const [outcome] = await waitExperiments(root, [started.id], { timeoutS: 30 });
	assert.equal(outcome.status, "timeout");
	assert.match(outcome.result?.errors.join("\n") ?? "", /did not finish in 1 s/);
});

test("a killed supervisor is recorded as error by the next wait, and its adapter is stopped", async (t) => {
	const root = designRoot(t);
	const started = await start(root, { mode: "sleep" });
	// The adapter has started when its stdout log exists.
	for (let i = 0; i < 50 && !existsSync(join(started.dir, "adapter.stdout.log")); i++) await new Promise((r) => setTimeout(r, 100));
	await new Promise((r) => setTimeout(r, 300));
	const adapters = () => spawnSync("pgrep", ["-f", join(started.dir, "request.json")], { encoding: "utf8" }).stdout.trim();
	assert.notEqual(adapters(), "", "the adapter does not run");
	process.kill(started.status.pid, "SIGKILL");
	const [outcome] = await waitExperiments(root, [started.id], { timeoutS: 30 });
	assert.equal(outcome.status, "error");
	assert.match(outcome.result?.errors[0] ?? "", new RegExp(`supervisor process \\(pid ${started.status.pid}\\) ended before it wrote result\\.json`));
	const recorded = JSON.parse(readFileSync(join(started.dir, "result.json"), "utf8")) as ResultRecord;
	assert.equal(recorded.status, "error");
	assert.equal(readStatus(root, started.id)?.status, "error");
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(adapters(), "", "the adapter still runs");
});

test("a supervisor that gets SIGTERM records the run as cancelled", async (t) => {
	const root = designRoot(t);
	const started = await start(root, { mode: "sleep" });
	for (let i = 0; i < 50 && !existsSync(join(started.dir, "adapter.stdout.log")); i++) await new Promise((r) => setTimeout(r, 100));
	await new Promise((r) => setTimeout(r, 300));
	process.kill(started.status.pid, "SIGTERM");
	const [outcome] = await waitExperiments(root, [started.id], { timeoutS: 30 });
	assert.equal(outcome.status, "cancelled");
});

test("a blocking run writes status.json with its own pid, and a wait gives its result", async (t) => {
	const root = designRoot(t);
	const { id } = await runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" } });
	const status = readStatus(root, id);
	assert.deepEqual([status?.status, status?.detached, status?.pid], ["completed", false, process.pid]);
	const [outcome] = await waitExperiments(root, [id], { timeoutS: 0 });
	assert.equal(outcome.status, "completed");
});

test("the CLI starts a detached run and waits for it", async (t) => {
	const root = designRoot(t);
	writeFileSync(join(root, "slow.json"), JSON.stringify({ adapter: "fake", operation: "run", purpose: "cli", inputs: { mode: "slow", seconds: 6 } }));
	const run = spawnSync(process.execPath, [cli, "run", "--detach", "slow.json", "--root", root], { cwd: root, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	const id = run.stdout.match(/^experiment (\S+): running \(detached\)$/m)?.[1];
	assert.ok(id, run.stdout);
	// The command returned before the adapter ended.
	assert.equal(existsSync(join(root, "simra", "experiments", id, "result.json")), false);
	assert.match(run.stdout, new RegExp(`^wait: simra wait ${id}$`, "m"));

	const short = spawnSync(process.execPath, [cli, "wait", id, "--timeout-s", "0", "--root", root], { cwd: root, encoding: "utf8" });
	assert.equal(short.status, 1, short.stderr);
	assert.match(short.stdout, new RegExp(`^experiment ${id}: still running after 0 s \\(records: simra/experiments/${id}/\\)$`, "m"));
	const list = spawnSync(process.execPath, [cli, "list", "--root", root], { cwd: root, encoding: "utf8" });
	assert.match(list.stdout, new RegExp(`^${id}  running  fake\\.run  cli$`, "m"));

	const wait = spawnSync(process.execPath, [cli, "wait", id, "--timeout-s", "30", "--root", root], { cwd: root, encoding: "utf8" });
	assert.equal(wait.status, 0, wait.stderr);
	assert.match(wait.stdout, new RegExp(`^experiment ${id}: completed \\([\\d.]+ s\\)$`, "m"));
	assert.match(wait.stdout, /^ {2}x = 1\.5 V$/m);
	const bad = spawnSync(process.execPath, [cli, "wait", "nope", "--root", root], { cwd: root, encoding: "utf8" });
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /experiment "nope" not found/);
});

/** Write the records of an earlier run, with the given duration and status. */
function record(root: string, id: string, fields: { operation?: string; inputs?: Record<string, unknown>; status?: string; duration_s: number; finished_at?: string }) {
	const dir = join(root, "simra", "experiments", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "experiment.json"), JSON.stringify({
		schema: "simra.experiment/0",
		id,
		created_at: "2026-11-01T10:00:00.000Z",
		adapter: { name: "klayout", version: "0.1.0", dir: "/adapters/klayout", files: [] },
		operation: fields.operation ?? "drc",
		inputs: fields.inputs ?? { gds: "block.gds", cell: "top" },
	}));
	writeFileSync(join(dir, "result.json"), JSON.stringify({ status: fields.status ?? "completed", duration_s: fields.duration_s, finished_at: fields.finished_at ?? "2026-11-01T10:10:00.000Z" }));
}

const now = (inputs: Record<string, unknown> = { gds: "block.gds", cell: "top" }) =>
	({ id: "20261102-120000-aaaaaa", created_at: "2026-11-02T12:00:00.000Z", adapter: { name: "klayout" }, operation: "drc", inputs }) as unknown as ExperimentRecord;

test("the estimate: no line without an earlier run", (t) => {
	const root = designRoot(t);
	assert.equal(runtimeEstimate(root, now()), null);
	// Runs of another kind do not count: another operation, another rule set, a failed run, a run that ended later.
	record(root, "20261101-100000-000001", { operation: "lvs", duration_s: 80 });
	record(root, "20261101-100000-000002", { inputs: { gds: "block.gds", rule_set: "full" }, duration_s: 900 });
	record(root, "20261101-100000-000005", { inputs: { gds: "block.gds", technology: "sky130" }, duration_s: 300 });
	record(root, "20261101-100000-000003", { status: "failed", duration_s: 5 });
	record(root, "20261101-100000-000004", { duration_s: 7, finished_at: "2026-11-02T12:00:01.000Z" });
	assert.equal(runtimeEstimate(root, now()), null);
});

test("the estimate: one earlier run", (t) => {
	const root = designRoot(t);
	record(root, "20261101-100000-000001", { duration_s: 391.84 });
	const e = runtimeEstimate(root, now());
	assert.deepEqual(e, { adapter: "klayout", operation: "drc", rule_set: null, technology: null, min_s: 391.84, max_s: 391.84, runs: 1 });
	assert.equal(formatEstimate(e!), "estimate: earlier runs of klayout drc on this design took 391.8 s (1 run)");
});

test("the estimate: several earlier runs, of the same rule set", (t) => {
	const root = designRoot(t);
	record(root, "20261101-100000-000001", { duration_s: 427.7 });
	record(root, "20261101-100000-000002", { duration_s: 391.8 });
	record(root, "20261101-100000-000003", { duration_s: 400 });
	record(root, "20261101-100000-000004", { inputs: { rule_set: "full" }, duration_s: 900 });
	record(root, "20261101-100000-000005", { inputs: { rule_set: "full" }, duration_s: 950 });
	record(root, "20261101-100000-000006", { inputs: { rule_set: "full", technology: "sky130" }, duration_s: 120 });
	assert.equal(formatEstimate(runtimeEstimate(root, now())!), "estimate: earlier runs of klayout drc on this design took 391.8 to 427.7 s (3 runs)");
	assert.equal(formatEstimate(runtimeEstimate(root, now({ rule_set: "full" }))!), "estimate: earlier runs of klayout drc (rule set full) on this design took 900.0 to 950.0 s (2 runs)");
	// Two PDKs in one design root do not mix: the technology input is part of the kind.
	assert.equal(formatEstimate(runtimeEstimate(root, now({ rule_set: "full", technology: "sky130" }))!), "estimate: earlier runs of klayout drc (rule set full, technology sky130) on this design took 120.0 s (1 run)");
});

test("a run gives the estimate of the earlier runs, after the adapter line of the summary", async (t) => {
	const root = designRoot(t);
	const first = await runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" } });
	assert.equal(first.estimate, null);
	assert.doesNotMatch(formatOutcome(root, first.experiment, first.result, first.estimate), /^estimate:/m);
	await runExperiment({ root, adapter: "fake", operation: "check_design", inputs: { mode: "ok" } });
	const second = await runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" } });
	assert.equal(second.estimate?.runs, 1);
	const lines = formatOutcome(root, second.experiment, second.result, second.estimate).split("\n");
	const at = lines.findIndex((l) => l.startsWith("adapter: fake "));
	assert.match(lines[at + 1], /^estimate: earlier runs of fake run on this design took \d+\.\d s \(1 run\)$/);
	const detached = await start(root, { mode: "ok" });
	assert.equal(detached.estimate?.runs, 2);
	assert.match(formatStarted(root, detached.experiment, detached.estimate), /^estimate: earlier runs of fake run on this design took [\d.]+ to [\d.]+ s \(2 runs\)$/m);
	await waitExperiments(root, [detached.id], { timeoutS: 30 });
});
