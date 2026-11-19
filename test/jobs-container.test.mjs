// Run N jobs and wait, in a container environment: the watchdog of a job stops the adapter and removes its container
// (found by the label simra.experiment=<id>, not by a process name); the other job completes on its own CPU slot.
// It runs only with SIMRA_TEST_IMAGE, an image with python3 (optional: SIMRA_TEST_ENGINE, SIMRA_TEST_CPUS, a CPU
// list with at least 2 CPUs). A skipped case is reported as skipped: that check did not run.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpuSlots, runJobs } from "@simra-tech/kernel";

const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
const engine = process.env.SIMRA_TEST_ENGINE ?? "podman";
const adapters = new URL("./fixtures/adapters/", import.meta.url).pathname;

test("run_jobs in a container: the watchdog removes the container of the stopped job (container)", { skip, timeout: 300_000 }, async (t) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-jobs-c-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const config = { kind: "container", engine, image: process.env.SIMRA_TEST_IMAGE, env: { HOME: "/tmp" } };
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [adapters], environments: { eda: config } }));
	const cpus = process.env.SIMRA_TEST_CPUS ?? "0-1";
	const jobs = [
		{ adapter: "sleeper", operation: "sleep", inputs: { seconds: 600 }, environment: "eda", timeout_s: 5 },
		{ adapter: "sleeper", operation: "sleep", inputs: { seconds: 1 }, environment: "eda", timeout_s: 120 },
	];
	const out = await runJobs({ root, jobs, cpus, parallel: 2 });
	assert.deepEqual(out.jobs.map((o) => o.status), ["timeout", "completed"]);
	assert.deepEqual(out.jobs.map((o) => o.cpus), cpuSlots(cpus, 2));
	const left = execFileSync(engine, ["ps", "-aq", "--filter", `label=simra.experiment=${out.jobs[0].id}`], { encoding: "utf8" }).trim();
	assert.equal(left, "", "the container of the stopped job still exists");
});
