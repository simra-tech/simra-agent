// openEMS adapter in the environment image: one real EM run of a short line (adapters/openems/fixtures/line.gds: a
// TopMetal2 line, 300 um x 18 um, over a Metal1 ground) on the IHP SG13G2 stackup of the PDK, with a coarse mesh.
// simra em runs one simulate job per port (2 jobs on the CPU pool) and the merge to a Touchstone file. The test checks
// convergence (end criterion reached in each port run), the band, and the expected physics of a short low-loss line:
// |S21| near 0 dB, |S11| low, S21 = S12. It runs only with SIMRA_TEST_IMAGE, an image with python3, CSXCAD, openEMS,
// gdstk and the IHP SG13G2 PDK under /foss/pdks (optional: SIMRA_TEST_ENGINE, SIMRA_TEST_CPUS). A skipped case is
// reported as skipped.

import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { emSParameters } from "@simra-tech/kernel";

const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
const gds = new URL("../adapters/openems/fixtures/line.gds", import.meta.url).pathname;

test("openEMS: a short TopMetal2 line on the IHP SG13G2 stackup gives a converged 2-port Touchstone file (container)", { skip, timeout: 2_400_000 }, async (t) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-em-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	copyFileSync(gds, join(root, "line.gds"));
	const env = { PDK_ROOT: "/foss/pdks", PDK: "ihp-sg13g2", HOME: "/tmp" };
	const config = { kind: "container", engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image: process.env.SIMRA_TEST_IMAGE, env };
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { eda: config } }));
	const inputs = {
		gds: "line.gds",
		stackup: "$PDK_ROOT/ihp-sg13g2/libs.tech/openems/openems_ihp_sg13g2/workflow/SG13G2_200um.xml",
		band_hz: [1e9, 60e9],
		points: 60,
		ports: [
			{ name: "in", x: 0, y: 0, from: "Metal1", to: "TopMetal2" },
			{ name: "out", x: 300, y: 0, from: "Metal1", to: "TopMetal2" },
		],
		max_timesteps: 60000,
	};
	const out = await emSParameters({ root, inputs, environment: "eda", cpus: process.env.SIMRA_TEST_CPUS, parallel: 2, timeoutS: 1200 });
	t.diagnostic(out.text.split("\n").join(" | "));
	assert.deepEqual(out.problems, []);
	for (const job of out.ports.jobs) {
		const result = JSON.parse(readFileSync(join(root, "simra/experiments", job.id, "result.json"), "utf8"));
		const k = job.index + 1;
		assert.equal(result.measurements[`end_criteria_reached_p${k}`].value, 1, `port ${k} converged`);
		assert.ok(result.measurements[`energy_end_db_p${k}`].value <= -40, `port ${k} energy`);
		t.diagnostic(`port ${k}: ${(result.report ?? []).join("; ")}`);
	}
	const rows = readFileSync(join(root, out.touchstone), "utf8").split("\n").filter((l) => l.trim() && !/^[!#]/.test(l)).map((l) => l.trim().split(/\s+/).map(Number));
	assert.equal(rows.length, 60);
	assert.equal(rows[0][0], 1e9);
	const db = (re, im) => 10 * Math.log10(re * re + im * im);
	for (const r of rows) {
		const [s11, s21, s12] = [db(r[1], r[2]), db(r[3], r[4]), db(r[5], r[6])];
		assert.ok(s21 < 0.01 && s21 > -0.5, `|S21| ${s21.toFixed(3)} dB at ${r[0]} Hz`);
		assert.ok(s11 < -20, `|S11| ${s11.toFixed(2)} dB at ${r[0]} Hz`);
		assert.ok(Math.abs(s21 - s12) < 0.05, `S21 ${s21.toFixed(3)} vs S12 ${s12.toFixed(3)} dB at ${r[0]} Hz`);
	}
	const last = rows.at(-1);
	t.diagnostic(`60 GHz: S11 ${db(last[1], last[2]).toFixed(2)} dB, S21 ${db(last[3], last[4]).toFixed(3)} dB`);
});
