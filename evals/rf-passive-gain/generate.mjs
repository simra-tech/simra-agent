// Write match.s2p, the Touchstone file of the task, from the closed form in network.mjs.
// Usage: node evals/rf-passive-gain/generate.mjs
import { writeFileSync } from "node:fs";
import { touchstoneText } from "./network.mjs";

writeFileSync(new URL("./match.s2p", import.meta.url), touchstoneText());
