// simra --help: pi's help with Simra's description and commands. pi prints its help with one console.log call; this
// module changes that text. test/binary.test.mjs checks the result.

import { printHelp as printPiHelp } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js";

const COMMANDS = [
	["run <spec.json>", "Run one experiment and record it (--detach: in the background)"],
	["wait <id>...", "Wait for detached experiments"],
	["show <id> [--json]", "Show the summary of an experiment"],
	["list", "List the experiments of the design"],
	["record [<path>...]", "Show the checks of each file of record"],
	["check", "Check the design against requirements.json"],
	["pdf <file>", "Print the text of a PDF, or render a page (--render <N>)"],
	["update", "Update simra; --extensions or --models: pi packages or model catalogs"],
	["uninstall", "Remove simra; settings and logins stay"],
]
	.map(([command, text]) => `  ${`simra ${command}`.padEnd(32)}${text}\n`)
	.join("");

/** Simra's environment variables. pi's PI_PACKAGE_DIR, PI_TELEMETRY and PI_SELF_UPDATE_COMMAND do not apply: the launcher sets them or replaces pi update. */
const ENV = [
	["SIMRA_NO_UPDATE_CHECK", "Set to 1: no daily check for a new simra release"],
	["SIMRA_RELEASES_URL", "Releases page for simra update (default: https://github.com/simra-tech/simra-agent/releases)"],
]
	.map(([name, text]) => `  ${name.padEnd(32)} - ${text}\n`)
	.join("");

export function printHelp(): void {
	const log = console.log;
	console.log = (text: string) =>
		log(
			text
				.replace(" - AI coding assistant with read, bash, edit, write tools", " - a chip-design agent built on pi")
				.replace(/^ {2}simra (update|list|uninstall) .*\n/gm, "")
				.replace("/uninstall/update/list/", "/")
				.replace(/(Commands:\S*\n)/, `$1${COMMANDS}`)
				.replaceAll("~/.simra/agent", "~/.config/simra")
				.replace(/^ {2}PI_(PACKAGE_DIR|TELEMETRY|SELF_UPDATE_COMMAND) .*\n/gm, "")
				.replace(/^( {2}SIMRA_CODING_AGENT_SESSION_DIR .*\n)/m, `$1${ENV}`),
		);
	try {
		printPiHelp();
	} finally {
		console.log = log;
	}
}
