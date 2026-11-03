// Updates of simra. simra never updates itself: simra update runs the install.sh of the latest release, and once a
// day an interactive session checks for a newer release and shows a notice.

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
export function newer(a: string, b: string): boolean {
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
 * An extension that shows "simra <v> is available: run simra update" at the start of an interactive session, when
 * the last check found a newer release. Once a day it checks again, in the background; the next start shows the
 * result. A failed check waits a day too. SIMRA_NO_UPDATE_CHECK=1 and pi's offline mode turn the check off.
 */
export function updateNotice(version: string, stateFile: string) {
	let done = false;
	return (pi: ExtensionAPI) => {
		// Once per process: a new session (/new) starts the event again.
		pi.on("session_start", (_event, ctx) => {
			if (done || !ctx.hasUI || process.env.SIMRA_NO_UPDATE_CHECK === "1" || process.env.PI_OFFLINE) return;
			done = true;
			let state: { checked_at?: string; latest?: string } = {};
			try {
				state = JSON.parse(readFileSync(stateFile, "utf8"));
			} catch {}
			if (state.latest && newer(state.latest, version)) ctx.ui.notify(`simra ${state.latest} is available: run simra update`, "info");
			if (Math.abs(Date.now() - Date.parse(state.checked_at ?? "")) < DAY_MS) return;
			const save = (latest = state.latest) => writeFileSync(stateFile, `${JSON.stringify({ checked_at: new Date().toISOString(), latest })}\n`);
			// The time of the check is saved first, so that a session that starts in the meantime does not check too.
			try {
				save();
			} catch {}
			latestRelease().then(save, () => {}).catch(() => {});
		});
	};
}

/**
 * simra update: download the install.sh of the latest release and run it. It installs the release next to this one:
 * SIMRA_HOME is the folder of this installation, unless the environment sets it.
 */
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
