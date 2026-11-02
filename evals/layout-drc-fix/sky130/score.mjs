// Score a workspace of this layout-drc-fix task. See ../layout.mjs.
//
// Usage: node evals/layout-drc-fix/<pdk>/score.mjs <workspace>   (prints the score as JSON)

import { scoreLayout, scoreMain } from "../layout.mjs";

const here = new URL(".", import.meta.url).pathname;

export const score = (ws, _options, inside) => scoreLayout(ws, here, { mode: "drc-fix", inside });

if (import.meta.url === `file://${process.argv[1]}`) await scoreMain(here, "drc-fix", process.argv);
