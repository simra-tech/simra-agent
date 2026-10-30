// End-to-end sweep: kernel runner + ngspice adapter + real ngspice, on an RC filter that sweeps its resistor and
// prints one ROW line per point. The input params replace the deck's C, and temp_c sets the temperature.
// Same environments and skip rules as ngspice.test.mjs. A skipped case is reported as skipped: that check did not run.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExperiment } from "@simra-tech/kernel";

const sweepDeck = new URL("../packages/kernel/test/fixtures/rc/rc-sweep.spice", import.meta.url).pathname;
const has = (cmd) => {
	try {
		execFileSync(cmd, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};
const f3db = (r) => 1 / (2 * Math.PI * r * 1e-6);

const environments = {
	local: { config: { kind: "local" }, skip: !(has("ngspice") && has("python3")) && "ngspice or python3 not on PATH" },
	container: {
		config: {
			kind: "container",
			engine: process.env.SIMRA_TEST_ENGINE ?? "podman",
			image: process.env.SIMRA_TEST_IMAGE,
			cpus: process.env.SIMRA_TEST_CPUS,
			env: { HOME: "/tmp" },
		},
		skip: !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set",
	},
};

for (const [name, { config, skip }] of Object.entries(environments)) {
	test(`ngspice RC sweep with params and temp_c (${name})`, { skip, timeout: 120_000 }, async (t) => {
		// The real path: on macOS, tmpdir() is under the /var link, which a container engine VM may not have.
		const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-rc-sweep-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { [name]: config } }));
		copyFileSync(sweepDeck, join(root, "rc-sweep.spice"));

		const { id, result } = await runExperiment({
			root,
			adapter: "ngspice",
			operation: "simulate",
			environment: name,
			inputs: { deck: "rc-sweep.spice", params: { cval: "1u" }, temp_c: 50, measurements: { f3db_hz: "Hz" } },
		});

		assert.equal(result.status, "completed", JSON.stringify(result.errors.concat(result.diagnostics.map((d) => d.message))));
		const { "f3db_hz.min": min, "f3db_hz.max": max } = result.measurements;
		assert.equal(min.status, "measured", JSON.stringify(result.measurements));
		assert.ok(Math.abs(min.value / f3db(4e3) - 1) < 1e-3, `f3db min = ${min.value}`);
		assert.ok(Math.abs(max.value / f3db(1e3) - 1) < 1e-3, `f3db max = ${max.value}`);
		assert.deepEqual([min.at, max.at, min.unit], [{ r: 4e3 }, { r: 1e3 }, "Hz"]);
		assert.equal(result.measurements.f3db_hz, undefined, "a wanted ROW column is not a missing scalar");

		const work = join(root, "simra", "experiments", id, "work");
		const table = JSON.parse(readFileSync(join(work, "sweep.json"), "utf8"));
		assert.deepEqual([table.sweep, table.columns, table.rows.map((r) => r.r)], ["r", ["f3db_hz"], [1e3, 2e3, 4e3]]);
		assert.ok(result.outputs.some((f) => f.path.endsWith("work/sweep.json")));
		// temp_c reached the simulator.
		assert.match(readFileSync(join(work, "ngspice.log"), "utf8"), /Doing analysis at TEMP = 50\.0/);
	});
}
