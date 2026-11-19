// The device-class probe on the IHP SG13G2 pack, in ngspice and Xyce, in the environment image: the table
// "class x simulator: simulates / parses / fails" must equal the stored table test/fixtures/device-probe/ihp-sg13g2.json
// (status, reason, gaps; the probe currents within 1e-6 relative). With SIMRA_UPDATE_FIXTURE=1 the test writes the
// fixture from this run. It runs only with SIMRA_TEST_IMAGE, an image with ngspice, Xyce, python3 and the IHP SG13G2 PDK
// under /foss/pdks (optional: SIMRA_TEST_ENGINE, SIMRA_TEST_CPUS). A skipped case is reported as skipped.

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeDevices } from "@simra-tech/kernel";
import { normalizeProbe } from "./device-probe-normalize.mjs";

const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
const fixture = new URL("./fixtures/device-probe/ihp-sg13g2.json", import.meta.url).pathname;

test("device-class probe of ihp-sg13g2 in ngspice and Xyce equals the stored table (container)", { skip, timeout: 1_200_000 }, async (t) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-probe-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = { PDK_ROOT: "/foss/pdks", PDK: "ihp-sg13g2", SPICE_USERINIT_DIR: "/foss/pdks/ihp-sg13g2/libs.tech/ngspice", HOME: "/tmp" };
	const config = { kind: "container", engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image: process.env.SIMRA_TEST_IMAGE, env };
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { eda: config } }));
	const { table, jobs, text } = await probeDevices({ root, pdk: "ihp-sg13g2", environment: "eda", cpus: process.env.SIMRA_TEST_CPUS });
	t.diagnostic(text.split("\n").slice(0, 25).join(" | "));
	assert.deepEqual(jobs.map((j) => j.status), ["completed", "completed"]);
	const got = normalizeProbe(table);
	if (process.env.SIMRA_UPDATE_FIXTURE === "1") writeFileSync(fixture, `${JSON.stringify(got, null, 2)}\n`);
	const want = JSON.parse(readFileSync(fixture, "utf8"));
	assert.deepEqual(Object.keys(got.classes), Object.keys(want.classes));
	assert.deepEqual(got.simulators, want.simulators);
	for (const [name, cells] of Object.entries(want.classes)) {
		for (const [sim, cell] of Object.entries(cells)) {
			const g = got.classes[name][sim];
			assert.deepEqual([g.status, g.reason, g.gaps ?? []], [cell.status, cell.reason, cell.gaps ?? []], `${name} / ${sim}`);
			if (cell.value_a !== null) assert.ok(Math.abs(g.value_a - cell.value_a) <= 1e-6 * Math.abs(cell.value_a) + 1e-18, `${name} / ${sim}: ${g.value_a} vs ${cell.value_a}`);
		}
	}
});
