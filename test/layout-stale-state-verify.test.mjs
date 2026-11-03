// Known answer of the layout-stale-state task in the container: on each PDK, the generator makes the four variants
// (v1-seeded, v2-seeded, v2-clean, v1-clean) with the recorded hashes of expected.json; the verification (the
// wrappers drc.sh and lvs.sh with the stock decks) gives the recorded marker counts per rule and the recorded LVS
// status and pins; the kept check gives the recorded result for each variant; the roles of the variants hold.
// It runs only with SIMRA_TEST_IMAGE, an image with KLayout and both PDKs (optional: SIMRA_TEST_ENGINE podman or
// docker, default podman; SIMRA_TEST_CPUS for taskset). A skipped case is reported by the test runner as skipped:
// that check did not run.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTask } from "../evals/layout-drc-fix/layout.mjs";
import { checkRoles, PDKS, reference } from "../evals/layout-stale-state/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
// The test image replaces the image of the task; the environment variables of the task stay.
const local = { environments: { eda: { engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image: process.env.SIMRA_TEST_IMAGE, cpus: process.env.SIMRA_TEST_CPUS } } };

for (const pdk of PDKS) {
	test(`layout stale-state ${pdk}: the generator, the verification and the kept check give the recorded results (container)`, { skip, timeout: 1_800_000 }, async (t) => {
		const taskDir = join(repo, "evals/layout-stale-state", pdk);
		const { spec, expected } = loadTask(taskDir);
		const block = loadTask(join(repo, "evals/layout-block-fix", pdk)).expected;
		// The real path: on macOS, tmpdir() is under the /var link, which a container engine VM may not have.
		const work = mkdtempSync(join(realpathSync(tmpdir()), "simra-layout-stale-verify-"));
		t.after(() => rmSync(work, { recursive: true, force: true }));
		const ref = await reference(pdk, work, local);
		assert.deepEqual(checkRoles(pdk, ref, block, spec.pins), []);
		assert.deepEqual(ref.info.change, expected.change, `${pdk}: the change`);
		for (const [v, r] of Object.entries(ref.variants)) {
			const e = expected.variants[v];
			assert.equal(r.sha256, e.sha256, `${pdk} ${v}: the GDS hash`);
			assert.deepEqual([r.drc.status, r.drc.markers, r.drc.rules, r.drc.exit], [e.drc.status, e.drc.markers, e.drc.rules, e.drc.exit], `${pdk} ${v}: DRC`);
			assert.deepEqual([r.lvs.status, r.lvs.status_text, r.lvs.pins, r.lvs.exit], [e.lvs.status, e.lvs.status_text, e.lvs.pins, e.lvs.exit], `${pdk} ${v}: LVS`);
			assert.deepEqual([r.kept.kept, r.kept.xor_area_um2], [e.kept.kept, e.kept.xor_area_um2], `${pdk} ${v}: kept`);
		}
	});
}
