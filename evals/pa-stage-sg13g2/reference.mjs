// Reference values of the pa-stage-sg13g2 task: the reference stage through the same benches, corners and gates.
//
// The reference is the output stage of the 122 GHz PA of a public radar design (revision B2a: the interstage network
// with the 40 ohm / MIM stabiliser, a common-emitter npn13G2 Nx 8 with its wiring model, the output network). Its files
// are not part of this repository and never go into the agent workspace. Give a directory that holds:
//   pa_core.spice   the block pa_stage with the pins of spec.md and everything except the fitted networks
//   em/<name>.s3p   the EM data of the networks pa_isb and pa_out, with a 0 Hz point
// The script makes a design root, runs one fit_to_spice record per network in it (the operation and inputs that an
// agent uses), and writes pa_stage.spice as the fit outputs, copied unchanged, followed by pa_core.spice. The reference
// then goes through the full requirements, with one exception: em_passives_min is 0, because the EM data of the
// reference comes from the design and not from an openEMS record of the root.
//
// Usage: node evals/pa-stage-sg13g2/reference.mjs <reference dir> <verify root>   (writes expected.json)

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCheck } from "@simra-tech/kernel";
import { buildFlatReference } from "../rf-reference.mjs";

const here = new URL(".", import.meta.url).pathname;
export const NETWORKS = ["pa_isb", "pa_out"];
/** The fit inputs of a network: the band of use is the S-parameter bench (1 GHz to 300 GHz) and the harmonic balance
 * (122.5 GHz with 3 harmonics, to 367.5 GHz), with DC from the data (0 Hz point). */
export const fitInputs = (name) => ({ touchstone: `em/${name}.s3p`, name, uses: { band_hz: [1e9, 367.5e9], dc: true }, verify: ["ngspice"] });

export const buildReference = (dir, root) =>
	buildFlatReference({ here, dir, root, networks: NETWORKS, fitInputs, core: "pa_core.spice", design: "pa_stage.spice" });

if (import.meta.url === `file://${process.argv[1]}`) {
	const [dir, root] = process.argv.slice(2);
	if (!dir || !root || !existsSync(join(dir, "pa_core.spice"))) {
		console.error("usage: node evals/pa-stage-sg13g2/reference.mjs <reference dir with pa_core.spice and em/> <verify root>");
		process.exit(2);
	}
	const r = await buildReference(resolve(dir), root);
	const { verdict } = await runCheck({ root: r, parallel: 5 });
	const rows = Object.fromEntries(verdict.rows.map((x) => [`${x.condition} ${x.requirement}`, x.value ?? null]));
	const expected = {
		provenance:
			"simulated, Xyce 7.10 (harmonic balance) and ngspice 46 (S-parameters), IHP SG13G2, sw_nqs=1 on every HBT: the output stage of the PA of a public 122 GHz radar design (revision B2a; EM networks fitted to SPICE by fit_to_spice records), through hb.spice, sp.spice and requirements.json of this task with all gates (em_passives_min 0)",
		all_pass: verdict.rows.every((x) => x.status === "pass"),
		failed: verdict.rows.filter((x) => x.status !== "pass").map((x) => `${x.condition} ${x.requirement}: ${x.status}${x.reason ? ` (${x.reason})` : ""}`),
		rows,
	};
	writeFileSync(`${here}expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
	console.log(JSON.stringify(expected, null, 2));
}
