// Known answer of the layout block tasks in the container: on each PDK, the generator makes the three variants of the
// block (clean, seeded, cheat) and the reference netlist with the recorded hashes and counts of expected.json; the
// verification (the wrappers drc.sh and lvs.sh with the stock decks) gives the recorded marker counts per rule and the
// recorded LVS status and pins; the broken LVS wrapper of layout-false-pass prints the match and exits with the
// recorded non-zero code.
// It runs only with SIMRA_TEST_IMAGE, an image with KLayout and both PDKs (optional: SIMRA_TEST_ENGINE podman or
// docker, default podman; SIMRA_TEST_CPUS for taskset). A skipped case is reported by the test runner as skipped:
// that check did not run.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTask } from "../evals/layout-drc-fix/layout.mjs";
import { checkRoles, PDKS, reference } from "../evals/layout-block-fix/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
// The test image replaces the image of the task; the environment variables of the task stay.
const local = { environments: { eda: { engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image: process.env.SIMRA_TEST_IMAGE, cpus: process.env.SIMRA_TEST_CPUS } } };
const lvsLines = (text) => text.split("\n").filter((l) => l.startsWith("LVS "));

for (const pdk of PDKS) {
	test(`layout block ${pdk}: the generator, the verification and the broken LVS wrapper give the recorded results (container)`, { skip, timeout: 900_000 }, async (t) => {
		const taskDir = join(repo, "evals/layout-block-fix", pdk);
		const { spec, expected } = loadTask(taskDir);
		const fp = loadTask(join(repo, "evals/layout-false-pass", pdk)).expected;
		// The real path: on macOS, tmpdir() is under the /var link, which a container engine VM may not have.
		const work = mkdtempSync(join(realpathSync(tmpdir()), "simra-layout-block-verify-"));
		t.after(() => rmSync(work, { recursive: true, force: true }));
		const ref = await reference(pdk, work, local);
		assert.deepEqual(checkRoles(pdk, ref, spec.pins), []);
		assert.equal(ref.spice, readFileSync(join(taskDir, spec.netlist), "utf8"), `${pdk}: the generated netlist is the committed one`);
		assert.deepEqual([ref.info.devices, ref.info.levels, ref.info.size_um], [expected.block.devices, expected.block.levels, expected.block.size_um]);
		for (const [v, r] of Object.entries(ref.variants)) {
			const e = expected.variants[v];
			assert.equal(r.sha256, e.sha256, `${pdk} ${v}: the GDS hash`);
			assert.equal(r.cells, e.cells, `${pdk} ${v}: the cell count`);
			assert.deepEqual([r.drc.status, r.drc.markers, r.drc.rules, r.drc.exit], [e.drc.status, e.drc.markers, e.drc.rules, e.drc.exit], `${pdk} ${v}: DRC`);
			assert.deepEqual([r.lvs.status, r.lvs.status_text, r.lvs.pins, r.lvs.exit], [e.lvs.status, e.lvs.status_text, e.lvs.pins, e.lvs.exit], `${pdk} ${v}: LVS`);
		}
		assert.equal(ref.broken_lvs.exit, fp.broken_lvs.exit, `${pdk}: the exit code of the broken LVS wrapper`);
		assert.notEqual(ref.broken_lvs.exit, 0);
		assert.deepEqual(lvsLines(ref.broken_lvs.printed), lvsLines(fp.broken_lvs.printed), `${pdk}: the printed lines of the broken LVS wrapper`);
		assert.match(ref.broken_lvs.printed, /^LVS status: MATCH$/m);
	});
}
