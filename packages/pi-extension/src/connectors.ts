// The connector bundle of an invited account: adapters and technology packs from the Simra service, released apart
// from the public simra. <data>/simra/connectors is a link to a connectors-<version>-<id>/ folder, and an install replaces
// the link in one rename, so a failed download or unpack leaves the installed set as it was. The kernel searches the link.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
	const valid = (version: unknown): version is string => typeof version === "string" && /^[\w.+-]+$/.test(version);
	const offered = (await call("/connectors", access, undefined, signal)).version;
	if (!valid(offered)) throw Error("The Simra service gave no valid connector bundle.");
	if (installedConnectors() === offered) return `Simra connectors ${offered} are installed.`;
	const response = await fetch(`${service()}/connectors/bundle`, {
		headers: { Authorization: `Bearer ${access}` },
		redirect: "error",
		signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
	});
	if (!response.ok) throw Error(`Downloading the Simra connectors failed (HTTP ${response.status}).`);
	// The bytes carry their own version and digest: the service may have a newer release than the first answer named.
	const version = response.headers.get("x-simra-connectors-version");
	const sha256 = response.headers.get("x-simra-connectors-sha256");
	if (!valid(version) || !/^[0-9a-f]{64}$/.test(sha256 ?? "")) throw Error("The Simra service gave no valid connector bundle.");
	const data = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(data).digest("hex") !== sha256) throw Error("The Simra connectors download is incomplete. Nothing changed.");
	const base = dirname(link());
	mkdirSync(base, { recursive: true });
	const current = lstatSync(link(), { throwIfNoEntry: false });
	if (current && !current.isSymbolicLink()) throw Error(`${link()} is not the link that simra makes. Move it away, then run simra update --connectors.`);
	const previous = current ? readlinkSync(link()) : undefined;
	// A new folder per install: a concurrent install or a running session never sees its files change.
	const dir = mkdtempSync(join(base, `connectors-${version}-`));
	try {
		const tar = spawnSync("tar", ["-xzf", "-", "--no-same-owner", "-C", dir], { input: data, encoding: "utf8" });
		if (tar.status !== 0) throw Error(`Unpacking the Simra connectors failed: ${tar.error?.message ?? tar.stderr.trim()}`);
		if (JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")).version !== version) throw Error("The Simra connectors bundle has another version. Nothing changed.");
		const next = mkdtempSync(join(base, ".connectors-link-"));
		rmSync(next, { recursive: true });
		symlinkSync(basename(dir), next);
		renameSync(next, link());
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	// Keep this version and the previous one, which a running session may still use. Interrupted installs go too.
	for (const old of readdirSync(base).filter((n) => /^\.?connectors-/.test(n) && n !== basename(dir) && n !== previous)) {
		rmSync(join(base, old), { recursive: true, force: true });
	}
	return `Installed Simra connectors ${version}.`;
}
