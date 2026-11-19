// End-to-end: kernel runner + touchstone adapter (fit_to_spice) on a synthetic 2-port and 3-port with closed-form
// S-parameters, re-simulated in ngspice and in Xyce. Tolerances: the simulated subcircuit against the data, max |dS|
// below 2e-3; against the rational model, below 1e-4 (the adapter's own limit).
// "local" needs python3 with numpy; the re-simulation in a simulator that is not on the PATH is not run, and the test
// checks that the response says so. "container" runs only when SIMRA_TEST_IMAGE names an image with python3, numpy,
// ngspice and Xyce (optional: SIMRA_TEST_ENGINE, SIMRA_TEST_CPUS). A skipped case is reported as skipped.

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
const hasNumpy = works("python3", ["-c", "import numpy"]);
const onPath = { ngspice: works("ngspice", ["--version"]), xyce: works("Xyce", ["-v"]) };

// Complex numbers as [re, im].
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const div = (a, b) => {
	const d = b[0] * b[0] + b[1] * b[1];
	return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const inv = (a) => div([1, 0], a);

/** Solve A X = B for complex square matrices (Gauss-Jordan with partial pivoting). */
function solve(a, b) {
	const n = a.length;
	const m = a.map((row, i) => [...row.map((x) => [...x]), ...b[i].map((x) => [...x])]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.hypot(...m[r][c]) > Math.hypot(...m[p][c])) p = r;
		[m[c], m[p]] = [m[p], m[c]];
		const piv = m[c][c];
		m[c] = m[c].map((x) => div(x, piv));
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const k = m[r][c];
			m[r] = m[r].map((x, j) => sub(x, mul(k, m[c][j])));
		}
	}
	return m.map((row) => row.slice(n));
}

/** S from Y with real reference impedances: S = (I + G Y G)^-1 (I - G Y G), G = diag(sqrt(z0)). Y and G commute in
 * this form because (I + X)^-1 and (I - X) commute. */
function sFromY(y, z0) {
	const n = z0.length;
	const x = y.map((row, i) => row.map((v, j) => mul(v, [Math.sqrt(z0[i] * z0[j]), 0])));
	const eye = (i, j) => [i === j ? 1 : 0, 0];
	const plus = x.map((row, i) => row.map((v, j) => add(eye(i, j), v)));
	const minus = x.map((row, i) => row.map((v, j) => sub(eye(i, j), v)));
	return solve(plus, minus).slice(0, n);
}

/** Pi network: shunt C 0.4 pF (+ 0.1 mS), series R 0.5 ohm + L 1 nH, shunt C 0.4 pF (+ 0.1 mS). */
function lowpass(f) {
	const w = 2 * Math.PI * f;
	const ys = inv([0.5, w * 1e-9]);
	const yc = [1e-4, w * 0.4e-12];
	return sFromY([[add(ys, yc), [-ys[0], -ys[1]]], [[-ys[0], -ys[1]], add(ys, yc)]], [50, 50]);
}

/** Three branches R + L to a centre node with 0.2 pF and 2 kohm to ground. */
function star(f, z0) {
	const w = 2 * Math.PI * f;
	const yb = [[2, 0.5e-9], [5, 1e-9], [10, 2e-9]].map(([r, l]) => inv([r, w * l]));
	const yc = yb.reduce(add, [1 / 2000, w * 0.2e-12]);
	const y = [0, 1, 2].map((i) => [0, 1, 2].map((j) => sub(i === j ? yb[i] : [0, 0], div(mul(yb[i], yb[j]), yc))));
	return sFromY(y, z0);
}

/** A version 1 file (equal z0) or a version 2 file (z0 per port), RI format, in Hz. */
function touchstone(freqs, sOf, z0) {
	const n = z0.length;
	const same = z0.every((z) => z === z0[0]);
	const head = same
		? [`# Hz S RI R ${z0[0]}`]
		: ["[Version] 2.0", "# Hz S RI R 50", `[Number of Ports] ${n}`, `[Number of Frequencies] ${freqs.length}`, `[Reference] ${z0.join(" ")}`, "[Network Data]"];
	const rows = freqs.map((f) => {
		const s = sOf(f);
		const order = n === 2 ? [[0, 0], [1, 0], [0, 1], [1, 1]] : s.flatMap((row, i) => row.map((_, j) => [i, j]));
		return [f.toExponential(12), ...order.map(([i, j]) => `${s[i][j][0].toExponential(12)} ${s[i][j][1].toExponential(12)}`)].join(" ");
	});
	return [...head, ...rows, ...(same ? [] : ["[End]"])].join("\n") + "\n";
}

const environments = {
	local: { config: { kind: "local" }, skip: !hasNumpy && "python3 with numpy is not on PATH", sims: onPath },
	container: {
		config: {
			kind: "container",
			engine: process.env.SIMRA_TEST_ENGINE ?? "podman",
			image: process.env.SIMRA_TEST_IMAGE,
			cpus: process.env.SIMRA_TEST_CPUS,
			env: { HOME: "/tmp", OMP_NUM_THREADS: "1" },
		},
		skip: !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set",
		sims: { ngspice: true, xyce: true },
	},
};

const cases = [
	{ name: "2-port", file: "lp.s2p", z0: [50, 50], sOf: lowpass, freqs: Array.from({ length: 200 }, (_, k) => 1e8 + k * 1e8), uses: { f0_hz: 5e9, harmonics: 4, dc: false } },
	{ name: "3-port", file: "star.s3p", z0: [50, 75, 25], sOf: (f) => star(f, [50, 75, 25]), freqs: Array.from({ length: 101 }, (_, k) => 2e8 + k * 2e8), uses: { band_hz: [1e9, 2e10] }, dc_policy: "model" },
];

for (const [env, { config, skip, sims }] of Object.entries(environments)) {
	for (const c of cases) {
		test(`touchstone fit_to_spice ${c.name}, re-simulated in ngspice and Xyce (${env})`, { skip, timeout: 300_000 }, async (t) => {
			const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-fit-"));
			t.after(() => rmSync(root, { recursive: true, force: true }));
			writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { [env]: config } }));
			writeFileSync(join(root, c.file), touchstone(c.freqs, c.sOf, c.z0));
			const { result } = await runExperiment({
				root,
				adapter: "touchstone",
				operation: "fit_to_spice",
				environment: env,
				inputs: { touchstone: c.file, uses: c.uses, ...(c.dc_policy ? { dc_policy: c.dc_policy } : {}) },
			});
			const why = JSON.stringify(result.errors.concat(result.diagnostics.map((d) => d.message)));
			assert.equal(result.status, "completed", why);
			const m = result.measurements;
			assert.ok(m.fit_max_abs_ds.value < 1e-3, `fit max |dS| ${m.fit_max_abs_ds.value}`);
			assert.ok(m.passivity_margin.value >= 0);
			for (const sim of ["ngspice", "xyce"]) {
				if (!sims[sim]) {
					assert.equal(m[`verify_${sim}_max_abs_ds`].status, "failed", `${sim} not on PATH: the value is not given`);
					assert.ok(result.diagnostics.some((d) => d.message.includes(`re-simulation in ${sim} not run`)));
					continue;
				}
				assert.ok(m[`verify_${sim}_model_max_abs_ds`].value < 1e-4, `${sim} against the model: ${m[`verify_${sim}_model_max_abs_ds`].value}`);
				assert.ok(m[`verify_${sim}_max_abs_ds`].value < 2e-3, `${sim} against the data: ${m[`verify_${sim}_max_abs_ds`].value}`);
			}
			// The kernel read both Touchstone files (the data and the model) and recorded their summaries.
			const input = result.input_files.files.find((f) => f.role === "touchstone");
			assert.equal(input.touchstone.nports, c.z0.length);
			assert.deepEqual(input.touchstone.z0_ohm, c.z0);
			assert.ok(input.touchstone.passivity.max_singular_value <= 1);
			const model = result.outputs.find((f) => f.role === "touchstone");
			assert.ok(model.touchstone.passivity.max_singular_value <= 1, JSON.stringify(model.touchstone));
			assert.ok(result.outputs.some((f) => f.role === "subckt" && f.path.endsWith(".lib")));
		});
	}
}
