// Score a workspace of this ota-sizing task. See ../sizing.mjs.
//
// Usage: node evals/ota-sizing/<task>/score.mjs <workspace>   (prints the score as JSON)

import { scoreSizing, scoreMain } from "../sizing.mjs";

const here = new URL(".", import.meta.url).pathname;

export const score = (ws) => scoreSizing(ws, here);

if (import.meta.url === `file://${process.argv[1]}`) await scoreMain(here, process.argv);
