// End-to-end oscillator: kernel runner + ngspice adapter + real ngspice, on an LC oscillator with a limiting negative
// conductance (no PDK). The ISF result for the tank resistor noise must equal the closed form of an LC tank with a
// sine output: L(df) = S / (4 (C A)^2 (2 pi df)^2), S = 4 k T / R. A skipped case is reported as skipped: that check
// did not run.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExperiment } from "@simra-tech/kernel";

const fixtures = new URL("../packages/kernel/test/fixtures/oscillator/", import.meta.url).pathname;
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

const R = 500;
const C = 1e-12;
const S = (4 * 1.380649e-23 * 300.15) / R;

for (const [name, { config, skip }] of Object.entries(environments)) {
	test(`ngspice oscillator: f0, amplitude and the ISF phase noise of an LC tank equal the closed form (${name})`, { skip, timeout: 300_000 }, async (t) => {
		const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-osc-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { [name]: config } }));
		cpSync(fixtures, root, { recursive: true });
		const { id, result } = await runExperiment({
			root,
			adapter: "ngspice",
			operation: "oscillator",
			environment: name,
			inputs: {
				deck: "lc.spice",
				output: { p: "a" },
				tstep_s: 0.5e-12,
				settle_s: 5e-9,
				ref_stop_s: 8e-9,
				isf: { phases: 16, window_periods: [20, 30], offsets_hz: [1e6], parallel: 2, sources: [{ name: "tank", nodes: "a 0", psd_a2_hz: S }] },
			},
		});
		assert.equal(result.status, "completed", JSON.stringify(result.errors.concat(result.diagnostics.map((d) => d.message))));
		const m = result.measurements;
		const f0 = 1 / (2 * Math.PI * Math.sqrt(1e-9 * C));
		assert.ok(Math.abs(m.f0_hz.value / f0 - 1) < 2e-3, `f0 ${m.f0_hz.value}`);
		assert.ok(m.period_spread_rel.value < 1e-4);
		const A = m.amplitude_v.value;
		assert.ok(Math.abs(A / ((4 / Math.PI) * 2e-3 * R) - 1) < 0.02, `amplitude ${A}`); // describing function of a hard limiter
		const closed = 10 * Math.log10(S / (4 * (C * A) ** 2 * (2 * Math.PI * 1e6) ** 2));
		const L = m["l_1e+06_hz_dbc"].value;
		t.diagnostic(`f0 ${(m.f0_hz.value / 1e9).toFixed(4)} GHz, A ${A.toFixed(4)} V, L(1 MHz) ${L.toFixed(2)} dBc/Hz, closed form ${closed.toFixed(2)}`);
		assert.ok(Math.abs(L - closed) < 0.3, `L ${L} against ${closed}`);
		const isf = JSON.parse(readFileSync(join(root, "simra/experiments", id, "work/oscillator.json"), "utf8")).sources.tank.isf;
		const peak = Math.max(...isf.map(Math.abs));
		assert.ok(Math.abs(peak * 2 * Math.PI * m.f0_hz.value * C * A - 1) < 0.05, `ISF peak ${peak}`); // |Gamma| = 1 for a sine
	});
}

// Container: the 61.8 GHz VCO of a radar study (IHP SG13G2 HBTs, typical) against its stored ISF result of 32 phases
// (simulated, ngspice 46: f0 61.830 GHz, amplitude 1.133 V of the first harmonic, tank noise -102.43 dBc/Hz at 1 MHz
// at f0, so -96.41 dBc/Hz after the doubler). This test uses 8 phases and the tank source only, to stay short.
const image = process.env.SIMRA_TEST_IMAGE;
test("ngspice oscillator: the SG13G2 VCO gives the stored f0 and tank phase noise (container)", { skip: !image && "SIMRA_TEST_IMAGE is not set", timeout: 900_000 }, async (t) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-osc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = { PDK_ROOT: "/foss/pdks", PDK: "ihp-sg13g2", SPICE_USERINIT_DIR: "/foss/pdks/ihp-sg13g2/libs.tech/ngspice", HOME: "/tmp" };
	const config = { kind: "container", engine: process.env.SIMRA_TEST_ENGINE ?? "podman", image, cpus: process.env.SIMRA_TEST_CPUS, env };
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { eda: config } }));
	cpSync(fixtures, root, { recursive: true });
	const models = "$PDK_ROOT/ihp-sg13g2/libs.tech/ngspice/models";
	const { result } = await runExperiment({
		root,
		adapter: "ngspice",
		operation: "oscillator",
		environment: "eda",
		inputs: {
			deck: "vco_a.spice",
			libs: [{ path: `${models}/cornerHBT.lib`, section: "hbt_typ" }, { path: `${models}/cornerCAP.lib`, section: "cap_typ" }],
			output: { p: "ca", n: "cb" },
			tstep_s: 2.5e-14,
			settle_s: 0.8e-9,
			ref_stop_s: 1.2e-9,
			output_multiplier: 2,
			isf: { phases: 8, t0_s: 1e-9, pulse_s: 1e-13, offsets_hz: [1e6], sources: [{ name: "tank", nodes: "vcc ca", psd_a2_hz: (4 * 1.380649e-23 * 300.15) / 214.163, mult: 2 }] },
		},
	});
	assert.equal(result.status, "completed", JSON.stringify(result.errors.concat(result.diagnostics.map((d) => d.message))));
	const m = result.measurements;
	const L = m["l_1e+06_hz_dbc"].value;
	t.diagnostic(`f0 ${(m.f0_hz.value / 1e9).toFixed(3)} GHz, amplitude ${m.amplitude_v.value.toFixed(4)} V, L(1 MHz) at 2 f0 ${L.toFixed(2)} dBc/Hz`);
	assert.ok(Math.abs(m.f0_hz.value / 61.8297e9 - 1) < 1e-3, `f0 ${m.f0_hz.value}`);
	assert.ok(Math.abs(L + 96.41) < 0.3, `L ${L}`);
});
