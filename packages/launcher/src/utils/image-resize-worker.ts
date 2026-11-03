// pi's image resize worker. pi starts it as "./src/utils/image-resize-worker.ts" in a Bun binary. build.ts gives this
// file as an entry, and Bun puts it at that path relative to main.ts.
import "../../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/image-resize-worker.js";
