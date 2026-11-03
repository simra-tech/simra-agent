// pi's codemode worker. pi starts it as "./src/extensions/codemode/worker.ts" in a Bun binary. build.ts gives this
// file as an entry, and Bun puts it at that path relative to main.ts.
import "../../../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/worker.js";
