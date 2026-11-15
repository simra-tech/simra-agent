// Reference values of the lna-sg13g2 task: the reference amplifier through the same benches, corners and gates.
//
// The reference is the LNA of phase 1 of a public 122 GHz radar design (three common-emitter stages, Nx 4, EM matching
// networks fitted to SPICE), in a wrapper lna with the pins of spec.md. Its files are not part of this repository and
// never go into the agent workspace. Give the directory that holds the wrapper lna.spice and the files it includes.
// The device rules of spec.md are not applied: the reference uses its own EM models without workspace records, and a
// wrapper that includes its netlist. The netlist gate is taken out of the requirements of the reference run.
//
// Usage: node evals/lna-sg13g2/reference.mjs <reference dir with lna.spice> <verify root>   (writes expected.json)

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCheck } from "@simra-tech/kernel";

const here = new URL(".", import.meta.url).pathname;
const [dir, root] = process.argv.slice(2);
if (!dir || !root || !existsSync(join(dir, "lna.spice"))) {
	console.error("usage: node evals/lna-sg13g2/reference.mjs <reference dir with lna.spice> <verify root>");
	process.exit(2);
}
const r = resolve(root);
rmSync(r, { recursive: true, force: true });
cpSync(resolve(dir), r, { recursive: true });
for (const f of ["simra.config.json", "simra.local.json", "sp.spice", "noise.spice", "lines.spice", "requirements.json"])
	if (existsSync(join(here, f))) cpSync(join(here, f), join(r, f));
const req = JSON.parse(readFileSync(join(r, "requirements.json"), "utf8"));
delete req.gates.netlist;
writeFileSync(join(r, "requirements.json"), `${JSON.stringify(req, null, 2)}\n`);
const { verdict } = await runCheck({ root: r, parallel: 5 });
const rows = Object.fromEntries(verdict.rows.map((x) => [`${x.condition} ${x.requirement}`, x.value ?? null]));
const expected = {
	provenance: "simulated, ngspice 46, IHP SG13G2: the LNA of phase 1 of a public 122 GHz radar design (three CE stages, EM matching networks fitted to SPICE), through sp.spice, noise.spice and requirements.json of this task",
	all_pass: verdict.rows.every((x) => x.status === "pass"),
	failed: verdict.rows.filter((x) => x.status !== "pass").map((x) => `${x.condition} ${x.requirement}: ${x.status}`),
	rows,
};
writeFileSync(`${here}expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
console.log(JSON.stringify(expected, null, 2));
