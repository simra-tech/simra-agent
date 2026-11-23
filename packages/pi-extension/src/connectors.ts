// The connector bundle of an invited account: adapters and technology packs from the Simra service, released apart
// from the public simra. <data>/simra/connectors is a link to connectors-<version>/, and an install replaces the link in
// one rename, so a failed download or unpack leaves the installed set as it was. The kernel searches the link.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { connectorDir } from "@simra-tech/kernel";
import { call, service } from "./hosted.ts";

/** <data>/simra/connectors: the link to the installed version. */
const link = () => dirname(connectorDir("adapters"));

/** The version of the installed bundle, or undefined. */
export function installedConnectors(): string | undefined {
	try {
		return JSON.parse(readFileSync(join(link(), "bundle.json"), "utf8")).version;
	} catch {
		return undefined;
	}
}

/** Install the bundle of the service when its version differs from the installed one. Gives the line for the user. */
export async function installConnectors(access: string, signal?: AbortSignal): Promise<string> {
	const offer = await call("/connectors", access, undefined, signal);
	const version = offer.version;
	if (typeof version !== "string" || !/^[\w.+-]+$/.test(version) || !/^[0-9a-f]{64}$/.test(offer.sha256)) {
		throw Error("The Simra service gave no valid connector bundle.");
	}
	if (installedConnectors() === version) return `Simra connectors ${version} are installed.`;
	const response = await fetch(`${service()}/connectors/bundle`, {
		headers: { Authorization: `Bearer ${access}` },
		redirect: "error",
		signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
	});
	if (!response.ok) throw Error(`Downloading the Simra connectors failed (HTTP ${response.status}).`);
	const data = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(data).digest("hex") !== offer.sha256) throw Error("The Simra connectors download is incomplete. Nothing changed.");
	const base = dirname(link());
	mkdirSync(base, { recursive: true });
	const stage = mkdtempSync(join(base, ".connectors-"));
	try {
		const tar = spawnSync("tar", ["-xzf", "-", "-C", stage], { input: data, encoding: "utf8" });
		if (tar.status !== 0) throw Error(`Unpacking the Simra connectors failed: ${tar.stderr.trim()}`);
		if (JSON.parse(readFileSync(join(stage, "bundle.json"), "utf8")).version !== version) throw Error("The Simra connectors bundle has another version. Nothing changed.");
		const name = `connectors-${version}`;
		const previous = existsSync(link()) ? readlinkSync(link()) : undefined;
		rmSync(join(base, name), { recursive: true, force: true });
		renameSync(stage, join(base, name));
		rmSync(join(base, "connectors.new"), { force: true });
		symlinkSync(name, join(base, "connectors.new"));
		renameSync(join(base, "connectors.new"), link());
		// Keep this version and the previous one: a running session may still use the previous one.
		for (const old of readdirSync(base).filter((n) => n.startsWith("connectors-") && n !== name && n !== previous)) {
			rmSync(join(base, old), { recursive: true, force: true });
		}
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	return `Installed Simra connectors ${version}.`;
}
