// Workaround registry: the known gaps of a simulator (alone, or with a PDK) and the stated workaround, as data files
// workarounds/<simulator>/<pdk>.json (pdk "*" in the file any.json: gaps that do not depend on the PDK). The agent
// sees the entries of the simulators it uses (pi: the first result of each adapter in a session, and the tool
// workarounds; CLI: simra workarounds).

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { readJson } from "./records.ts";
import { BUILTIN_ADAPTER_DIR } from "./runner.ts";

export const WORKAROUNDS_SCHEMA = "simra.workarounds/0";
export const BUILTIN_WORKAROUND_DIR = join(dirname(BUILTIN_ADAPTER_DIR), "workarounds");
export const WORKAROUND_STATUS = ["worked_around", "proposed", "open"] as const;

export interface WorkaroundEntry {
	id: string;
	/** Where the gap applies: device classes of the device-class probe, analyses, adapter operations. */
	applies_to?: { device_classes?: string[]; analyses?: string[]; operations?: string[] };
	gap: string;
	symptom: string;
	workaround: string;
	/** worked_around: the workaround was used and checked; proposed: not yet used; open: no workaround. */
	status: (typeof WORKAROUND_STATUS)[number];
	evidence: string;
}

export interface Workaround extends WorkaroundEntry {
	simulator: string;
	pdk: string;
	versions: string;
	file: string;
}

/** Every entry of the registry directories (default: the built-in one). Throws on a malformed file or a repeated id. */
export function loadWorkarounds(dirs: string[] = [BUILTIN_WORKAROUND_DIR]): Workaround[] {
	const out: Workaround[] = [];
	const ids = new Set<string>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const sim of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
			for (const name of readdirSync(join(dir, sim)).filter((n) => n.endsWith(".json")).sort()) {
				const file = join(dir, sim, name);
				const doc = readJson<{ schema: string; simulator: string; pdk: string; versions: string; entries: WorkaroundEntry[] }>(file);
				const where = `${sim}/${name}`;
				if (doc.schema !== WORKAROUNDS_SCHEMA) throw new Error(`${where}: schema must be ${WORKAROUNDS_SCHEMA}`);
				if (doc.simulator !== sim) throw new Error(`${where}: simulator ${doc.simulator} does not match the directory`);
				if (doc.pdk !== (name === "any.json" ? "*" : name.slice(0, -5))) throw new Error(`${where}: pdk ${doc.pdk} does not match the file name`);
				if (typeof doc.versions !== "string" || !Array.isArray(doc.entries)) throw new Error(`${where}: versions and entries are required`);
				for (const e of doc.entries) {
					for (const k of ["id", "gap", "symptom", "workaround", "evidence"] as const) {
						if (typeof e[k] !== "string" || !e[k]) throw new Error(`${where}: entry ${e.id ?? "?"}: ${k} is required`);
					}
					if (!WORKAROUND_STATUS.includes(e.status)) throw new Error(`${where}: entry ${e.id}: status must be one of ${WORKAROUND_STATUS.join(", ")}`);
					if (ids.has(e.id)) throw new Error(`${where}: entry id ${e.id} is repeated`);
					ids.add(e.id);
					out.push({ ...e, simulator: doc.simulator, pdk: doc.pdk, versions: doc.versions, file: where });
				}
			}
		}
	}
	return out;
}

/** The entries for some simulators (default all) and a PDK: the PDK-independent ones, and those of that PDK. */
export function workaroundsFor(sel: { simulators?: string[]; pdk?: string | null }, all: Workaround[] = loadWorkarounds()): Workaround[] {
	return all.filter((w) => (!sel.simulators || sel.simulators.includes(w.simulator)) && (w.pdk === "*" || (sel.pdk != null && w.pdk === sel.pdk)));
}

/** The PDK of a run: inputs.pdk, else the PDK variable of the environment, else null. */
export function runPdk(root: string, environment?: string, inputs?: Record<string, unknown>): string | null {
	if (typeof inputs?.pdk === "string") return inputs.pdk;
	try {
		return loadConfig(root).environments[environment ?? "local"]?.env?.PDK ?? null;
	} catch {
		return null;
	}
}

export function formatWorkarounds(list: Workaround[], heading?: string): string {
	if (list.length === 0) return heading ? `${heading}: none in the registry` : "no entries";
	const lines = heading ? [heading] : [];
	for (const w of list) {
		const scope = [...new Set([...(w.applies_to?.device_classes ?? []), ...(w.applies_to?.analyses ?? []), ...(w.applies_to?.operations ?? [])])];
		lines.push(`- ${w.id} (${w.simulator}, ${w.pdk === "*" ? "any PDK" : w.pdk}; ${w.status})${scope.length ? ` [${scope.join(", ")}]` : ""}`);
		lines.push(`  gap: ${w.gap}`);
		lines.push(`  symptom: ${w.symptom}`);
		lines.push(`  workaround: ${w.workaround}`);
	}
	return lines.join("\n");
}
