// Score a workspace of this ota-synthesis task. See ../synthesis.mjs.
//
// Usage: node evals/ota-synthesis/<task>/score.mjs <workspace>   (prints the score as JSON)

import { scoreMain, scoreSynthesis } from "../synthesis.mjs";

const here = new URL(".", import.meta.url).pathname;

export const score = (ws) => scoreSynthesis(ws, here);

if (import.meta.url === `file://${process.argv[1]}`) await scoreMain(here, process.argv);
