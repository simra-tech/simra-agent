// Reference values of the det-cell-sg13g2-hard task: the reference cell and a reference tap through the same check.
//
// The reference cell is the detector cell of record of a public 122 GHz radar design, in a wrapper det_cell with the
// pins of spec.md (not in this repository; give its path). The reference tap is make_tap.py with its defaults: a
// TopMetal2 spur, a TopVia2 and a 1.3 um MIM (about 2.5 fF, the tap capacitance of the reference cell) on a Metal5
// plate. The reference design has no EM record of its tap; the tap rows have no reference value from the design.
//
// Usage: node evals/det-cell-sg13g2-hard/reference.mjs <reference det_cell.spice> <tap.gds> <verify root>
//        (writes expected.json; make the GDS with make_tap.py in the eda image)

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkDesign } from "../det-cell-sg13g2/score.mjs";
import { verify } from "./score.mjs";

const here = new URL(".", import.meta.url).pathname;
const [file, gds, root] = process.argv.slice(2);
if (!file || !gds || !root) {
	console.error("usage: node evals/det-cell-sg13g2-hard/reference.mjs <reference det_cell.spice> <tap.gds> <verify root>");
	process.exit(2);
}
const text = readFileSync(file, "utf8");
const errors = checkDesign(text, here);
if (errors.length) throw new Error(`the reference breaks the device rules: ${errors.join("; ")}`);
const v = await verify(here, text, resolve(root), resolve(gds));
const expected = {
	provenance: "simulated, ngspice 46 and openEMS 0.37, IHP SG13G2: the detector cell of record (revision A) of a public 122 GHz radar design and the tap of make_tap.py (defaults), through the benches, the Monte Carlo experiment, the gates and requirements.json of this task",
	all_pass: Object.values(v.rows).every((r) => r.pass),
	failed: Object.entries(v.rows).filter(([, r]) => !r.pass).map(([k, r]) => `${k}: ${r.status}`),
	rows: Object.fromEntries(Object.entries(v.rows).map(([k, r]) => [k, r.value])),
};
writeFileSync(`${here}expected.json`, `${JSON.stringify(expected, null, 2)}\n`);
console.log(JSON.stringify(expected, null, 2));
