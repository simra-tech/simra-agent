// The xyce adapter on the model libraries of two PDKs in the environment image. The adapter has no PDK facts: the
// decks and the library paths are the caller's (this test). What the test shows:
// 1. ihp-sg13g2 (Xyce libraries of the kit): parse finds one model gap, the PSP 103 MOS card (Xyce rejects its
//    parameters), and fidelity warnings for the HBT card (safe-operating parameters that Xyce ignores). A one-point
//    HB of a common-emitter npn13G2 stage at 61 GHz converges.
// 2. sky130A (no Xyce library in the kit; the ngspice library is read by Xyce): parse finds no model gap, and a
//    fidelity warning that Xyce replaces BSIM4 version 4.5 by its oldest supported version.
// It runs only with SIMRA_TEST_IMAGE, an image with Xyce, python3 and both PDKs under /foss/pdks (optional:
// SIMRA_TEST_ENGINE, SIMRA_TEST_CPUS). A skipped case is reported as skipped: that check did not run.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExperiment } from "@simra-tech/kernel";

const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
const config = {
	kind: "container",
	engine: process.env.SIMRA_TEST_ENGINE ?? "podman",
	image: process.env.SIMRA_TEST_IMAGE,
	cpus: process.env.SIMRA_TEST_CPUS,
	env: { HOME: "/tmp", PDK_ROOT: "/foss/pdks" },
};

function setup(t, files) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-xyce-pdk-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { eda: config } }));
	for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
	return root;
}
const why = (r) => JSON.stringify(r.errors.concat(r.diagnostics.map((d) => d.message))).slice(0, 3000);
const IHP = "$PDK_ROOT/ihp-sg13g2/libs.tech/xyce/models";

test("xyce parse on ihp-sg13g2: the PSP MOS card is a gap, the HBT card parses (container)", { skip, timeout: 300_000 }, async (t) => {
	const root = setup(t, { "dev.cir": "* one MOS and one HBT\nxm1 d g 0 0 sg13_lv_nmos w=1u l=0.13u\nxq1 d g 0 0 npn13G2 Nx=1\nvd d 0 1\nvg g 0 0.8\n.op\n" });
	const { result } = await runExperiment({ root, adapter: "xyce", operation: "parse", environment: "eda", inputs: {
		deck: "dev.cir", libs: [{ path: `${IHP}/cornerMOSlv.lib`, section: "mos_tt" }, { path: `${IHP}/cornerHBT.lib`, section: "hbt_typ" }] } });
	assert.equal(result.status, "completed", why(result));
	assert.equal(result.measurements.model_gaps.value, 1, why(result));
	const gap = result.diagnostics.find((d) => d.message.startsWith("parameter unrecognized"));
	assert.ok(gap && /PSP103/i.test(gap.message) && gap.source.endsWith("sg13g2_moslv_mod.lib:74"), why(result));
	assert.ok(result.diagnostics.some((d) => d.message.startsWith("parameter ignored") && d.message.includes("VBE_MAX")), why(result));
	assert.ok(result.input_files.files.some((f) => f.role === "model" && f.path.endsWith("cornerHBT.lib")));
	t.diagnostic(`ihp-sg13g2: ${result.report.join(" | ")}`);
});

test("xyce hb on ihp-sg13g2: a one-point HB of an npn13G2 stage converges (container)", { skip, timeout: 300_000 }, async (t) => {
	const deck = `* npn13G2 common emitter at 61 GHz (ideal L, C, R)
vbias bb 0 0.88
lchoke bb b 1n
vin in 0 sin(0 0.05 61e9)
cin in b 100f
vcc vcc 0 1.5
lload vcc c 60p
rload vcc c 300
cout c out 100f
rout out 0 50
x1 c b 0 0 npn13G2 Nx=4
`;
	const root = setup(t, { "ce.cir": deck });
	const { result } = await runExperiment({ root, adapter: "xyce", operation: "hb", environment: "eda", inputs: {
		deck: "ce.cir", libs: [{ path: `${IHP}/cornerHBT.lib`, section: "hbt_typ" }], tones: [61e9], harmonics: 9, startup_periods: 4,
		ports: { out: { node: "out", r_ohm: 50 } }, dc_currents: ["vcc"] } });
	assert.equal(result.status, "completed", why(result));
	assert.ok(result.measurements.p_out_h1_dbm.value > -40, `${result.measurements.p_out_h1_dbm.value}`);
	assert.ok(result.measurements.i_vcc_a.value < 0, "the supply delivers current");
	t.diagnostic(`ihp-sg13g2 hb: P(h1) ${result.measurements.p_out_h1_dbm.value.toFixed(2)} dBm, I(vcc) ${result.measurements.i_vcc_a.value}`);
});

test("xyce parse on sky130A (ngspice library): no gap, BSIM4 version substituted (container)", { skip, timeout: 600_000 }, async (t) => {
	const root = setup(t, { "dev.cir": "* one 1.8 V NMOS\nxm1 d g 0 0 sky130_fd_pr__nfet_01v8 w=1 l=0.15\nvd d 0 1\nvg g 0 0.8\n.op\n" });
	const { result } = await runExperiment({ root, adapter: "xyce", operation: "parse", environment: "eda", inputs: {
		deck: "dev.cir", libs: [{ path: "$PDK_ROOT/sky130A/libs.tech/ngspice/sky130.lib.spice", section: "tt" }] } });
	assert.equal(result.status, "completed", why(result));
	assert.equal(result.measurements.model_gaps.value, 0, why(result));
	assert.ok(result.diagnostics.some((d) => d.message.startsWith("version substituted") && d.message.includes("BSIM4 version 4.5")), why(result));
	t.diagnostic(`sky130A: ${result.report.join(" | ")}`);
});
