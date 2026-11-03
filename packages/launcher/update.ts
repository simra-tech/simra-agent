// simra update and the daily update notice. simra never updates itself.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The releases page. The tests replace it with SIMRA_RELEASES_URL. */
const releases = () => (process.env.SIMRA_RELEASES_URL || "https://github.com/simra-tech/simra-agent/releases").replace(/\/+$/, "");
const DAY_MS = 24 * 3600 * 1000;

/** The SIMRA_HOME of this binary, when install.sh installed it: <home>/releases/<version>/simra, and <home>/receipt.json. */
export function installHome(): string | undefined {
	const home = dirname(dirname(dirname(realpathSync(process.execPath))));
	return existsSync(join(home, "receipt.json")) ? home : undefined;
}

/** true when version a (x.y.z) is newer than version b. */
function newer(a: string, b: string): boolean {
	const [x, y] = [a, b].map((v) => v.split(/[.-]/).slice(0, 3).map(Number));
	const i = x.findIndex((n, k) => n !== y[k]);
	return i !== -1 && x[i] > y[i];
}

/** The version of the latest release: GitHub answers <releases>/latest with a redirect to <releases>/tag/v<version>. */
async function latestRelease(): Promise<string> {
	const response = await fetch(`${releases()}/latest`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
	const version = /\/tag\/v([^/?#]+)$/.exec(response.headers.get("location") ?? "")?.[1];
	if (!version) throw new Error(`no release in the answer of ${releases()}/latest (HTTP ${response.status})`);
	return version;
}

/**
 * Once a day, an interactive session checks for a newer release and shows "simra <v> is available: run simra update".
 * stateFile has the time of the last check. SIMRA_NO_UPDATE_CHECK=1 and pi's offline mode turn the check off.
 */
export function updateNotice(version: string, stateFile: string) {
	return (pi: ExtensionAPI) => {
		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI || process.env.SIMRA_NO_UPDATE_CHECK === "1" || process.env.PI_OFFLINE) return;
			let checked = Number.NaN;
			try {
				checked = Date.parse(readFileSync(stateFile, "utf8"));
			} catch {}
			if (Math.abs(Date.now() - checked) < DAY_MS) return;
			try {
				writeFileSync(stateFile, new Date().toISOString());
			} catch {}
			latestRelease()
				.then((latest) => newer(latest, version) && ctx.ui.notify(`simra ${latest} is available: run simra update`, "info"))
				.catch(() => {});
		});
	};
}

/** simra update: run the latest install.sh, in the SIMRA_HOME of this installation. */
export async function selfUpdate(args: string[]): Promise<number> {
	if (args.length > 0) {
		console.error("usage: simra update | simra update --extensions | simra update --models");
		return 2;
	}
	const url = `${releases()}/latest/download/install.sh`;
	const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	const dir = mkdtempSync(join(tmpdir(), "simra-update-"));
	try {
		writeFileSync(join(dir, "install.sh"), await response.text());
		const home = process.env.SIMRA_HOME || installHome();
		const env = home ? { ...process.env, SIMRA_HOME: home } : process.env;
		return spawnSync("sh", [join(dir, "install.sh")], { stdio: "inherit", env }).status ?? 1;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
