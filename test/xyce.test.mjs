// End-to-end: kernel runner + xyce adapter + real Xyce, on PDK-free decks with known answers.
// "local" needs Xyce and python3 on PATH. "container" runs only when SIMRA_TEST_IMAGE names an image with Xyce and
// python3 (optional: SIMRA_TEST_ENGINE, SIMRA_TEST_CPUS). A skipped case is reported as skipped: that check did not run.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExperiment } from "@simra-tech/kernel";

const works = (cmd, args) => {
	try {
		execFileSync(cmd, args, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

const environments = {
	local: { config: { kind: "local" }, skip: !(works("Xyce", ["-v"]) && works("python3", ["--version"])) && "Xyce or python3 not on PATH" },
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

const RC = `* RC low-pass; R has a temperature coefficient
.param rval=1k
r1 in out {rval} tc1=0.002
c1 out 0 1u
vin in 0 dc 0 ac 1
.ac dec 200 1 100k
.measure ac f3db when vdb(out)=-3.0103
`;

const LIN = `* series 50 ohm between two 50 ohm ports: S21 = S12 = 2/3, S11 = S22 = 1/3 at every frequency
p1 a 0 port=1 z0=50
p2 b 0 port=2 z0=50
r1 a b 50
.ac lin 11 1e9 11e9
.lin format=touchstone2 sparcalc=1
`;

const GAPS = `* two devices without a model that Xyce accepts
.model nbad nmos level=9999
m1 d g 0 0 nbad w=1u l=0.13u
q1 d g 0 qmissing
vd d 0 1
vg g 0 0.6
.op
`;

// v(out) = a1 v(a) - a3 v(a)^3 into 50 ohm, v(a) from a 50 ohm source into 50 ohm. The source amplitude comes from
// the available power pin_dbm: V = sqrt(8 R Pav).
const CUBIC = `* cubic amplifier, ideal devices
.param pin_dbm=-20
vs src 0 sin(0 {sqrt(8*50*1e-3*pow(10,pin_dbm/10))} 1e9)
rs src a 50
ra a 0 50
bnl out 0 v={2*v(a)-0.4*v(a)*v(a)*v(a)}
rl out 0 50
vcc vcc 0 1.5
rcc vcc 0 1k
.hb 1e9
.print hb_fd v(out)
`;

for (const [env, { config, skip }] of Object.entries(environments)) {
	const setup = (t, files) => {
		const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-xyce-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { [env]: config } }));
		for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
		return root;
	};
	const why = (r) => JSON.stringify(r.errors.concat(r.diagnostics.map((d) => d.message)));

	test(`xyce simulate: params and temp_c replace the deck's values (${env})`, { skip, timeout: 120_000 }, async (t) => {
		const root = setup(t, { "rc.cir": RC });
		const { result } = await runExperiment({ root, adapter: "xyce", operation: "simulate", environment: env,
			inputs: { deck: "rc.cir", params: { rval: "2k" }, temp_c: 77, measurements: { f3db: "Hz", absent: "V" } } });
		assert.equal(result.status, "completed", why(result));
		const expected = 1 / (2 * Math.PI * 2e3 * (1 + 0.002 * 50) * 1e-6);
		assert.ok(Math.abs(result.measurements.f3db.value / expected - 1) < 1e-3, `f3db ${result.measurements.f3db.value}, expected ${expected}`);
		assert.equal(result.measurements.absent.status, "missing");
		assert.match(String(result.tool.version), /^7\./);
	});

	test(`xyce simulate refuses .temp and YLIN in AC (${env})`, { skip, timeout: 120_000 }, async (t) => {
		const root = setup(t, { "t.cir": RC.replace(".param rval=1k", ".param rval=1k\n.temp 85"), "y.cir": `${LIN}ylin y1 a 0 b 0 lmod\n` });
		for (const [deck, text] of [["t.cir", "ignores .temp"], ["y.cir", "open circuit"]]) {
			const { result } = await runExperiment({ root, adapter: "xyce", operation: "simulate", environment: env, inputs: { deck } });
			assert.equal(result.status, "failed");
			assert.ok(result.diagnostics.some((d) => d.severity === "error" && d.message.includes(text)), why(result));
			assert.equal((result.commands ?? []).length, 0, "Xyce did not run");
		}
	});

	test(`xyce simulate .LIN writes a Touchstone output that the kernel summarizes (${env})`, { skip, timeout: 120_000 }, async (t) => {
		const root = setup(t, { "lin.cir": LIN });
		const { result } = await runExperiment({ root, adapter: "xyce", operation: "simulate", environment: env, inputs: { deck: "lin.cir" } });
		assert.equal(result.status, "completed", why(result));
		const ts = result.outputs.find((f) => f.role === "touchstone");
		assert.ok(ts, JSON.stringify(result.outputs));
		assert.equal(ts.touchstone.nports, 2);
		assert.equal(ts.touchstone.points, 11);
		assert.ok(Math.abs(ts.touchstone.passivity.max_singular_value - 1) < 1e-6, "a series resistor: sigma_max = 1 (common mode)");
		assert.ok(ts.touchstone.reciprocity.max_abs_difference < 1e-9);
	});

	test(`xyce parse reports the model gaps (${env})`, { skip, timeout: 120_000 }, async (t) => {
		const root = setup(t, { "gaps.cir": GAPS });
		const { result } = await runExperiment({ root, adapter: "xyce", operation: "parse", environment: env, inputs: { deck: "gaps.cir" } });
		assert.equal(result.status, "completed", why(result));
		assert.equal(result.measurements.model_gaps.value, 2);
		assert.equal(result.measurements.devices.status, "missing");
		assert.ok(result.diagnostics.some((d) => d.message.startsWith("model missing") && d.source === "gaps.cir:3"), why(result));
	});

	test(`xyce hb: harmonics and DC current of a cubic, known answer (${env})`, { skip, timeout: 120_000 }, async (t) => {
		const root = setup(t, { "cubic.cir": CUBIC });
		const { result } = await runExperiment({ root, adapter: "xyce", operation: "hb", environment: env, inputs: {
			deck: "cubic.cir", params: { pin_dbm: 0 }, tones: [1e9], harmonics: 7, startup_periods: 2,
			ports: { out: { node: "out", r_ohm: 50 } }, dc_currents: ["vcc"] } });
		assert.equal(result.status, "completed", why(result));
		const a = Math.sqrt(2 * 50 * 1e-3); // v(a) amplitude at 0 dBm available
		const h1 = 2 * a - 0.75 * 0.4 * a ** 3;
		const h3 = 0.25 * 0.4 * a ** 3;
		const dbm = (amp) => 10 * Math.log10(amp ** 2 / 2 / 50 / 1e-3);
		const m = result.measurements;
		assert.ok(Math.abs(m.p_out_h1_dbm.value - dbm(h1)) < 1e-3, `h1 ${m.p_out_h1_dbm.value} vs ${dbm(h1)}`);
		assert.ok(Math.abs(m.p_out_h3_dbm.value - dbm(h3)) < 1e-2, `h3 ${m.p_out_h3_dbm.value} vs ${dbm(h3)}`);
		assert.ok(m.p_out_h2_dbm.value < -150, "no even harmonic");
		assert.ok(Math.abs(m.i_vcc_a.value + 1.5e-3) < 1e-9);
		assert.ok(result.diagnostics.some((d) => d.message.includes("removed from the deck for hb: .hb 1e9; .print hb_fd v(out)")));
	});

	test(`xyce hb sweep: gain and P1dB of a cubic, known answer (${env})`, { skip, timeout: 600_000 }, async (t) => {
		const root = setup(t, { "cubic.cir": CUBIC });
		const values = Array.from({ length: 45 }, (_, k) => -10 + k * 0.5);
		const { result } = await runExperiment({ root, adapter: "xyce", operation: "hb", environment: env, inputs: {
			deck: "cubic.cir", tones: [1e9], harmonics: 7, startup_periods: 2, parallel: 4,
			ports: { out: { node: "out", r_ohm: 50 } }, sweep: { param: "pin_dbm", values, available_power_dbm: true } } });
		assert.equal(result.status, "completed", why(result));
		const m = result.measurements;
		// Fundamental of the cubic: h1 = A (a1 - 0.75 a3 A^2) with a1 = 2, a3 = 0.4, so the gain is (2 - 0.3 A^2)^2 and
		// Pav = A^2 / 100 (A: amplitude at the matched input). The reference gain is the gain at the first point.
		const a2first = 2 * 50 * 1e-3 * 10 ** (-10 / 10);
		const g0 = 2 - 0.3 * a2first;
		assert.ok(Math.abs(m.gain_ss_out_db.value - 20 * Math.log10(g0)) < 1e-4, `small-signal gain ${m.gain_ss_out_db.value}`);
		const a2 = (2 - g0 * 10 ** (-1 / 20)) / 0.3;
		const ip1 = 10 * Math.log10(a2 / 100 / 1e-3);
		assert.ok(Math.abs(m.p1db_in_out_dbm.value - ip1) < 0.05, `IP1dB ${m.p1db_in_out_dbm.value}, expected ${ip1}`);
		assert.ok(Math.abs(m.p1db_out_out_dbm.value - (m.p1db_in_out_dbm.value + m.gain_ss_out_db.value - 1)) < 1e-9);
		assert.deepEqual(m["gain_out_db.min"].at, { pin_dbm: 12 });
		assert.equal(m.points_converged.value, 45);
	});

	test(`xyce hb: a point without a result in the wall time is a timeout, never a value (${env})`, { skip, timeout: 120_000 }, async (t) => {
		const root = setup(t, { "cubic.cir": CUBIC });
		const { result } = await runExperiment({ root, adapter: "xyce", operation: "hb", environment: env, inputs: {
			deck: "cubic.cir", tones: [1e9], harmonics: 7, wall_s_per_point: 0.05,
			ports: { out: { node: "out", r_ohm: 50 } }, sweep: { param: "pin_dbm", values: [0, 1], available_power_dbm: true } } });
		assert.equal(result.status, "failed");
		assert.equal(result.measurements["p_out_h1_dbm.min"].status, "failed");
		assert.equal(result.measurements.p1db_in_out_dbm.status, "failed");
		assert.ok(result.diagnostics.some((d) => d.message.includes("timeout: no result in 0.05 s")), why(result));
	});
}
