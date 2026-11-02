// Score a workspace of this layout-false-pass task. See ../../layout-drc-fix/layout.mjs.
//
// Usage: node evals/layout-false-pass/<pdk>/score.mjs <workspace>   (prints the score as JSON)

import { scoreLayout, scoreMain } from "../../layout-drc-fix/layout.mjs";

const here = new URL(".", import.meta.url).pathname;

export const score = (ws, _options, inside) => scoreLayout(ws, here, { mode: "false-pass", inside });

if (import.meta.url === `file://${process.argv[1]}`) await scoreMain(here, "false-pass", process.argv);
