// End-to-end: kernel runner + ngspice adapter + real ngspice, on an RC filter with a known answer.
// "local" needs ngspice and python3 on PATH. "podman" runs only when SIMRA_TEST_PODMAN_IMAGE names an image
// that contains ngspice and python3 (optional: SIMRA_TEST_CPUS for taskset).
// A skipped case is reported by the test runner as skipped: that check did not run.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExperiment } from "@simra-tech/kernel";

const rcDeck = new URL("../packages/kernel/test/fixtures/rc/rc.spice", import.meta.url).pathname;
const has = (cmd) => {
	try {
		execFileSync(cmd, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};
const F3DB_HZ = 1 / (2 * Math.PI * 1e3 * 1e-6);

const environments = {
	local: { config: { kind: "local" }, skip: !(has("ngspice") && has("python3")) && "ngspice or python3 not on PATH" },
	podman: {
		config: { kind: "podman", image: process.env.SIMRA_TEST_PODMAN_IMAGE, cpus: process.env.SIMRA_TEST_CPUS, env: { HOME: "/tmp" } },
		skip: !process.env.SIMRA_TEST_PODMAN_IMAGE && "SIMRA_TEST_PODMAN_IMAGE is not set",
	},
};

for (const [name, { config, skip }] of Object.entries(environments)) {
	test(`ngspice RC known answer (${name})`, { skip, timeout: 120_000 }, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "simra-rc-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { [name]: config } }));
		copyFileSync(rcDeck, join(root, "rc.spice"));

		const { result, experiment } = await runExperiment({
			root,
			adapter: "ngspice",
			operation: "simulate",
			environment: name,
			inputs: { deck: "rc.spice", measurements: { f3db_hz: "Hz", gain_dc_db: "dB", not_there: null } },
		});

		assert.equal(result.status, "completed", JSON.stringify(result.errors.concat(result.diagnostics.map((d) => d.message))));
		assert.ok(Math.abs(result.measurements.f3db_hz.value / F3DB_HZ - 1) < 1e-3, `f3db = ${result.measurements.f3db_hz.value}`);
		assert.ok(Math.abs(result.measurements.gain_dc_db.value) < 0.01);
		assert.equal(result.measurements.not_there.status, "missing");
		assert.match(String(result.tool.version), /^\d+/);

		const deck = result.input_files.files.find((f) => f.role === "deck");
		assert.equal(deck.path, "rc.spice");
		assert.equal(deck.sha256, (await import("node:crypto")).createHash("sha256").update(readFileSync(join(root, "rc.spice"))).digest("hex"));
		assert.ok(result.outputs.some((f) => f.path.endsWith("work/ngspice.log")));
		if (name === "podman") assert.match(experiment.environment.image_id, /^sha256:[0-9a-f]{64}$/);
	});
}
