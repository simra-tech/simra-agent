// The simra binary. It does what pi's Bun entry (dist/bun/cli.js) does; pi does not export those modules, so they are
// imported by path (test/binary.test.mjs checks them). pi's own update would install pi, so update is simra's.

import "../../node_modules/@earendil-works/pi-coding-agent/dist/bun/sandbox-env-setup.js";
import "./env.ts";
import { telemetry } from "@simra-tech/kernel/telemetry";
import { KERNEL_COMMANDS, setPdfiumWasmPath } from "@simra-tech/kernel";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
// Bun embeds a file import in the binary and gives its path.
import pdfiumWasm from "@hyzyla/pdfium/pdfium.wasm" with { type: "file" };
import piPackage from "../../node_modules/@earendil-works/pi-coding-agent/package.json" with { type: "json" };
import simraPackage from "../../package.json" with { type: "json" };

/** simra --help prints this block, then pi's help. */
const COMMANDS = `Simra commands:
  simra run [--detach] <spec.json>  Run one experiment and record it
  simra wait <id>...                Wait for detached experiments
  simra jobs <jobs.json>            Run a list of experiments on a CPU pool and wait
  simra show <id> [--json]          Show the summary of an experiment
  simra list                        List the experiments of the design
  simra record [<path>...]          Show the checks of each file of record
  simra check                       Check the design against requirements.json
  simra assumptions [<id>]          List the assumptions of requirements.json and the rows that depend on them
  simra query                       Search the measurements of the experiments or the rows of the checks
  simra probe --pdk <name>          Probe each device class of a technology pack in ngspice and Xyce
  simra em <inputs.json>            EM S-parameters with openEMS, one job per port
  simra snp-diff <a.sNp> <b.sNp>    Compare two Touchstone files
  simra connections --table <file>  Check a connection table, and a block interface against it
  simra workarounds                 List the known gaps of the simulators and their workarounds
  simra pdf <file>                  Print the text of a PDF (--render <N>: a page image)
  simra pack init --pdk <name>      Propose a technology pack for a PDK (needs an adapter with pack_propose)
  simra pack check --pdk <name>     Check a technology pack against its PDK
  simra update                      Update simra (--extensions, --models: pi packages, model catalogs)
  simra uninstall                   Remove simra; settings and logins stay
  simra hosted [-p "prompt"]        Start a fresh Simra-funded, recorded session
  simra analytics <on|off|status>    Choose whether to share usage metadata
`;

setPdfiumWasmPath(pdfiumWasm);
telemetry.configure({ version: simraPackage.version });
const args = process.argv.slice(2);
if ((KERNEL_COMMANDS as readonly string[]).includes(args[0])) {
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
	try {
		if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
			const { firstRun, isFirstRun, askAnalyticsConsent } = await import("./first-run.ts");
			await askAnalyticsConsent(getAgentDir());
			if (isFirstRun(getAgentDir())) await firstRun(getAgentDir());
		}
		const hosted = args[0] === "hosted";
		if (hosted && !(args.length === 1 || (args.length === 3 && args[1] === "-p"))) {
			throw Error('Usage: simra hosted [-p "prompt"]. Hosted sessions always start fresh.');
		}
		const freshId = hosted ? randomUUID() : undefined;
		const piArgs = freshId ? ["--provider", "simra", "--model", "simra-hosted", "--session-id", freshId, ...(args.length === 3 ? ["-p", "--", args[2]] : [])] : args;
		await main(piArgs, { extensionFactories: [(pi) => simra(pi, freshId), updateNotice(VERSION, join(getAgentDir(), "update-check"))] });
	} finally {
		await telemetry.shutdown();
	}
}
