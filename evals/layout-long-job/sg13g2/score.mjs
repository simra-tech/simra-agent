// Score a workspace of this layout-long-job task: the scorer of layout-block-fix (mode block-fix). The report also
// gives the job diagnostics of the transcript (background_runs, log_reads, deck_wall_s). See
// ../../layout-drc-fix/layout.mjs.
//
// Usage: node evals/layout-long-job/<pdk>/score.mjs <workspace>   (prints the score as JSON)

import { scoreLayout, scoreMain } from "../../layout-drc-fix/layout.mjs";

const here = new URL(".", import.meta.url).pathname;

export const score = (ws, _options, inside) => scoreLayout(ws, here, { mode: "block-fix", inside });

if (import.meta.url === `file://${process.argv[1]}`) await scoreMain(here, "block-fix", process.argv);
