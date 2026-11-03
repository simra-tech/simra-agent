// simra uninstall: removes what install.sh installed: the releases in SIMRA_HOME, the link ~/.local/bin/simra and the
// PATH block in the shell profile. The settings, logins and sessions in ~/.config/simra stay.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

export function uninstall(args: string[]): number {
	if (args.length > 0) {
		console.error("usage: simra uninstall (to remove a pi package: simra remove <source>)");
		return 2;
	}
	// The binary is $SIMRA_HOME/releases/<version>/simra.
	const home = dirname(dirname(dirname(realpathSync(process.execPath))));
	if (!existsSync(join(home, "receipt.json"))) {
		console.error(`simra uninstall: ${home} has no receipt.json, so install.sh did not install this simra.`);
		return 1;
	}
	const link = join(homedir(), ".local", "bin", "simra");
	if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && realpathSync(link).startsWith(home + sep)) rmSync(link);
	// The profiles that install.sh can change.
	const profiles = [
		join(process.env.ZDOTDIR || homedir(), ".zshrc"),
		join(homedir(), ".bashrc"),
		join(homedir(), ".bash_profile"),
		join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fish", "config.fish"),
	];
	for (const profile of profiles.filter((file) => existsSync(file))) {
		const text = readFileSync(profile, "utf8");
		const changed = text.replace(/\n?# >>> simra >>>\n[^]*?# <<< simra <<<\n?/g, "");
		if (changed === text) continue;
		writeFileSync(profile, changed);
		console.log(`removed the simra block from ${profile}`);
	}
	// install.sh's files only: SIMRA_HOME may be a folder with other files.
	for (const name of readdirSync(home).filter((n) => /^(releases|current|current\.new|receipt\.json|\.staging\..*)$/.test(n))) {
		rmSync(join(home, name), { recursive: true, force: true });
	}
	try {
		rmdirSync(home);
	} catch {}
	console.log(`removed simra from ${home} and ${link}. Settings, logins and sessions stay in ${process.env.SIMRA_CODING_AGENT_DIR}.`);
	return 0;
}
