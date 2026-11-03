// Score a workspace of this layout-stale-state task. See ../../layout-drc-fix/layout.mjs (mode stale-state) and
// ../kept.mjs (the kept check).
//
// Usage: node evals/layout-stale-state/<pdk>/score.mjs <workspace>   (prints the score as JSON)

import { scoreLayout, scoreMain } from "../../layout-drc-fix/layout.mjs";
import { checkKept } from "../kept.mjs";

const here = new URL(".", import.meta.url).pathname;

export const score = (ws, _options, inside) => scoreLayout(ws, here, { mode: "stale-state", inside, keptChecker: checkKept });

if (import.meta.url === `file://${process.argv[1]}`) await scoreMain(here, "stale-state", process.argv, { keptChecker: checkKept });
