// Reference values for the em-line-s21 task.
//
// 1. Copy line.gds into evals/em-line-s21/work/reference (not tracked).
// 2. Run the openEMS adapter through emSParameters (one job per port, then the merge): ports from Metal1 to TopMetal2
//    at x = 0 and x = 600 um, 1 GHz to 70 GHz, the PDK stackup, PML boundaries, end criterion -40 dB.
// 3. Read S21 at 60 GHz from the Touchstone file.
// 4. Trap value (a run with first-order MUR boundaries gave the same S21 at 60 GHz within 0.001 dB and 0.1 degree on
//    this line, so it is not a trap):
//    - oxide_tem: the phase of an ideal TEM line in SiO2 (eps 4.1) of 600 um, -2 pi f sqrt(4.1) L / c, with 0 dB.
// 5. Write expected.json.
//
// Usage: [SIMRA_LOCAL_JSON=<file>] [SIMRA_CPUS=<list>] node evals/em-line-s21/reference.mjs [environment]
// (default environment: eda; the environment needs python3 with CSXCAD, openEMS, gdstk and the IHP SG13G2 PDK)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emSParameters, readJson, sParametersAt } from "@simra-tech/kernel";

const here = new URL(".", import.meta.url).pathname;
const work = join(here, "work", "reference");
const environment = process.argv[2] ?? "eda";
export const F_HZ = 60e9;
export const LENGTH_UM = 600;
export const TOLERANCE = { s21_db: { abs: 0.05 }, s21_deg: { abs: 3 } };

export const INPUTS = {
	gds: "line.gds",
	stackup: "$PDK_ROOT/ihp-sg13g2/libs.tech/openems/openems_ihp_sg13g2/workflow/SG13G2_200um.xml",
	band_hz: [1e9, 70e9],
	points: 70,
	ports: [
		{ name: "p1", x: 0, y: 0, from: "Metal1", to: "TopMetal2" },
		{ name: "p2", x: LENGTH_UM, y: 0, from: "Metal1", to: "TopMetal2" },
	],
};

/** The phase of an ideal TEM line in SiO2, in degrees from -180 to 180. */
export function oxideTemDeg(f = F_HZ, length = LENGTH_UM) {
	const deg = (-360 * f * Math.sqrt(4.1) * length * 1e-6) / 299792458;
	return ((((deg + 180) % 360) + 360) % 360) - 180;
}

async function s21(inputs, cpus) {
	const out = await emSParameters({ root: work, inputs, environment, cpus, parallel: 2, timeoutS: 3600 });
	if (!out.touchstone) throw new Error(out.text);
	const [p] = sParametersAt(join(work, out.touchstone), [F_HZ]);
	return { db: p.s.S21[0], deg: p.s.S21[1], f_hz: p.f_hz, touchstone: out.touchstone, jobs: out.ports.jobs.map((j) => j.id), merge: out.merge?.id };
}

async function main() {
	if (existsSync(work)) rmSync(work, { recursive: true });
	mkdirSync(work, { recursive: true });
	copyFileSync(join(here, "line.gds"), join(work, "line.gds"));
	for (const f of ["simra.config.json", "simra.local.json"]) {
		const src = f === "simra.local.json" && process.env.SIMRA_LOCAL_JSON ? process.env.SIMRA_LOCAL_JSON : join(here, "../../examples/ota-sg13g2", f);
		if (existsSync(src)) copyFileSync(src, join(work, f));
	}
	const cpus = process.env.SIMRA_CPUS;
	const ref = await s21(INPUTS, cpus);
	const result = readJson(join(work, "simra/experiments", ref.jobs[0], "result.json"));
	const expected = {
		f_hz: F_HZ,
		s21_db: ref.db,
		s21_deg: ref.deg,
		tolerance: TOLERANCE,
		traps: { oxide_tem: { s21_db: 0, s21_deg: oxideTemDeg() } },
		provenance: {
			numbers: "simulated: openEMS 0.37 through the openems adapter (simra em), PML boundaries, end criterion -40 dB",
			experiments: [...ref.jobs, ref.merge],
			tool: result.tool,
			date: new Date().toISOString().slice(0, 10),
		},
	};
	writeFileSync(join(here, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
	console.log(JSON.stringify(expected, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
