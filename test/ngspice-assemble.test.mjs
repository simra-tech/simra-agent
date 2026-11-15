// End-to-end assemble_dc: kernel runner + ngspice adapter + real ngspice, on a deck with two blocks: a latch with two
// stable states and a resistive divider. The seed of the latch (a block-alone point, with its testbench names mapped
// to the deck names) selects the state; the wrong seed of the divider is corrected by the free operating point.
// Same environments and skip rules as ngspice.test.mjs. A skipped case is reported as skipped: that check did not run.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExperiment } from "@simra-tech/kernel";

const fixtures = new URL("../packages/kernel/test/fixtures/assemble/", import.meta.url).pathname;
const has = (cmd) => {
	try {
		execFileSync(cmd, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

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
	test(`ngspice assemble_dc: the seed selects the latch state, the free op corrects a wrong seed (${name})`, { skip, timeout: 180_000 }, async (t) => {
		const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-assemble-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { [name]: config } }));
		cpSync(fixtures, root, { recursive: true });
		const node = (result, key) => JSON.parse(readFileSync(join(root, "simra/experiments", result.id, "work/dc_point.json"), "utf8")).nodes[key];
		for (const [file, high] of [["latch_one.json", "xl.a"], ["latch_zero.json", "xl.b"]]) {
			const { id, result } = await runExperiment({
				root,
				adapter: "ngspice",
				operation: "assemble_dc",
				environment: name,
				inputs: {
					deck: "chip.spice",
					seeds: [{ file, from_prefix: "x1.", to_prefix: "xl." }, { file: "div_wrong.json" }],
					phases: [["xl."]],
					steps: 20,
					currents: ["vdd"],
				},
			});
			assert.equal(result.status, "completed", JSON.stringify(result.errors.concat(result.diagnostics.map((d) => d.message))));
			const m = result.measurements;
			assert.deepEqual([m.nodes_seeded.value, m.clamp_reached_end.value, m.free_op_converged.value, m.seeds_not_in_circuit.value], [3, 1, 1, 0]);
			assert.equal(m.clamp_points_done.value, 41);
			const r = { id };
			const low = high === "xl.a" ? "xl.b" : "xl.a";
			assert.ok(node(r, `v(${high})`) > 0.9 && node(r, `v(${low})`) < 0.1, `${file}: ${high} high`);
			assert.ok(Math.abs(node(r, "v(m)") - 0.6) < 1e-6, "the free op corrects the wrong divider seed");
			assert.ok(Math.abs(m.i_vdd_a.value + 6e-5) < 1e-9, `i(vdd) = ${m.i_vdd_a.value}`);
			assert.ok(m.free_op_max_dv_v.value < 1e-3, `max change ${m.free_op_max_dv_v.value}`);
		}
	});
}
