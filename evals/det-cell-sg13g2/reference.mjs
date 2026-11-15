// Reference values of the det-cell-sg13g2 task: the reference design of record through the same bench and corners.
//
// The reference design is the detector cell of revision A of a public 122 GHz radar design (subcircuit
// r2_det_cell_ir, pins lin vcc18 outd outr nma), in a wrapper det_cell with the pins of spec.md. The file is not part
// of this repository and never goes into the agent workspace; give its path on the command line.
//
// Usage: node evals/det-cell-sg13g2/reference.mjs <det_cell.spice of the reference> <verify root>   (writes expected.json)

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkDesign, verify } from "./score.mjs";

const here = new URL(".", import.meta.url).pathname;
const [file, root] = process.argv.slice(2);
if (!file || !root) {
	console.error("usage: node evals/det-cell-sg13g2/reference.mjs <reference det_cell.spice> <verify root>");
	process.exit(2);
}
const text = readFileSync(file, "utf8");
const errors = checkDesign(text);
if (errors.length) throw new Error(`the reference breaks the device rules: ${errors.join("; ")}`);
const v = await verify(here, text, resolve(root));
const rows = Object.fromEntries(Object.entries(v.rows).map(([k, r]) => [k, r.value]));
const expected = {
	provenance: "simulated, ngspice 46, IHP SG13G2: the detector cell of record (revision A, r2_det_cell_ir) of a public 122 GHz radar design, through verify.spice and requirements.json of this task",
	all_pass: Object.values(v.rows).every((r) => r.pass),
	failed: Object.entries(v.rows).filter(([, r]) => !r.pass).map(([k]) => k),
	rows,
};
writeFileSync(`${here}expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
console.log(JSON.stringify(expected, null, 2));
