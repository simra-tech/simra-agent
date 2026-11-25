// Reference values of the vco-sg13g2 task: the reference VCO core through the same bench, corners and gates.
//
// The reference is the 61 GHz core of the VCO of a public 122 GHz radar design (revision A core). Its files are not part
// of this repository and never go into the agent workspace. Give a directory that holds:
//   vco_core.spice   the block vco with the pins of spec.md and everything except the fitted tank
//   em/vco_tank.s5p  the EM data of the tank (5 ports, with its 0 Hz point)
// The script makes a design root, runs one fit_to_spice record of the tank in it, and writes vco.spice as the fit output,
// copied unchanged, followed by vco_core.spice. The reference then goes through the full requirements, with one
// exception: em_passives_min is 0, because the EM data of the reference comes from the design and not from an openEMS
// record of the root.
//
// Usage: node evals/vco-sg13g2/reference.mjs <reference dir> <verify root>   (writes expected.json)

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCheck } from "@simra-tech/kernel";
import { buildFlatReference } from "../rf-reference.mjs";

const here = new URL(".", import.meta.url).pathname;
/** The tank: DC and 1 GHz to 130 GHz (the fundamental and the second harmonic of 61 GHz), fitted from 0 Hz to 130 GHz
 * (order 6, max |dS| 0.0058). A fit to 260 GHz (order 12, max |dS| 0.0114) gives a differential Q of 13.7 at 61 GHz
 * against 15.8 in the EM data, and the core then does not start: the |dS| limit does not bound the tank loss. */
export const fitInputs = (name) => ({
	touchstone: `em/${name}.s5p`,
	name,
	uses: { band_hz: [1e9, 130e9], dc: true },
	fit_band_hz: [0, 130e9],
	// The differential Q between the device ends (ports 1 and 2) with the supply lead (port 5) at AC ground.
	checks: [{ name: "tank_q", kind: "q", ports: [1, 2], short: [5], band_hz: [58e9, 64e9], tol_rel: 0.05 }],
	verify: ["ngspice"],
});
export const buildReference = (dir, root) =>
	buildFlatReference({ here, dir, root, networks: ["vco_tank"], fitInputs, core: "vco_core.spice", design: "vco.spice", ext: "s5p" });

if (import.meta.url === `file://${process.argv[1]}`) {
	const [dir, root] = process.argv.slice(2);
	if (!dir || !root || !existsSync(join(dir, "vco_core.spice"))) {
		console.error("usage: node evals/vco-sg13g2/reference.mjs <reference dir with vco_core.spice and em/> <verify root>");
		process.exit(2);
	}
	const r = await buildReference(resolve(dir), root);
	const { verdict } = await runCheck({ root: r, parallel: 4 });
	const rows = Object.fromEntries(verdict.rows.map((x) => [`${x.condition} ${x.requirement}`, x.value ?? null]));
	const expected = {
		provenance:
			"simulated, ngspice 46, IHP SG13G2, sw_nqs=1 on every HBT: the 61 GHz core of the VCO of a public 122 GHz radar design (revision A core; the EM tank fitted to SPICE by a fit_to_spice record), through osc.spice and requirements.json of this task with all gates (em_passives_min 0)",
		all_pass: verdict.rows.every((x) => x.status === "pass"),
		failed: verdict.rows.filter((x) => x.status !== "pass").map((x) => `${x.condition} ${x.requirement}: ${x.status}${x.reason ? ` (${x.reason})` : ""}`),
		rows,
		// Rows measured at a condition and not scored (requirement.reported): the value, and why the row is not scored.
		reported: Object.fromEntries((verdict.reported ?? []).map((x) => [`${x.condition} ${x.requirement}`, x.value ?? null])),
		reported_notes: Object.fromEntries((verdict.reported ?? []).map((x) => [`${x.condition} ${x.requirement}`, `${x.status === "fail" ? "the reference core does not meet the limit" : x.status === "pass" ? "the reference core meets the limit" : x.status} (${x.op} ${x.limit}); ${x.reported_reason}`])),
	};
	writeFileSync(`${here}expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
	console.log(JSON.stringify(expected, null, 2));
}
