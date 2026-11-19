// Score a workspace of the vco-sg13g2 task (task.md, spec.md): the scorer of evals/rf-score.mjs with the design file
// vco.spice. See that file for the parts of the score.
//
// Usage: node evals/vco-sg13g2/score.mjs <workspace>   (prints the score as JSON)

import { resolve } from "node:path";
import { makeScorer } from "../rf-score.mjs";

const here = new URL(".", import.meta.url).pathname;
export const TOLERANCE = { f_low: { rel: 0.002 }, f_high: { rel: 0.002 }, amp_v: { rel: 0.03 }, t_start: { rel: 0.1 }, pn_dev: { abs: 0.5 } };
export const { checkDesign, verify, score } = makeScorer({ here, design: "vco.spice", tolerance: TOLERANCE });

if (import.meta.url === `file://${process.argv[1]}`) {
	if (!process.argv[2]) {
		console.error("usage: node evals/vco-sg13g2/score.mjs <workspace>");
		process.exit(2);
	}
	console.log(JSON.stringify(await score(resolve(process.argv[2])), null, 2));
}
