// Score a workspace of this layout-clean task. See ../../layout-drc-fix/layout.mjs.
//
// Usage: node evals/layout-clean/<pdk>/score.mjs <workspace>   (prints the score as JSON)

import { scoreLayout, scoreMain } from "../../layout-drc-fix/layout.mjs";

const here = new URL(".", import.meta.url).pathname;

export const score = (ws, _options, inside) => scoreLayout(ws, here, { mode: "clean", inside });

if (import.meta.url === `file://${process.argv[1]}`) await scoreMain(here, "clean", process.argv);
