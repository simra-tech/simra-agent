// Score a workspace of this comparator-synthesis task. See ../synthesis.mjs.
//
// Usage: node evals/comparator-synthesis/<task>/score.mjs <workspace>   (prints the score as JSON)

import { scoreComparator, scoreMain } from "../synthesis.mjs";

const here = new URL(".", import.meta.url).pathname;

export const score = (ws) => scoreComparator(ws, here);

if (import.meta.url === `file://${process.argv[1]}`) await scoreMain(here, process.argv);
