// Known answer of the ota-sizing verification: the kernel check of requirements.json with the bench verify.spice
// gives the recorded worst values of expected.json (made by reference.mjs) for the original design and for the
// reference fix, on both PDKs. It runs only with SIMRA_TEST_IMAGE, an image with ngspice and both PDKs
// (optional: SIMRA_TEST_ENGINE podman or docker, default podman; SIMRA_TEST_CPUS for taskset).
// A skipped case is reported by the test runner as skipped: that check did not run.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FIXES, resize } from "../evals/ota-sizing/reference.mjs";
import { loadTask, METRICS, verify } from "../evals/ota-sizing/sizing.mjs";

const repo = new URL("../", import.meta.url).pathname;
const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
// The test image replaces the image of the task; the environment variables of the task stay.
const local = { environments: { eda: { engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image: process.env.SIMRA_TEST_IMAGE, cpus: process.env.SIMRA_TEST_CPUS } } };

for (const name of Object.keys(FIXES)) {
	test(`ota-sizing ${name}: the check gives the recorded worst values of the original and of the fix (container)`, { skip, timeout: 900_000 }, async (t) => {
		const taskDir = join(repo, "evals/ota-sizing", name);
		const { original } = loadTask(taskDir);
		const expected = JSON.parse(readFileSync(join(taskDir, "expected.json"), "utf8"));
		// The real path: on macOS, tmpdir() is under the /var link, which a container engine VM may not have.
		const work = mkdtempSync(join(realpathSync(tmpdir()), "simra-sizing-verify-"));
		t.after(() => rmSync(work, { recursive: true, force: true }));
		const designs = { original, fix: resize(original, FIXES[name]) };
		const results = await Promise.all(Object.entries(designs).map(async ([k, d]) => [k, await verify(taskDir, d, join(work, k), "eda", local)]));
		for (const [k, v] of results) {
			for (const [corner, e] of Object.entries(expected[k].corners)) {
				assert.equal(v[corner].status, "completed", `${k} ${corner}: ${JSON.stringify(v[corner].errors)}`);
				assert.equal(v[corner].points.length, e.sweep.length, `${k} ${corner}: the number of sweep points`);
				for (const m of METRICS) {
					const got = v[corner].worst[m];
					const want = e.worst[m];
					assert.ok(Math.abs(got.value / want.value - 1) < 1e-4, `${k} ${corner} ${m}: ${got.value}, recorded ${want.value}`);
					assert.ok(Math.abs(got.vcm - want.vcm) < 1e-6, `${k} ${corner} ${m}: at VCM ${got.vcm}, recorded ${want.vcm}`);
					assert.equal(got.pass, want.pass, `${k} ${corner} ${m}: pass`);
				}
			}
			assert.equal(Object.values(v).every((c) => METRICS.every((m) => c.worst[m].pass)), expected[k].meets_spec, `${k}: meets the spec`);
		}
	});
}
