// Score a workspace of the pa-stage-sg13g2 task (task.md, spec.md): the scorer of evals/rf-score.mjs with the design
// file pa_stage.spice. See that file for the parts of the score.
//
// Usage: node evals/pa-stage-sg13g2/score.mjs <workspace>   (prints the score as JSON)

import { resolve } from "node:path";
import { makeScorer } from "../rf-score.mjs";

const here = new URL(".", import.meta.url).pathname;
export const TOLERANCE = { pout_tt: { abs: 0.2 }, pout: { abs: 0.2 }, ipa_a: { rel: 0.02 }, mu: { rel: 0.02 } };
export const { checkDesign, verify, score } = makeScorer({ here, design: "pa_stage.spice", tolerance: TOLERANCE });

if (import.meta.url === `file://${process.argv[1]}`) {
	if (!process.argv[2]) {
		console.error("usage: node evals/pa-stage-sg13g2/score.mjs <workspace>");
		process.exit(2);
	}
	console.log(JSON.stringify(await score(resolve(process.argv[2])), null, 2));
}
