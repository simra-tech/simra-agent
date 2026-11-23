// simra update and the daily update notice. simra never updates itself.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { installConnectors, installedConnectors } from "../pi-extension/src/connectors.ts";
import { call, simraOAuth } from "../pi-extension/src/hosted.ts";

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

/**
 * simra update: the public release, then the connector bundle of a signed-in invited account. A connector failure does
 * not change the result of the release update. --connectors updates the connector bundle only.
 */
export async function selfUpdate(args: string[]): Promise<number> {
	const only = args.length === 1 && args[0] === "--connectors";
	if (args.length > 0 && !only) {
		console.error("usage: simra update [--connectors] | simra update --extensions | simra update --models");
		return 2;
	}
	const status = only ? 0 : await updateRelease().catch((error: Error) => (console.error(`simra update: ${error.message}`), 1));
	try {
		const message = await updateConnectors(only);
		if (message) console.error(`simra: ${message}`);
		return status;
	} catch (error) {
		// Quiet for a login without connectors: nothing is installed, so nothing is out of date.
		if (only || installedConnectors()) console.error(`simra: the connectors were not updated: ${(error as Error).message}`);
		return only ? 1 : status;
	}
}

/**
 * A valid access token of the stored Simra login, or undefined without one. An expired token is refreshed inside the
 * auth.json lock, and the rotated credential is written back, so a running session reads the new one.
 */
export async function connectorAccess(agentDir: string): Promise<string | undefined> {
	const path = join(agentDir, "auth.json");
	try {
		if (!JSON.parse(readFileSync(path, "utf8")).simra) return undefined;
	} catch {
		return undefined;
	}
	const credential = await AuthStorage.create(path).modify("simra", async (current) => {
		// Five minutes of validity left at least, as pi does: enough for the download.
		if (current?.type !== "oauth" || current.expires > Date.now() + 300_000) return undefined;
		return { ...(await simraOAuth.refreshToken(current, AbortSignal.timeout(20_000))), type: "oauth" };
	});
	return credential?.type === "oauth" ? simraOAuth.getApiKey(credential) : undefined;
}

/** The connector bundle of a login with the connector grant. The line for the user; without --connectors, undefined when there is nothing to say. */
async function updateConnectors(only: boolean): Promise<string | undefined> {
	const agentDir = process.env.SIMRA_CODING_AGENT_DIR;
	const access = agentDir ? await connectorAccess(agentDir) : undefined;
	if (!access) return only ? "no Simra login. Sign in with /login simra." : undefined;
	if ((await call("/grants", access)).connectors) return installConnectors(access);
	const installed = installedConnectors();
	if (installed) return `no connector grant: the installed Simra connectors ${installed} stay.`;
	return only ? "this Simra login has no connector grant." : undefined;
}

/** Run the latest install.sh, in the SIMRA_HOME of this installation. */
async function updateRelease(): Promise<number> {
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
