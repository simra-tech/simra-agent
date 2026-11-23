// simra uninstall: removes what install.sh installed: the releases in SIMRA_HOME, the link ~/.local/bin/simra and the
// PATH block in the shell profile. The settings, logins and sessions in ~/.config/simra stay.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { connectorDir } from "@simra-tech/kernel";
import { installHome } from "./update.ts";

export function uninstall(args: string[]): number {
	if (args.length > 0) {
		console.error("usage: simra uninstall (to remove a pi package: simra remove <source>)");
		return 2;
	}
	const home = installHome();
	if (!home) {
		console.error(`simra uninstall: install.sh did not install ${realpathSync(process.execPath)} (no receipt.json).`);
		return 1;
	}
	const link = join(homedir(), ".local", "bin", "simra");
	if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(link);
	// The profiles that install.sh can change.
	const profiles = [
		join(process.env.ZDOTDIR || homedir(), ".zshrc"),
		join(homedir(), ".bashrc"),
		join(homedir(), ".bash_profile"),
		join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fish", "config.fish"),
	];
	for (const profile of profiles.filter((file) => existsSync(file))) {
		const text = readFileSync(profile, "utf8");
		// The block and the empty line before it; the lines around it stay separate lines.
		const changed = text.replace(/(^|\n)\n?# >>> simra >>>\n[^]*?# <<< simra <<<(?:\n|$)/g, "$1");
		if (changed === text) continue;
		writeFileSync(profile, changed);
		console.log(`removed the simra block from ${profile}`);
	}
	// install.sh's files and the connector bundle only: SIMRA_HOME may be a folder with other files.
	const data = dirname(dirname(connectorDir("adapters")));
	for (const dir of new Set([home, data])) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir).filter((n) => /^(releases|current|current\.new|receipt\.json|\.staging\..*|connectors|connectors\.new|\.?connectors-.*)$/.test(n))) {
			rmSync(join(dir, name), { recursive: true, force: true });
		}
		try {
			rmdirSync(dir);
		} catch {}
	}
	console.log(`removed simra from ${home} and ${link}. Settings, logins and sessions stay in ${process.env.SIMRA_CODING_AGENT_DIR}.`);
	return 0;
}
