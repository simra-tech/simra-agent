// Score a workspace of this layout-block-fix task. See ../../layout-drc-fix/layout.mjs.
//
// Usage: node evals/layout-block-fix/<pdk>/score.mjs <workspace>   (prints the score as JSON)

import { scoreLayout, scoreMain } from "../../layout-drc-fix/layout.mjs";

const here = new URL(".", import.meta.url).pathname;

export const score = (ws, _options, inside) => scoreLayout(ws, here, { mode: "block-fix", inside });

if (import.meta.url === `file://${process.argv[1]}`) await scoreMain(here, "block-fix", process.argv);
