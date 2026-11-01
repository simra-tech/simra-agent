// Known answer of a target from an arm run (evals/synthesis-family.mjs): the kernel check of requirements.json with
// the bench of the base task gives the recorded worst values, the gate area and the design check of target.json.
// A target from the reference is checked by the known-answer test of its task. It runs only with SIMRA_TEST_IMAGE,
// an image with ngspice and both PDKs (optional: SIMRA_TEST_ENGINE podman or docker, default podman;
// SIMRA_TEST_CPUS for taskset). A skipped case is reported by the test runner as skipped: that check did not run.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verify } from "../evals/ota-synthesis/synthesis.mjs";

const repo = new URL("../", import.meta.url).pathname;
const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
// The test image replaces the image of the task; the environment variables of the task stay.
const local = { environments: { eda: { engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image: process.env.SIMRA_TEST_IMAGE, cpus: process.env.SIMRA_TEST_CPUS } } };

/** The same value: within 1e-4 relative, or 1e-12 absolute for values near 0 (the tolerance of the base known-answer tests). */
const same = (a, b) => Math.abs(a - b) <= Math.max(1e-4 * Math.abs(b), 1e-12);

const targets = ["ota-synthesis", "comparator-synthesis"].flatMap((task) =>
	["sg13cmos5l", "sky130"].map((pdk) => ({ task, pdk, dir: join(repo, "evals", task, pdk) })).filter(({ dir }) => existsSync(join(dir, "target.json"))),
);
const runs = targets.filter(({ dir }) => JSON.parse(readFileSync(join(dir, "target.json"), "utf8")).source.kind === "run");

test("synthesis targets: at least one target is from an arm run", () => assert.ok(runs.length >= 1));

for (const { task, pdk, dir } of runs) {
	test(`synthesis target ${task} ${pdk}: the design of the run gives the recorded results (container)`, { skip, timeout: 2_400_000 }, async (t) => {
		const target = JSON.parse(readFileSync(join(dir, "target.json"), "utf8"));
		// The real path: on macOS, tmpdir() is under the /var link, which a container engine VM may not have.
		const work = mkdtempSync(join(realpathSync(tmpdir()), "simra-target-verify-"));
		t.after(() => rmSync(work, { recursive: true, force: true }));
		const { design, ...v } = await verify(dir, target.design, join(work, "target"), "eda", local);
		const r = target.result;
		assert.equal(design.status, r.design_check.status, `design check ${JSON.stringify(design.errors)}`);
		assert.deepEqual(design.errors, r.design_check.errors);
		assert.deepEqual([design.area_um2, design.gate_area_um2, design.passive_area_um2, design.mos_count], [r.design_check.area_um2, r.design_check.gate_area_um2, r.design_check.passive_area_um2, r.design_check.mos_count], "areas and MOS count");
		for (const [corner, c] of Object.entries(r.corners)) {
			assert.equal(v[corner].status, "completed", `${corner}: ${JSON.stringify(v[corner].errors)}`);
			assert.deepEqual(v[corner].points.map((p) => p.vcm), c.sweep.map((p) => p.vcm), `${corner}: the VCM points`);
			for (const [m, want] of Object.entries(c.worst)) {
				const got = v[corner].worst[m];
				assert.ok(same(got.value, want.value), `${corner} ${m}: ${got.value}, recorded ${want.value}`);
				assert.ok(Math.abs(got.vcm - want.vcm) < 1e-6, `${corner} ${m}: at VCM ${got.vcm}, recorded ${want.vcm}`);
				assert.equal(got.pass, want.pass, `${corner} ${m}: pass`);
			}
		}
	});
}
