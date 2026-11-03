// The simra binary: the kernel CLI and pi with the Simra extension, in one file compiled with Bun (see build.ts).
// It does what pi's own Bun entry (dist/bun/cli.js) does. pi does not export those modules, so this file imports them
// by path from the pinned pi; test/binary.test.mjs checks that they exist.

import "../../node_modules/@earendil-works/pi-coding-agent/dist/bun/sandbox-env-setup.js";
import "./env.ts";
import { setPdfiumWasmPath } from "@simra-tech/kernel";
// Bun embeds a file import in the binary and gives its path.
import pdfiumWasm from "@hyzyla/pdfium/pdfium.wasm" with { type: "file" };

/** The commands of the kernel CLI. pi gets all other arguments. */
const KERNEL_COMMANDS = ["run", "check", "list", "show", "wait", "record", "pdf"];

setPdfiumWasmPath(pdfiumWasm);
const args = process.argv.slice(2);
if (KERNEL_COMMANDS.includes(args[0])) {
	await import("@simra-tech/kernel/cli");
} else {
	await import("../../node_modules/@earendil-works/pi-coding-agent/dist/bun/runtime-setup.js");
	const { setupCli } = await import("../../node_modules/@earendil-works/pi-coding-agent/dist/cli/setup.js");
	const { main } = await import("@earendil-works/pi-coding-agent");
	const { default: simra } = await import("@simra-tech/pi-extension");
	setupCli();
	await main(args, { extensionFactories: [simra] });
}
