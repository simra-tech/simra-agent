// The cross-simulator device check (xyce adapter, operation device_crosscheck) in the environment image.
// 1. A linear "device" with a known answer (a subcircuit of R and C, the same in both simulators): no finding, and the
//    y-parameters equal the analytic values. With another C in the Xyce library: a finding in y22.
// 2. The HBT npn13G2 of IHP SG13G2: with the default setting the ngspice model has the excess phase off (sw_nqs=0) and
//    the Xyce card has it on, so y21 at 122.5 GHz is a finding; with sw_nqs=1 for ngspice there is no finding.
// It runs only with SIMRA_TEST_IMAGE, an image with ngspice, Xyce, python3 and the IHP SG13G2 PDK under /foss/pdks
// (optional: SIMRA_TEST_ENGINE, SIMRA_TEST_CPUS). A skipped case is reported as skipped.

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExperiment } from "@simra-tech/kernel";

const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
const why = (r) => JSON.stringify({ status: r.status, errors: r.errors, diagnostics: r.diagnostics }, null, 1);

function setup(t, files = {}) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-xcheck-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = { PDK_ROOT: "/foss/pdks", PDK: "ihp-sg13g2", SPICE_USERINIT_DIR: "/foss/pdks/ihp-sg13g2/libs.tech/ngspice", HOME: "/tmp" };
	const config = { kind: "container", engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image: process.env.SIMRA_TEST_IMAGE, cpus: process.env.SIMRA_TEST_CPUS, env };
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { eda: config } }));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
	return root;
}

const cell = (c) => `* a linear two-port: g to the reference at port 1, r between the ports, c at port 2\n.subckt twoport a b\nr1 a 0 1k\nr2 a b 200\nc1 b 0 ${c}\n.ends\n`;

test("device_crosscheck: a linear device agrees in ngspice and Xyce; another C in one library is a finding (container)", { skip, timeout: 300_000 }, async (t) => {
	const root = setup(t, { "ng.lib": cell("100f"), "xy.lib": cell("100f"), "xy_other.lib": cell("150f") });
	const inputs = (xy) => ({ device: { cell: "twoport", pins: ["p1", "p2"] }, bias_v: [1, 0.5], freqs_hz: [1e9, 1e10], ngspice_libs: [{ path: "ng.lib" }], xyce_libs: [{ path: xy }] });
	const same = (await runExperiment({ root, adapter: "xyce", operation: "device_crosscheck", environment: "eda", inputs: inputs("xy.lib") })).result;
	assert.equal(same.status, "completed", why(same));
	assert.equal(same.measurements.findings.value, 0, why(same));
	assert.ok(same.measurements.y_rel_max.value < 1e-6 && same.measurements.dc_rel_max.value < 1e-6);
	const table = JSON.parse(readFileSync(join(root, same.outputs.find((f) => f.role === "device_crosscheck").path), "utf8"));
	const row = (q, f) => table.rows.find((x) => x.quantity === q && x.freq_hz === f);
	// I1 = 1 V / 1 kOhm + 0.5 V / 200 Ohm; y22 at 10 GHz = 1/200 + j w C
	assert.ok(Math.abs(row("I1", null).ngspice - 3.5e-3) < 1e-9 && Math.abs(row("I1", null).xyce - 3.5e-3) < 1e-9);
	const y22 = row("y22", 1e10);
	for (const side of ["ngspice", "xyce"]) assert.ok(Math.abs(y22[side][0] - 5e-3) < 1e-8 && Math.abs(y22[side][1] - 2 * Math.PI * 1e10 * 100e-15) < 1e-8, JSON.stringify(y22));

	const other = (await runExperiment({ root, adapter: "xyce", operation: "device_crosscheck", environment: "eda", inputs: inputs("xy_other.lib") })).result;
	assert.equal(other.status, "completed", why(other));
	assert.ok(other.measurements.findings.value >= 1);
	assert.ok(other.diagnostics.some((d) => d.severity === "warning" && /^finding: y22 at 10 GHz/.test(d.message)), why(other));
});

test("device_crosscheck: npn13G2 of ihp-sg13g2, the excess phase default is a finding, sw_nqs=1 agrees (container)", { skip, timeout: 600_000 }, async (t) => {
	const root = setup(t);
	const P = "$PDK_ROOT/ihp-sg13g2/libs.tech";
	const inputs = (extra) => ({
		device: { cell: "npn13G2", params: { Nx: 4 }, pins: ["p2", "p1", "0", "0"] }, bias_v: [0.88, 1.2], freqs_hz: [61e9, 122.5e9],
		ngspice_libs: [{ path: `${P}/ngspice/models/cornerHBT.lib`, section: "hbt_typ" }], xyce_libs: [{ path: `${P}/xyce/models/cornerHBT.lib`, section: "hbt_typ" }], ...extra });
	const dflt = (await runExperiment({ root, adapter: "xyce", operation: "device_crosscheck", environment: "eda", inputs: inputs({}) })).result;
	assert.equal(dflt.status, "completed", why(dflt));
	assert.ok(dflt.measurements.findings.value >= 1);
	assert.ok(dflt.measurements.dc_rel_max.value < 0.01, "the DC currents agree");
	assert.ok(dflt.measurements.y_rel_max.value > 0.08, `y difference ${dflt.measurements.y_rel_max.value}`);
	assert.ok(dflt.diagnostics.some((d) => /^finding: y21 at 122\.5 GHz/.test(d.message)), why(dflt));
	const nqs = (await runExperiment({ root, adapter: "xyce", operation: "device_crosscheck", environment: "eda", inputs: inputs({ ngspice_params: { sw_nqs: 1 } }) })).result;
	assert.equal(nqs.status, "completed", why(nqs));
	assert.equal(nqs.measurements.findings.value, 0, why(nqs));
	assert.ok(nqs.measurements.y_rel_max.value < 0.02);
});
