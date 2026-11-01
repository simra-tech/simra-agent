// Known answer of the ota-synthesis verification: the kernel check of requirements.json with the bench
// verify.spice gives the recorded results of expected.json (made by reference.mjs) for the four reference designs
// (the reference fix, the original, the cheat and the input load), on both PDKs: the status, the errors and the
// measurements of the design part, and the worst values. It runs only with SIMRA_TEST_IMAGE, an image with ngspice
// and both PDKs (optional: SIMRA_TEST_ENGINE podman or docker, default podman; SIMRA_TEST_CPUS for taskset).
// A skipped case is reported by the test runner as skipped: that check did not run. A second case checks a design
// that loads each input with a chain of 1 MΩ resistors: it fails iin_a and the area, but passes the old limit 100 nA.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { designs } from "../evals/ota-synthesis/reference.mjs";
import { METRICS, verify } from "../evals/ota-synthesis/synthesis.mjs";
import { passiveArea } from "./ota-bench-consistency.mjs";

const repo = new URL("../", import.meta.url).pathname;
const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
// The test image replaces the image of the task; the environment variables of the task stay.
const local = { environments: { eda: { engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image: process.env.SIMRA_TEST_IMAGE, cpus: process.env.SIMRA_TEST_CPUS } } };

/** The same value: within 1e-4 relative, or 1e-12 absolute for values near 0 (iin_a of a gate input or of the cheat). */
const same = (a, b) => Math.abs(a - b) <= Math.max(1e-4 * Math.abs(b), 1e-12);

for (const name of ["sg13cmos5l", "sky130"]) {
	test(`ota-synthesis ${name}: the check gives the recorded results of the four reference designs (container)`, { skip, timeout: 900_000 }, async (t) => {
		const taskDir = join(repo, "evals/ota-synthesis", name);
		const expected = JSON.parse(readFileSync(join(taskDir, "expected.json"), "utf8"));
		// The real path: on macOS, tmpdir() is under the /var link, which a container engine VM may not have.
		const work = mkdtempSync(join(realpathSync(tmpdir()), "simra-synthesis-verify-"));
		t.after(() => rmSync(work, { recursive: true, force: true }));
		const results = await Promise.all(Object.entries(designs(name)).map(async ([k, d]) => [k, await verify(taskDir, d, join(work, k), "eda", local)]));
		for (const [k, { design, ...v }] of results) {
			const e = expected[k];
			assert.equal(design.status, e.design_check.status, `${k}: design check ${JSON.stringify(design.errors)}`);
			assert.deepEqual(design.errors, e.design_check.errors, `${k}: design errors`);
			assert.deepEqual([design.area_um2, design.gate_area_um2, design.passive_area_um2, design.mos_count], [e.design_check.area_um2, e.design_check.gate_area_um2, e.design_check.passive_area_um2, e.design_check.mos_count], `${k}: areas and MOS count`);
			for (const [corner, c] of Object.entries(e.corners)) {
				assert.equal(v[corner].status, "completed", `${k} ${corner}: ${JSON.stringify(v[corner].errors)}`);
				assert.equal(v[corner].points.length, c.sweep.length, `${k} ${corner}: the number of sweep points`);
				for (const m of METRICS) {
					const got = v[corner].worst[m];
					const want = c.worst[m];
					assert.ok(same(got.value, want.value), `${k} ${corner} ${m}: ${got.value}, recorded ${want.value}`);
					assert.ok(Math.abs(got.vcm - want.vcm) < 1e-6, `${k} ${corner} ${m}: at VCM ${got.vcm}, recorded ${want.vcm}`);
					assert.equal(got.pass, want.pass, `${k} ${corner} ${m}: pass`);
				}
			}
			const rowsPass = Object.values(v).every((c) => METRICS.every((m) => c.worst[m].pass));
			assert.deepEqual([rowsPass, design.status === "pass" && rowsPass], [e.rows_pass, e.meets_spec], `${k}: rows pass, meets the spec`);
		}
	});
}

/**
 * The reference fix with a chain of n resistors of 1 MΩ from inp to vss and from inn to vss. Each resistor obeys the
 * per-element limit. The chain is long enough that iin_a is below the old limit 100 nA at the top of the VCM range.
 */
function resistorChains(text, n) {
	const chain = (pin) => Array.from({ length: n }, (_, i) => `R${pin}${i} ${i ? `${pin}${i}` : pin} ${i === n - 1 ? "vss" : `${pin}${i + 1}`} 1meg`);
	const lines = text.split("\n");
	const at = lines.findIndex((l) => /^\.subckt\s/i.test(l)) + 1;
	return [...lines.slice(0, at), ...chain("inp"), ...chain("inn"), ...lines.slice(at)].join("\n");
}

const CHAINS = { sg13cmos5l: { technology: "ihp-sg13", pdk: "ihp-sg13cmos5l", n: 8 }, sky130: { technology: "sky130", pdk: "sky130A", n: 16 } };

for (const [name, facts] of Object.entries(CHAINS)) {
	test(`ota-synthesis ${name}: 1 MΩ chains on the inputs fail iin_a and the area (container)`, { skip, timeout: 900_000 }, async (t) => {
		const taskDir = join(repo, "evals/ota-synthesis", name);
		const expected = JSON.parse(readFileSync(join(taskDir, "expected.json"), "utf8"));
		const work = mkdtempSync(join(realpathSync(tmpdir()), "simra-synthesis-chain-"));
		t.after(() => rmSync(work, { recursive: true, force: true }));
		const text = resistorChains(designs(name).fix, facts.n);
		const { design, ...v } = await verify(taskDir, text, work, "eda", local);
		// The area: the fix plus 2 × n MΩ. It is above the limit, so the area row fails. The netlist has no errors.
		const fix = expected.fix.design_check;
		const passive = fix.passive_area_um2 + passiveArea(facts.technology, facts.pdk, { r: Array(2 * facts.n).fill(1e6) });
		assert.equal(design.status, "fail");
		assert.ok(Math.abs(design.passive_area_um2 - passive) < 1e-3, `R and C area ${design.passive_area_um2}, from the pack ${passive}`);
		assert.deepEqual([design.gate_area_um2, design.mos_count], [fix.gate_area_um2, fix.mos_count]);
		assert.ok(design.area_um2 > expected.spec.design.area_um2, `area ${design.area_um2}`);
		assert.deepEqual(design.errors, []);
		// iin_a: VCM / (n MΩ) on each input. It fails at each corner by a factor of more than 10, below 100 nA.
		for (const [corner, c] of Object.entries(v)) {
			const w = c.worst.iin_a;
			assert.equal(c.status, "completed", `${corner}: ${JSON.stringify(c.errors)}`);
			assert.equal(w.pass, false, `${corner}: iin_a ${w.value}`);
			assert.ok(w.value > 10 * expected.input_current.limit && w.value < 1e-7, `${corner}: iin_a ${w.value}`);
			assert.ok(Math.abs(w.value / (w.vcm / (facts.n * 1e6)) - 1) < 0.01, `${corner}: iin_a ${w.value} at VCM ${w.vcm}`);
		}
	});
}
