// Technology packs of a site: the lookup over the technology directories, and the flow that adds a PDK
// (`simra pack init`, `simra pack check`). The adapter inspects the kit (operation pack_propose) and checks a pack
// (operation pack_check). The kernel holds no PDK fact: it finds, records and writes packs.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { readJson } from "./records.ts";
import { BUILTIN_ADAPTER_DIR, findAdapter, runExperiment, technologySearchPath } from "./runner.ts";
import type { RunOutcome } from "./runner.ts";

export interface PackEntry {
	/** The pack name (key "name" of technology.json). */
	name: string;
	/** The PDK names of the pack (key "pdks"). */
	pdks: string[];
	/** The technology directory that holds the pack. */
	dir: string;
	/** The path of technology.json. */
	path: string;
}

/** Each pack of the directories, in search order. A directory that does not exist has no packs. */
export function listPacks(dirs: string[]): PackEntry[] {
	const out: PackEntry[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir).sort()) {
			const path = join(dir, entry, "technology.json");
			if (!existsSync(path)) continue;
			const pack = readJson<{ name?: string; pdks?: string[] }>(path);
			out.push({ name: pack.name ?? entry, pdks: pack.pdks ?? [], dir, path });
		}
	}
	return out;
}

/**
 * The pack with this name or PDK name. Two packs in different directories with the same pack name or a common PDK
 * name are ambiguous: the lookup is an error that names both paths, because the adapter would take the first one
 * without a word.
 */
export function findPack(dirs: string[], nameOrPdk: string): PackEntry {
	const packs = listPacks(dirs);
	const hits = packs.filter((p) => p.name === nameOrPdk || p.pdks.includes(nameOrPdk));
	if (hits.length === 0) {
		const known = packs.map((p) => `${p.name} (${p.pdks.join(", ")})`).join("; ") || "none";
		throw new Error(`no technology pack for "${nameOrPdk}" in ${dirs.join(", ") || "(no technology directory)"}; known: ${known}`);
	}
	const clash = packClashes(packs).find((c) => c.packs.some((p) => p.path === hits[0].path));
	if (clash || hits.length > 1) {
		const paths = clash ? clash.packs.map((p) => p.path) : hits.map((p) => p.path);
		throw new Error(`technology pack "${nameOrPdk}" is ambiguous: ${paths.join(" and ")}. Remove or rename one of them.`);
	}
	return hits[0];
}

/** Pairs of packs (in different files) that share a pack name or a PDK name. */
export function packClashes(packs: PackEntry[]): { key: string; packs: PackEntry[] }[] {
	const out: { key: string; packs: PackEntry[] }[] = [];
	for (let i = 0; i < packs.length; i++) {
		for (let j = i + 1; j < packs.length; j++) {
			const a = packs[i];
			const b = packs[j];
			const common = a.name === b.name ? a.name : a.pdks.find((p) => b.pdks.includes(p));
			if (common) out.push({ key: common, packs: [a, b] });
		}
	}
	return out;
}

/** The technology directories of a design: technology_dirs of the configuration, then the built-in one. */
export function designTechnologyDirs(root: string): string[] {
	return technologySearchPath(loadConfig(root).technology_dirs ?? []);
}

/** The directory for a new pack: the first entry of technology_dirs, else the per-user data directory. */
export function defaultPackDir(root: string): { dir: string; configured: boolean } {
	const configured = loadConfig(root).technology_dirs ?? [];
	if (configured.length) return { dir: configured[0], configured: true };
	const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return { dir: join(data, "simra", "technologies"), configured: false };
}

/** The adapters of the design that have the operation. */
export function adaptersWith(root: string, operation: string): string[] {
	const dirs = [...(loadConfig(root).adapter_dirs ?? []), BUILTIN_ADAPTER_DIR];
	const names = new Set<string>();
	for (const base of dirs) {
		if (!existsSync(base)) continue;
		for (const name of readdirSync(base)) {
			try {
				if (findAdapter(name, [base]).manifest.operations[operation]) names.add(name);
			} catch {
				// not an adapter
			}
		}
	}
	return [...names].sort();
}

function pickAdapter(root: string, operation: string, adapter?: string): string {
	if (adapter) return adapter;
	const found = adaptersWith(root, operation);
	if (found.length === 1) return found[0];
	throw new Error(
		found.length
			? `several adapters have the operation ${operation} (${found.join(", ")}); give --adapter`
			: `no adapter of this design has the operation ${operation}; give --adapter`,
	);
}

export interface PackInitOptions {
	root: string;
	adapter?: string;
	pdk: string;
	pdkRoot?: string;
	/** The technology directory for the pack; default defaultPackDir(root). */
	dir?: string;
	/** Extra inputs of pack_propose (for example vdd_v, corners, read_inside). */
	inputs?: Record<string, unknown>;
	/** Write the proposed pack. Without it, the flow only proposes. */
	write?: boolean;
	timeoutS?: number;
}

export interface PackInitOutcome {
	run: RunOutcome;
	/** The proposed pack, or null when the adapter proposed none. */
	pack: Record<string, unknown> | null;
	questions: string[];
	/** The path of the pack file to write. */
	target: string;
	/** True when the flow wrote the file. */
	written: boolean;
	/** True when the target directory is not in technology_dirs (the user must add it). */
	outsideConfig: boolean;
	/** Another pack with the same PDK name in the search path, or null. */
	clash: PackEntry | null;
}

/**
 * Run the adapter operation pack_propose (a normal experiment record) and write the proposed pack into
 * <dir>/<pdk>/technology.json, only with write. An existing pack file is never overwritten.
 */
export async function packInit(opts: PackInitOptions): Promise<PackInitOutcome> {
	const root = resolve(opts.root);
	const adapter = pickAdapter(root, "pack_propose", opts.adapter);
	if (!/^[\w.+-]+$/.test(opts.pdk)) throw new Error(`--pdk: a PDK name has letters, digits, ".", "_", "+" or "-" only: ${opts.pdk}`);
	const inputs: Record<string, unknown> = { ...(opts.inputs ?? {}), pdk: opts.pdk };
	if (opts.pdkRoot) inputs.pdk_root = resolve(opts.pdkRoot);
	const run = await runExperiment({
		root,
		adapter,
		operation: "pack_propose",
		inputs,
		purpose: `propose a technology pack for PDK ${opts.pdk}`,
		timeoutS: opts.timeoutS ?? 1800,
	});
	const tool = (run.result.tool ?? {}) as { pack?: Record<string, unknown>; questions?: string[] };
	const pack = run.result.status === "completed" && tool.pack ? tool.pack : null;
	const fallback = defaultPackDir(root);
	const dir = opts.dir ? resolve(opts.dir) : fallback.dir;
	const target = join(dir, opts.pdk, "technology.json");
	const searched = designTechnologyDirs(root);
	const clash = listPacks(searched).find((p) => p.path !== target && (p.pdks.includes(opts.pdk) || p.name === pack?.name)) ?? null;
	const outcome: PackInitOutcome = { run, pack, questions: tool.questions ?? [], target, written: false, outsideConfig: !searched.includes(dir), clash };
	return opts.write && pack ? { ...outcome, ...writeProposed(outcome) } : outcome;
}

/**
 * Write the proposed pack of a packInit outcome to its target. An existing file is never overwritten, and a second
 * pack for the same PDK in the search path is an error (the lookup would be ambiguous).
 */
export function writeProposed(o: PackInitOutcome): { written: true } {
	if (!o.pack) throw new Error("no pack was proposed");
	if (existsSync(o.target)) throw new Error(`the pack file exists: ${o.target}. Remove it first, or give another --dir`);
	if (o.clash) throw new Error(`a pack for this PDK exists already: ${o.clash.path}. Two packs for one PDK are ambiguous`);
	mkdirSync(dirname(o.target), { recursive: true });
	writeFileSync(o.target, `${JSON.stringify(o.pack, null, 2)}\n`);
	return { written: true };
}

/** The text of the outcome of packInit: the report of the adapter, the open questions, what was written. */
export function formatPackInit(o: PackInitOutcome): string {
	const lines = [`experiment ${o.run.id}: pack_propose ${o.run.result.status}`];
	for (const line of o.run.result.report ?? []) lines.push(line);
	for (const d of o.run.result.diagnostics ?? []) if (d.severity === "error") lines.push(`error: ${d.message}`);
	for (const e of o.run.result.errors ?? []) lines.push(`error: ${e}`);
	if (!o.pack) {
		lines.push("no pack proposed");
		return lines.join("\n");
	}
	if (o.questions.length) lines.push(`answer these questions before you use the pack (${o.questions.length}):`);
	o.questions.forEach((q, i) => lines.push(`  ${i + 1}. ${q}`));
	if (o.clash) lines.push(`warning: a pack for this PDK exists already: ${o.clash.path}`);
	if (o.written) {
		lines.push(`wrote ${o.target}`);
		if (o.outsideConfig) lines.push(`add ${resolve(o.target, "..", "..")} to technology_dirs of simra.config.json or simra.local.json`);
		lines.push("next: simra pack check --pdk <name>");
	} else {
		lines.push(`not written. To write it to ${o.target}, run the command again with --write`);
	}
	return lines.join("\n");
}

export interface PackCheckOptions {
	root: string;
	adapter?: string;
	pdk: string;
	inputs?: Record<string, unknown>;
	timeoutS?: number;
}

export interface PackCheckItem {
	name: string;
	status: "pass" | "fail" | "not run";
	class?: string;
	reason?: string;
	value?: number;
}

/** Find the pack of the PDK (an ambiguous pack is an error), then run the adapter operation pack_check on it. */
export async function packCheck(opts: PackCheckOptions): Promise<{ run: RunOutcome; pack: PackEntry; items: PackCheckItem[] }> {
	const root = resolve(opts.root);
	const pack = findPack(designTechnologyDirs(root), opts.pdk);
	const adapter = pickAdapter(root, "pack_check", opts.adapter);
	const pdk = pack.pdks.includes(opts.pdk) ? opts.pdk : pack.pdks[0];
	const run = await runExperiment({
		root,
		adapter,
		operation: "pack_check",
		// The pack file is an input: the record names the directory that the pack came from.
		inputs: { ...(opts.inputs ?? {}), pack: pack.path, pdk },
		purpose: `check the technology pack ${pack.name}`,
		timeoutS: opts.timeoutS ?? 3600,
	});
	const tool = (run.result.tool ?? {}) as { check?: { items?: PackCheckItem[] } };
	return { run, pack, items: tool.check?.items ?? [] };
}

export function formatPackCheck(o: { run: RunOutcome; pack: PackEntry; items: PackCheckItem[] }): string {
	const lines = [`experiment ${o.run.id}: pack_check ${o.run.result.status}`, `pack ${o.pack.name} from ${o.pack.dir}`];
	for (const i of o.items) {
		const value = i.value === undefined || i.value === null ? "" : ` (${i.value})`;
		const why = i.status === "fail" ? ` (${i.class ?? "unknown"})${i.reason ? `: ${i.reason}` : ""}` : i.reason ? `: ${i.reason}` : "";
		lines.push(`  ${i.name}: ${i.status}${value}${why}`);
	}
	if (!o.items.length) lines.push("  no check items in the response");
	for (const e of o.run.result.errors ?? []) lines.push(`error: ${e}`);
	return lines.join("\n");
}

/** Read a pack file (for a test or a tool). */
export function readPack(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8"));
}
