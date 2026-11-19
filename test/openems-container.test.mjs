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

// Reference-plane shift (de-embedding) on real EM data: the 600 um line with 150 um removed at each port must equal
// the 300 um line (same port discontinuities). eps_eff and the loss come from the two runs (the phase and the
// magnitude of S21 per um of length difference, averaged over the band). The shift uses one loss in dB/mm, but the
// loss of the line rises with frequency: the magnitude limit is 0.3 mm x the largest deviation of the loss per point
// from the band average, plus 0.01 dB.
test("openEMS: the 600 um line with 150 um removed at each port equals the 300 um line (container)", { skip, timeout: 2_400_000 }, async (t) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-em-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	copyFileSync(gds, join(root, "line.gds"));
	copyFileSync(new URL("../adapters/openems/fixtures/line600.gds", import.meta.url).pathname, join(root, "line600.gds"));
	const env = { PDK_ROOT: "/foss/pdks", PDK: "ihp-sg13g2", HOME: "/tmp" };
	const config = { kind: "container", engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image: process.env.SIMRA_TEST_IMAGE, env };
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { eda: config } }));
	const base = (file, length) => ({
		gds: file,
		stackup: "$PDK_ROOT/ihp-sg13g2/libs.tech/openems/openems_ihp_sg13g2/workflow/SG13G2_200um.xml",
		band_hz: [5e9, 60e9],
		points: 12,
		ports: [
			{ name: "in", x: 0, y: 0, from: "Metal1", to: "TopMetal2" },
			{ name: "out", x: length, y: 0, from: "Metal1", to: "TopMetal2" },
		],
		max_timesteps: 120000,
	});
	const run = async (inputs) => {
		const out = await emSParameters({ root, inputs, environment: "eda", cpus: process.env.SIMRA_TEST_CPUS, parallel: 2, timeoutS: 1800 });
		assert.deepEqual(out.problems, []);
		return readFileSync(join(root, out.touchstone), "utf8").split("\n").filter((l) => l.trim() && !/^[!#]/.test(l)).map((l) => l.trim().split(/\s+/).map(Number));
	};
	const s300 = await run(base("line.gds", 300));
	const s600 = await run(base("line600.gds", 600));
	// beta and alpha per um from S21(600) / S21(300)
	const c0 = 299792458;
	let eps = 0;
	let loss = 0;
	const lossAt = [];
	for (const [k, r] of s300.entries()) {
		const q = s600[k];
		const ratio = { re: (q[3] * r[3] + q[4] * r[4]) / (r[3] ** 2 + r[4] ** 2), im: (q[4] * r[3] - q[3] * r[4]) / (r[3] ** 2 + r[4] ** 2) };
		const dphi = -Math.atan2(ratio.im, ratio.re); // beta * 300 um, below pi in this band
		eps += ((dphi * c0) / (2 * Math.PI * r[0] * 300e-6)) ** 2 / s300.length;
		lossAt.push((-20 * Math.log10(Math.hypot(ratio.re, ratio.im))) / 0.3);
		loss += lossAt.at(-1) / s300.length;
	}
	const limitDb = 0.3 * Math.max(...lossAt.map((l) => Math.abs(l - loss))) + 0.01;
	t.diagnostic(`extracted eps_eff ${eps.toFixed(3)}, loss ${loss.toFixed(3)} dB/mm (${Math.min(...lossAt).toFixed(3)} to ${Math.max(...lossAt).toFixed(3)}); limit ${limitDb.toFixed(4)} dB`);
	assert.ok(eps > 2 && eps < 8, `eps_eff ${eps}`);
	const de = await run({ ...base("line600.gds", 600), deembed: [1, 2].map((port) => ({ port, length_um: 150, eps_eff: eps, loss_db_per_mm: Math.max(loss, 0) })) });
	let worstDb = 0;
	let worstDeg = 0;
	for (const [k, r] of s300.entries()) {
		const q = de[k];
		const db = 20 * Math.log10(Math.hypot(q[3], q[4]) / Math.hypot(r[3], r[4]));
		let deg = ((Math.atan2(q[4], q[3]) - Math.atan2(r[4], r[3])) * 180) / Math.PI;
		deg = ((deg + 540) % 360) - 180;
		worstDb = Math.max(worstDb, Math.abs(db));
		worstDeg = Math.max(worstDeg, Math.abs(deg));
	}
	t.diagnostic(`de-embedded 600 um line vs 300 um line, S21: max ${worstDb.toFixed(4)} dB, ${worstDeg.toFixed(3)} deg`);
	assert.ok(worstDb < limitDb, `S21 magnitude difference ${worstDb} dB, limit ${limitDb} dB`);
	assert.ok(worstDeg < 1.0, `S21 phase difference ${worstDeg} deg`);
});
