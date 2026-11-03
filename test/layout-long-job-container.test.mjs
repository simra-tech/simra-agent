// Container tests of the layout-long-job task (the flat block), for both PDKs:
// 1. the generator gives the recorded SHA-256 of the three variants (clean, seeded and cheat);
// 2. the wrappers drc.sh and lvs.sh on the seeded block give the recorded marker count, the count of each rule, the
//    LVS status and the pins;
// 3. the klayout adapter (drc with the default rule set, and lvs) gives the counts and the status of the wrappers;
// 4. the runtimes of the wrappers meet the target of expected.json (the longer deck takes at least 3 minutes, and two
//    DRC runs and one LVS run take at most 12 minutes), with a margin. If the reference run on an idle host missed
//    the target (in_target false), the runtimes must stay near the recorded runtimes. Runtimes are valid only on an
//    idle host: if the 1-min load average is IDLE_LOAD or more, this check does not run (it is skipped).
// It runs only with SIMRA_TEST_IMAGE, an image with KLayout and both PDKs (optional: SIMRA_TEST_ENGINE podman or
// docker, default podman). A skipped case is reported by the test runner as skipped: that check did not run.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PDKS, VARIANTS } from "../evals/layout-block-fix/reference.mjs";
import { loadTask, runContainer, sha256, taskEnvironment, verify } from "../evals/layout-drc-fix/layout.mjs";
import { adapterRun, checkAdapter, designRoot, IDLE_LOAD, RUNTIME_TARGET_S, runtimeRecord } from "../evals/layout-long-job/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
const engine = process.env.SIMRA_TEST_ENGINE ?? "podman";
const local = { environments: { eda: { engine, image: process.env.SIMRA_TEST_IMAGE } } };
const load1 = () => Math.round(loadavg()[0] * 100) / 100;

/** The margin of the runtime check: a runtime may miss the target by this factor. */
const MARGIN = 1.25;

for (const pdk of PDKS) {
	test(`layout-long-job ${pdk}: hashes, counts, status, adapter and runtimes (container)`, { skip, timeout: 3_600_000 }, async (t) => {
		const taskDir = join(repo, "evals/layout-long-job", pdk);
		const { task, spec, expected } = loadTask(taskDir);
		const work = mkdtempSync(join(realpathSync(tmpdir()), `simra-layout-long-job-${pdk}-`));
		t.after(() => rmSync(work, { recursive: true, force: true }));
		const loadStart = load1();
		// 1. The three variants and the netlist.
		writeFileSync(join(work, "simra.local.json"), JSON.stringify(local));
		copyFileSync(resolve(taskDir, task.files["simra.config.json"]), join(work, "simra.config.json"));
		const env = taskEnvironment(work, { environment: "eda" });
		const g = `python3 ${join(taskDir, "generate.py")}`;
		const script = [...VARIANTS.map((v) => `${g} --variant ${v} --out ${join(work, `${v}.gds`)} > /dev/null`), `${g} --spice --out ${join(work, "block.spice")}`].join(" && ");
		const r = await runContainer({ ...env, env: { ...env.env, PYTHONDONTWRITEBYTECODE: "1" } }, work, script, { [join(repo, "evals")]: join(repo, "evals") });
		assert.equal(r.code, 0, `the generator failed: ${r.stderr}`);
		for (const v of VARIANTS) assert.equal(sha256(join(work, `${v}.gds`)), expected.variants[v].sha256, `${pdk} ${v}: the SHA-256`);
		// 2. The wrappers on the seeded block.
		const res = await verify(taskDir, join(work, "seeded.gds"), join(work, "verify"), local, { [spec.netlist]: join(work, "block.spice") });
		assert.deepEqual(res.errors, []);
		const e = expected.variants.seeded;
		assert.deepEqual([res.drc.status, res.drc.markers, res.drc.rules], [e.drc.status, e.drc.markers, e.drc.rules], `${pdk}: the DRC of the seeded block`);
		assert.equal(res.lvs.status, "match");
		assert.deepEqual([...res.lvs.pins].sort(), [...spec.pins].sort());
		t.diagnostic(`${pdk} wrappers (seeded): DRC ${res.drc.markers} markers in ${Object.keys(res.drc.rules).length} rules, ${res.drc.runtime_s} s; LVS ${res.lvs.status}, ${res.lvs.runtime_s} s`);
		// 3. The adapter on the seeded block.
		const a = await adapterRun(designRoot(taskDir, work, "adapter", join(work, "seeded.gds"), join(work, "block.spice"), local), spec);
		assert.deepEqual(checkAdapter(a, res), []);
		t.diagnostic(`${pdk} adapter (seeded): DRC ${a.drc.markers} markers, ${a.drc.runtime_s} s; LVS ${a.lvs.status}, ${a.lvs.runtime_s} s`);
		// 4. The runtimes, on an idle host only.
		const loadEnd = load1();
		const idle = Math.max(loadStart, loadEnd) < IDLE_LOAD;
		t.diagnostic(`${pdk}: host load ${loadStart} at the start, ${loadEnd} at the end`);
		await t.test(`${pdk}: the runtimes of the wrappers`, { skip: !idle && `not run: the host load was ${loadStart} to ${loadEnd}, not under ${IDLE_LOAD}` }, () => {
			const now = runtimeRecord([{ drc: res.drc.runtime_s, lvs: res.lvs.runtime_s }], RUNTIME_TARGET_S, MARGIN);
			const rec = expected.runtimes;
			t.diagnostic(`${pdk}: longer deck ${now.long_deck_s} s, eval deck time ${now.eval_deck_s} s; recorded ${rec.long_deck_s} s and ${rec.eval_deck_s} s, ${rec.measured}`);
			if (rec.in_target || !expected.host_load_1min.idle) {
				// The target, with the margin. (A reference run under load gives no runtimes to compare with.)
				assert.ok(now.in_target, `${pdk}: the target ${JSON.stringify(RUNTIME_TARGET_S)} with the margin ${MARGIN} is not met`);
			} else {
				// The reference run on an idle host missed the target: stay near the recorded runtimes.
				for (const c of ["drc", "lvs"]) {
					const s = res[c].runtime_s;
					assert.ok(s >= rec[c].min / 2 && s <= rec[c].max * 2, `${pdk} ${c}: ${s} s, recorded ${rec[c].min} to ${rec[c].max} s (target not met)`);
				}
			}
		});
	});
}
