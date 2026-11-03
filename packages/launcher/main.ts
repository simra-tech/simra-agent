// The simra binary: the kernel CLI and pi with the Simra extension, in one file compiled with Bun (see build.ts).
// It does what pi's own Bun entry (dist/bun/cli.js) does. pi does not export those modules, so the launcher imports
// them by path from the pinned pi; test/binary.test.mjs checks that they exist.
//
// run, check, list, show, wait, record and pdf go to the kernel CLI. update is simra update (pi's own update would
// install pi); only "update --extensions" and "update --models" go to pi. uninstall removes simra (pi's uninstall is
// an alias of remove). All other arguments go to pi.

import "../../node_modules/@earendil-works/pi-coding-agent/dist/bun/sandbox-env-setup.js";
import "./env.ts";
import { setPdfiumWasmPath } from "@simra-tech/kernel";
import { join } from "node:path";
// Bun embeds a file import in the binary and gives its path.
import pdfiumWasm from "@hyzyla/pdfium/pdfium.wasm" with { type: "file" };
import piPackage from "../../node_modules/@earendil-works/pi-coding-agent/package.json" with { type: "json" };

const KERNEL_COMMANDS = ["run", "check", "list", "show", "wait", "record", "pdf"];
/** simra --help prints this block, then pi's help. */
const COMMANDS = `Simra commands:
  simra run [--detach] <spec.json>  Run one experiment and record it
  simra wait <id>...                Wait for detached experiments
  simra show <id> [--json]          Show the summary of an experiment
  simra list                        List the experiments of the design
  simra record [<path>...]          Show the checks of each file of record
  simra check                       Check the design against requirements.json
  simra pdf <file>                  Print the text of a PDF (--render <N>: a page image)
  simra update                      Update simra (--extensions, --models: pi packages, model catalogs)
  simra uninstall                   Remove simra; settings and logins stay
`;

setPdfiumWasmPath(pdfiumWasm);
const args = process.argv.slice(2);
if (KERNEL_COMMANDS.includes(args[0])) {
	await import("@simra-tech/kernel/cli");
} else if (args[0] === "update" && !(args.length === 2 && ["--extensions", "--models"].includes(args[1]))) {
	const { selfUpdate } = await import("./update.ts");
	process.exit(await selfUpdate(args.slice(1)).catch((e: Error) => (console.error(`simra update: ${e.message}`), 1)));
} else if (args[0] === "uninstall") {
	const { uninstall } = await import("./uninstall.ts");
	process.exit(uninstall(args.slice(1)));
} else {
	await import("../../node_modules/@earendil-works/pi-coding-agent/dist/bun/runtime-setup.js");
	const { setupCli } = await import("../../node_modules/@earendil-works/pi-coding-agent/dist/cli/setup.js");
	const { getAgentDir, main, VERSION } = await import("@earendil-works/pi-coding-agent");
	const { default: simra, setVersions } = await import("@simra-tech/pi-extension");
	const { updateNotice } = await import("./update.ts");
	setupCli();
	// pi's VERSION is the version of the release: pi reads the package.json next to the binary.
	setVersions(VERSION, piPackage.version);
	if (args[0] === "--help" || args[0] === "-h") console.log(COMMANDS);
	if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
		const { firstRun, isFirstRun } = await import("./first-run.ts");
		if (isFirstRun(getAgentDir())) await firstRun(getAgentDir());
	}
	await main(args, { extensionFactories: [simra, updateNotice(VERSION, join(getAgentDir(), "update-check.json"))] });
}
