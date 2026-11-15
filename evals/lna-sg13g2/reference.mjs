// Reference values of the lna-sg13g2 task: the reference amplifier through the same benches, corners and gates.
//
// The reference is the LNA of phase 1 of a public 122 GHz radar design (three common-emitter stages, Nx 4, EM matching
// networks fitted to SPICE). Its files are not part of this repository and never go into the agent workspace. Give a
// directory that holds:
//   lna_core.spice   the block lna with the pins of spec.md and everything except the fitted networks
//   em/<name>.s3p    the EM data of the matching networks lna_IN, lna_IS1, lna_IS2, lna_OUT, with a 0 Hz point
// The script makes a design root, runs one fit_to_spice record per network in it (the same operation and inputs that
// an agent uses), and writes lna.spice as the fit outputs, copied unchanged, followed by lna_core.spice. The reference
// then goes through the full requirements, the netlist gate included, with one exception: em_passives_min is 0,
// because the EM data of the reference comes from the design and not from an openEMS record of the root.
//
// Usage: node evals/lna-sg13g2/reference.mjs <reference dir> <verify root>   (writes expected.json)

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCheck, runExperiment } from "@simra-tech/kernel";

const here = new URL(".", import.meta.url).pathname;
export const NETWORKS = ["lna_IN", "lna_IS1", "lna_IS2", "lna_OUT"];
/** The fit inputs of a network: the band of use of the task (1 GHz to 300 GHz, DC, port noise at 122 GHz); the data
 * has a 0 Hz point (the DC tree of the design), so DC comes from the data. Acceptance: max |dS| 0.01 (the default),
 * except lna_IS1: no order meets 0.01 over the whole data band (best 0.0118 at order 6, 0.005 in the band of use), so
 * its limit is 0.012 over the data and 0.01 in the band of use. lna_IS2 is fitted in the band of use only: with its data above 300 GHz the
 * order-6 fit has a max |dS| of 0.037. */
export const fitInputs = (name) => ({
	touchstone: `em/${name}.s3p`,
	name,
	uses: { band_hz: [1e9, 300e9], dc: true, noise_band_hz: [122e9, 123e9] },
	...(name === "lna_IS1" ? { limits: { max_abs_ds: 0.012, use_max_abs_ds: 0.01 } } : {}),
	...(name === "lna_IS2" ? { fit_band_hz: [0, 300e9] } : {}),
	verify: ["ngspice"],
});

/** Make the reference design root: the fit records and lna.spice. Returns the root. */
export async function buildReference(dir, root) {
	const r = resolve(root);
	rmSync(r, { recursive: true, force: true });
	mkdirSync(join(r, "em"), { recursive: true });
	for (const f of ["simra.config.json", "simra.local.json", "sp.spice", "noise.spice", "lines.spice", "requirements.json"])
		if (existsSync(join(here, f))) cpSync(join(here, f), join(r, f));
	const libs = [];
	for (const name of NETWORKS) {
		cpSync(join(dir, "em", `${name}.s3p`), join(r, "em", `${name}.s3p`));
		const { result } = await runExperiment({ root: r, adapter: "touchstone", operation: "fit_to_spice", inputs: fitInputs(name), purpose: `reference: fit of ${name}`, environment: "eda" });
		const sub = (result.outputs ?? []).find((o) => o.role === "subckt");
		if (result.status !== "completed" || !sub) throw new Error(`fit of ${name}: ${result.status} ${result.errors.join("; ")}`);
		libs.push(readFileSync(join(r, sub.path), "utf8").trimEnd());
	}
	const core = readFileSync(join(dir, "lna_core.spice"), "utf8");
	writeFileSync(join(r, "lna.spice"), `${libs.join("\n\n")}\n\n${core}`);
	const req = JSON.parse(readFileSync(join(r, "requirements.json"), "utf8"));
	req.gates.netlist.em_passives_min = 0;
	writeFileSync(join(r, "requirements.json"), `${JSON.stringify(req, null, 2)}\n`);
	return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [dir, root] = process.argv.slice(2);
	if (!dir || !root || !existsSync(join(dir, "lna_core.spice"))) {
		console.error("usage: node evals/lna-sg13g2/reference.mjs <reference dir with lna_core.spice and em/> <verify root>");
		process.exit(2);
	}
	const r = await buildReference(resolve(dir), root);
	const { verdict } = await runCheck({ root: r, parallel: 5 });
	const rows = Object.fromEntries(verdict.rows.map((x) => [`${x.condition} ${x.requirement}`, x.value ?? null]));
	const expected = {
		provenance:
			"simulated, ngspice 46, IHP SG13G2: the LNA of phase 1 of a public 122 GHz radar design (three CE stages, EM matching networks fitted to SPICE by fit_to_spice records, PDK resistors), through sp.spice, noise.spice and requirements.json of this task with all gates (em_passives_min 0)",
		all_pass: verdict.rows.every((x) => x.status === "pass"),
		failed: verdict.rows.filter((x) => x.status !== "pass").map((x) => `${x.condition} ${x.requirement}: ${x.status}${x.reason ? ` (${x.reason})` : ""}`),
		rows,
	};
	writeFileSync(`${here}expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
	console.log(JSON.stringify(expected, null, 2));
}
