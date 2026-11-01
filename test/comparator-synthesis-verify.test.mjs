// Known answer of the comparator-synthesis verification: the kernel check of requirements.json with the transient
// bench verify.spice gives the recorded results of expected.json (made by reference.mjs) for the four reference
// designs (the reference, the known fail, the cheat and the input load), on both PDKs: the status, the errors and
// the measurements of the design part, and the worst values. It runs only with SIMRA_TEST_IMAGE, an image with ngspice and both
// PDKs (optional: SIMRA_TEST_ENGINE podman or docker, default podman; SIMRA_TEST_CPUS for taskset). The designs run
// one after the other, as in reference.mjs. A skipped case is reported by the test runner as skipped: that check
// did not run.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { designs } from "../evals/comparator-synthesis/reference.mjs";
import { METRICS, verify } from "../evals/comparator-synthesis/synthesis.mjs";

const repo = new URL("../", import.meta.url).pathname;
const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
// The test image replaces the image of the task; the environment variables of the task stay.
const local = { environments: { eda: { engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image: process.env.SIMRA_TEST_IMAGE, cpus: process.env.SIMRA_TEST_CPUS } } };

/** The same value: within 1e-4 relative, or 1e-12 absolute for values near 0 (vol_rel, vos_v of the cheat). */
const same = (a, b) => Math.abs(a - b) <= Math.max(1e-4 * Math.abs(b), 1e-12);

for (const name of ["sg13cmos5l", "sky130"]) {
	test(`comparator-synthesis ${name}: the check gives the recorded results of the four reference designs (container)`, { skip, timeout: 2_400_000 }, async (t) => {
		const taskDir = join(repo, "evals/comparator-synthesis", name);
		const expected = JSON.parse(readFileSync(join(taskDir, "expected.json"), "utf8"));
		// The real path: on macOS, tmpdir() is under the /var link, which a container engine VM may not have.
		const work = mkdtempSync(join(realpathSync(tmpdir()), "simra-comparator-verify-"));
		t.after(() => rmSync(work, { recursive: true, force: true }));
		for (const [k, d] of Object.entries(designs(name))) {
			const { design, ...v } = await verify(taskDir, d, join(work, k), "eda", local);
			const e = expected[k];
			assert.equal(design.status, e.design_check.status, `${k}: design check ${JSON.stringify(design.errors)}`);
			assert.deepEqual(design.errors, e.design_check.errors, `${k}: design errors`);
			assert.deepEqual([design.area_um2, design.gate_area_um2, design.passive_area_um2, design.mos_count], [e.design_check.area_um2, e.design_check.gate_area_um2, e.design_check.passive_area_um2, e.design_check.mos_count], `${k}: areas and MOS count`);
			for (const [corner, c] of Object.entries(e.corners)) {
				assert.equal(v[corner].status, "completed", `${k} ${corner}: ${JSON.stringify(v[corner].errors)}`);
				assert.deepEqual(v[corner].points.map((p) => p.vcm), c.sweep.map((p) => p.vcm), `${k} ${corner}: the VCM points`);
				for (const m of METRICS) {
					const got = v[corner].worst[m];
					const want = c.worst[m];
					assert.ok(same(got.value, want.value), `${k} ${corner} ${m}: ${got.value}, recorded ${want.value}`);
					assert.ok(Math.abs(got.vcm - want.vcm) < 1e-6, `${k} ${corner} ${m}: at VCM ${got.vcm}, recorded ${want.vcm}`);
					assert.equal(got.pass, want.pass, `${k} ${corner} ${m}: pass`);
				}
			}
			const rowsPass = Object.values(v).every((c) => METRICS.every((m) => c.worst[m].pass));
			assert.deepEqual([rowsPass, design.status === "pass" && rowsPass], [e.rows_pass, e.meets_spec], `${k}: rows pass, meets the spec`);
		}
	});
}
