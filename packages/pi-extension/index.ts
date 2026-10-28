// Simra Agent extension for pi.
// Stage 0: registers one command, /simra-version, so a test can prove that pi loads the extension.

import { readFileSync } from "node:fs";
import { type ExtensionAPI, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default function (pi: ExtensionAPI) {
	pi.registerCommand("simra-version", {
		description: "Show the Simra Agent and pi versions",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`simra-agent ${pkg.version} (pi ${PI_VERSION})`, "info");
		},
	});
}
