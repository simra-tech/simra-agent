// Run N jobs and wait (runJobs, simra jobs): slots of a CPU pool, the watchdog per job, the status and logs per job,
// and the end of the wait. On the fake adapter, in the local environment (taskset pins a job to its slot).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cpuSlots, formatJobs, parseCpuList, type ResultRecord, runJobs, waitExperiments } from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

function designRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "simra-jobs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	return root;
}
const job = (inputs: Record<string, unknown>, timeout_s?: number) => ({ adapter: "fake", operation: "run", inputs, purpose: `fake ${inputs.mode}`, timeout_s });
const result = (root: string, id: string) => JSON.parse(readFileSync(join(root, "simra/experiments", id, "result.json"), "utf8")) as ResultRecord;
// Two CPUs that this process may use (the test pins jobs to them).
const own = readFileSync("/proc/self/status", "utf8").match(/Cpus_allowed_list:\s*(\S+)/)?.[1] ?? "0";
const pool = parseCpuList(own).slice(0, 2);
const skipPool = pool.length < 2 && "this process may use fewer than 2 CPUs";

test("CPU lists and slots", () => {
	assert.deepEqual(parseCpuList("122-125,127,122"), [122, 123, 124, 125, 127]);
	assert.throws(() => parseCpuList("5-3"), /goes down/);
	assert.throws(() => parseCpuList("a"), /invalid CPU list/);
	assert.deepEqual(cpuSlots("122-125"), ["122", "123", "124", "125"]);
	assert.deepEqual(cpuSlots("122-125", 2), ["122,123", "124,125"]);
	assert.deepEqual(cpuSlots("122-126", 2), ["122,123", "124,125"], "the rest of the division is not used");
	assert.deepEqual(cpuSlots("122-123", 8), ["122", "123"]);
});

test("runJobs: each job runs pinned to its slot, at most one job per slot at a time", { skip: skipPool }, async (t) => {
	const root = designRoot(t);
	const cpus = pool.join(",");
	const t0 = Date.now();
	const out = await runJobs({ root, cpus, jobs: [1, 2, 3, 4].map(() => job({ mode: "affinity", seconds: 1 })) });
	assert.deepEqual(out.slots, pool.map(String));
	assert.deepEqual(out.counts, { completed: 4 });
	// 4 jobs of 1 s in 2 slots: 2 rounds.
	assert.ok(Date.now() - t0 >= 2000, `took ${Date.now() - t0} ms`);
	for (const o of out.jobs) {
		const r = result(root, o.id as string);
		assert.equal(r.report?.[0], o.cpus, "the adapter process runs on the CPUs of its slot");
		assert.equal(o.exit_code, 0);
		assert.ok(existsSync(join(root, o.logs.adapter_stderr)) && existsSync(join(root, o.logs.supervisor_stderr)));
	}
	assert.deepEqual(new Set(out.jobs.map((o) => o.cpus)), new Set(pool.map(String)));
});

test("runJobs: the watchdog stops a job that runs too long; the other jobs are not affected", async (t) => {
	const root = designRoot(t);
	const out = await runJobs({ root, parallel: 3, jobs: [job({ mode: "sleep" }, 2), job({ mode: "ok" }), job({ mode: "failed" })] });
	assert.deepEqual(out.jobs.map((o) => o.status), ["timeout", "completed", "failed"]);
	assert.match(out.jobs[0].errors[0], /did not finish in 2 s and was stopped/);
	assert.ok((out.jobs[0].duration_s as number) < 15);
	const text = formatJobs(out);
	assert.match(text, /^job 0 fake\.run \(fake sleep\): timeout; experiment \S+; [\d.]+ s of 2 s/m);
	assert.match(text, /^  adapter_stderr: simra\/experiments\/\S+\/adapter\.stderr\.log$/m);
	assert.match(text, /^jobs: 3 \(1 timeout, 1 completed, 1 failed\)/m);
});

test("runJobs: a job that cannot start is an error with its reason, and its slot is used by the next job", async (t) => {
	const root = designRoot(t);
	const out = await runJobs({ root, parallel: 1, jobs: [{ adapter: "nothere", operation: "run", inputs: {} }, job({ mode: "ok" })] });
	assert.equal(out.jobs[0].status, "error");
	assert.match(out.jobs[0].errors[0], /adapter "nothere" not found/);
	assert.equal(out.jobs[1].status, "completed");
	await assert.rejects(runJobs({ root, jobs: [] }), /no jobs/);
	await assert.rejects(runJobs({ root, jobs: [job({ mode: "ok" }, -1)] }), /timeout_s must be a positive number/);
});

test("runJobs: at the end of the wait, a started job is running and a job in the queue is not_started", async (t) => {
	const root = designRoot(t);
	const out = await runJobs({ root, parallel: 1, waitTimeoutS: 1, jobs: [job({ mode: "slow", seconds: 3 }), job({ mode: "ok" })] });
	assert.deepEqual(out.jobs.map((o) => o.status), ["running", "not_started"]);
	assert.equal(out.jobs[1].id, null);
	assert.match(formatJobs(out), /wait for it with wait_experiments/);
	assert.match(formatJobs(out), /did not start never runs/);
	// The running job continues and ends.
	const [later] = await waitExperiments(root, [out.jobs[0].id as string], { timeoutS: 30 });
	assert.equal(later.status, "completed");
});

test("simra jobs: one line per job, exit code 1 when a job did not complete", async (t) => {
	const root = designRoot(t);
	writeFileSync(join(root, "jobs.json"), JSON.stringify({ jobs: [job({ mode: "ok" }), job({ mode: "failed" })] }));
	const r = spawnSync(process.execPath, [cli, "jobs", "jobs.json", "--parallel", "2", "--root", root], { cwd: root, encoding: "utf8" });
	assert.equal(r.status, 1, r.stderr);
	assert.match(r.stdout, /^job 0 fake\.run \(fake ok\): completed; experiment /m);
	assert.match(r.stdout, /^job 1 fake\.run \(fake failed\): failed; /m);
	assert.match(r.stderr, /^started job 0 \(/m);
});
