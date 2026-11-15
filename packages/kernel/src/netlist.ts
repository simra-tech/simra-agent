// Netlist rules of a design file, and the frequency band of fitted passive models. The kernel uses them for the
// gates "netlist" and "fit_band" of a check; the task scorers use the same functions, so the check of an agent and the
// score agree.
//
// Netlist rules (gates.netlist): the design file holds only .subckt blocks, .param lines and comments. The named block
// has the pins in order. An X line instantiates a device of the list, a given subcircuit (for example a line model,
// with limits on its parameters), a block of the file, or a fitted passive model (a block whose element lines are the
// output of a fit_to_spice record of the design root). An ideal R, L or C is a wiring model under the limits; K is a
// coupling between ideal L. No sources outside a fitted model. The instance parameters of a PDK device are the
// "allowed" ones of its class in the technology pack (instance_params); a parameter that changes the model physics
// (for example selft=0, dtemp, mm_ok) is an error unless the rules allow it by name. Values may be plain numbers with
// a SPICE suffix, or {expressions} of numbers and .param names.
//
// Fit band (gates.fit_band, on by default): a simulation that uses a fitted model at a frequency outside the band of
// use of its fit record (uses.band_hz or the harmonics), at DC when the fit is for AC only (uses.dc false), or in a
// noise analysis outside uses.noise_band_hz (or with a model that has no port noise) fails the gate.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const SUFFIX: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9, t: 1e12 };

/** A SPICE number with an optional scale suffix and unit letters, or NaN. */
export function spiceNumber(text: string): number {
	const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|[fpnumkgt])?[a-z]*$/i.exec(text.trim());
	return m ? Number(m[1]) * (m[2] ? SUFFIX[m[2].toLowerCase()] : 1) : Number.NaN;
}

/** A number, or {expression} of numbers, .param names, + - * / and parentheses; NaN when it cannot be evaluated. */
export function spiceValue(text: string | undefined, params: Record<string, number> = {}): number {
	if (text === undefined) return Number.NaN;
	const m = /^\{(.*)\}$/.exec(text.trim());
	if (!m) {
		const named = params[text.trim().toLowerCase()];
		return Number.isFinite(named) ? named : spiceNumber(text);
	}
	let bad = false;
	const expr = m[1].replace(/(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)(meg|[fpnumkgt])?(?![\w.])|([A-Za-z_]\w*)/gi, (_all, num, suffix, name) => {
		if (name !== undefined) {
			const v = params[String(name).toLowerCase()];
			if (!Number.isFinite(v)) bad = true;
			return `(${v})`;
		}
		return `(${spiceNumber(String(num) + (suffix ?? ""))})`;
	});
	if (bad || !/^[\d\s.eE+\-*/()]*$/.test(expr)) return Number.NaN;
	try {
		const v = Function(`"use strict"; return (${expr});`)();
		return typeof v === "number" ? v : Number.NaN;
	} catch {
		return Number.NaN;
	}
}

export interface LogicalLine {
	line: number;
	text: string;
}

/** The lines without comments, with "+" continuations joined; each keeps the number of its first line. */
export function logicalLines(text: string): LogicalLine[] {
	const out: LogicalLine[] = [];
	text.split("\n").forEach((raw, i) => {
		const l = raw.replace(/[;$].*$/, "").trim();
		if (!l || l.startsWith("*")) return;
		if (l.startsWith("+") && out.length) out[out.length - 1].text += ` ${l.slice(1).trim()}`;
		else out.push({ line: i + 1, text: l });
	});
	return out;
}

const fields = (l: string) => l.replace(/\s*=\s*/g, "=").split(/\s+/);

export interface Subckt {
	name: string;
	pins: string[];
	/** The element lines, normalised (fields joined by one space, lower case). */
	body: string[];
	line: number;
}

/** The subcircuits of a SPICE text by lower-case name. */
export function subcircuits(text: string): Map<string, Subckt> {
	const out = new Map<string, Subckt>();
	let current: Subckt | null = null;
	for (const { line, text: l } of logicalLines(text)) {
		const f = fields(l);
		const head = f[0].toLowerCase();
		if (head === ".subckt") {
			current = { name: (f[1] ?? "").toLowerCase(), pins: f.slice(2).filter((x) => !x.includes("=")).map((x) => x.toLowerCase()), body: [], line };
			out.set(current.name, current);
		} else if (head === ".ends") current = null;
		else if (current && !head.startsWith(".")) current.body.push(f.join(" ").toLowerCase());
	}
	return out;
}

/** The .param values of a text (one table for all scopes; a later line wins; a value may use earlier names). */
export function paramTable(text: string): Record<string, number> {
	const table: Record<string, number> = {};
	for (const { text: l } of logicalLines(text)) {
		if (!/^\.param\s/i.test(l)) continue;
		for (const m of l.slice(6).matchAll(/([A-Za-z_]\w*)\s*=\s*(\{[^}]*\}|\S+)/g)) {
			const v = spiceValue(m[2], table);
			if (Number.isFinite(v)) table[m[1].toLowerCase()] = v;
		}
	}
	return table;
}

// ------------------------------------------------------------------------------------------------- fitted models

export interface FitUses {
	band_hz?: [number, number];
	f0_hz?: number;
	harmonics?: number;
	dc?: boolean;
	noise_band_hz?: [number, number];
}

export interface FittedModel {
	/** The subcircuit name in the fit output. */
	name: string;
	body: string[];
	/** The fit_to_spice experiment. */
	fit: string;
	/** The openems experiment whose Touchstone output is the fit input, or null. */
	em: string | null;
	uses: FitUses;
	/** The frequency band of use: [low, high] in Hz. */
	band_hz: [number, number] | null;
	dc: boolean;
	noise_band_hz: [number, number] | null;
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * The fitted passive models of the records of a design root: each completed fit_to_spice record whose subcircuit file
 * is unchanged, with its band of use, and the openEMS record of its input (by SHA-256) when there is one.
 */
export function fittedModels(root: string): { found: FittedModel[]; refused: { fit: string; reason: string }[] } {
	const dir = join(root, "simra", "experiments");
	const found: FittedModel[] = [];
	const refused: { fit: string; reason: string }[] = [];
	if (!existsSync(dir)) return { found, refused };
	type Rec = { id: string; exp: { adapter?: { name?: string }; operation?: string; inputs?: Record<string, unknown> }; res: { status?: string; outputs?: { path: string; sha256?: string; role?: string }[]; input_files?: { files?: { sha256?: string }[] } | null } };
	const records: Rec[] = [];
	for (const id of readdirSync(dir).sort()) {
		const e = join(dir, id);
		if (!existsSync(join(e, "experiment.json")) || !existsSync(join(e, "result.json"))) continue;
		try {
			records.push({ id, exp: JSON.parse(readFileSync(join(e, "experiment.json"), "utf8")), res: JSON.parse(readFileSync(join(e, "result.json"), "utf8")) });
		} catch {
			// an unreadable record is not evidence
		}
	}
	const emHashes = new Map<string, string>();
	for (const r of records) {
		if (r.exp.adapter?.name !== "openems" || r.res.status !== "completed") continue;
		for (const o of r.res.outputs ?? []) if (o.role === "touchstone" && o.sha256) emHashes.set(o.sha256, r.id);
	}
	for (const r of records) {
		if (r.exp.adapter?.name !== "touchstone" || r.exp.operation !== "fit_to_spice") continue;
		if (r.res.status !== "completed") {
			refused.push({ fit: r.id, reason: `status ${r.res.status}` });
			continue;
		}
		const em = (r.res.input_files?.files ?? []).map((f) => (f.sha256 ? emHashes.get(f.sha256) : undefined)).find(Boolean) ?? null;
		const uses = ((r.exp.inputs ?? {}).uses ?? {}) as FitUses;
		let band: [number, number] | null = null;
		if (Array.isArray(uses.band_hz)) band = [uses.band_hz[0], uses.band_hz[1]];
		else if (typeof uses.f0_hz === "number") band = [uses.f0_hz, uses.f0_hz * (uses.harmonics ?? 1)];
		for (const o of r.res.outputs ?? []) {
			if (o.role !== "subckt") continue;
			const path = join(root, o.path);
			if (!existsSync(path) || (o.sha256 && sha256(path) !== o.sha256)) {
				refused.push({ fit: r.id, reason: `${o.path} is missing or changed` });
				continue;
			}
			for (const s of subcircuits(readFileSync(path, "utf8")).values())
				found.push({ name: s.name, body: s.body, fit: r.id, em, uses, band_hz: band, dc: uses.dc !== false, noise_band_hz: Array.isArray(uses.noise_band_hz) ? [uses.noise_band_hz[0], uses.noise_band_hz[1]] : null });
		}
	}
	return { found, refused };
}

/** The fitted model whose element lines equal those of the block, or null. */
export function matchFit(block: Subckt, fits: FittedModel[]): FittedModel | null {
	return fits.find((x) => x.body.length === block.body.length && x.body.every((b, i) => b === block.body[i])) ?? null;
}

// ------------------------------------------------------------------------------------------------- netlist rules

export interface NetlistRules {
	/** The design file, relative to the root. */
	file: string;
	subckt: string;
	pins: string[];
	/** The PDK devices that X lines may instantiate (subcircuit names, any case). */
	devices: string[];
	/** Given subcircuits (for example line models) with limits on their instance parameters. */
	given?: Record<string, { params?: Record<string, { min?: number; max?: number; required?: boolean }> }>;
	/** The largest value of one ideal element; an absent kind is not allowed. */
	wiring?: { r_ohm?: number; l_h?: number; c_f?: number };
	/** K couplings between ideal L (default true when wiring.l_h is given). */
	couplings?: boolean;
	/** Fitted passive models (fit_to_spice records of the root) are allowed. */
	fitted?: boolean;
	/** At least this many fitted models with an openEMS record must be used by the block (default 0). */
	em_passives_min?: number;
	/** Instance parameters that the rules allow beyond the pack, by device: {"npn13g2": ["selft"]}. */
	allow_params?: Record<string, string[]>;
	/** The technology pack (default the pack of $PDK); used for the instance parameters of the devices. */
	technology?: string;
}

export interface InstanceParamClass {
	devices: string[];
	allowed: string[];
	allowed_per_device?: Record<string, string[]>;
	physics?: Record<string, string>;
	source?: string;
}

export interface NetlistFinding {
	line: number | null;
	message: string;
}

export interface NetlistResult {
	errors: NetlistFinding[];
	/** The fitted models that the block uses (directly or through blocks of the file). */
	fitted_used: { subckt: string; fit: string; em: string | null }[];
}

/** Check the text of a design file against the rules. classes: instance_params classes of the pack. */
export function checkNetlist(text: string, rules: NetlistRules, opts: { classes?: Record<string, InstanceParamClass>; fits?: FittedModel[] } = {}): NetlistResult {
	const errors: NetlistFinding[] = [];
	const err = (line: number | null, message: string) => errors.push({ line, message });
	const subs = subcircuits(text);
	const params = paramTable(text);
	const devices = new Set(rules.devices.map((d) => d.toLowerCase()));
	const given = new Map(Object.entries(rules.given ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
	const fitted = new Map<string, FittedModel>();
	if (rules.fitted) for (const s of subs.values()) {
		const f = matchFit(s, opts.fits ?? []);
		if (f) fitted.set(s.name, f);
	}
	const classOf = (dev: string): InstanceParamClass | null => Object.values(opts.classes ?? {}).find((c) => c.devices.map((d) => d.toLowerCase()).includes(dev)) ?? null;
	const wiring = rules.wiring ?? {};
	const couplings = rules.couplings ?? wiring.l_h !== undefined;
	let current: string | null = null;
	for (const { line, text: l } of logicalLines(text)) {
		const f = fields(l);
		const head = f[0].toLowerCase();
		if (head === ".subckt") {
			current = (f[1] ?? "").toLowerCase();
			if (devices.has(current) || given.has(current)) err(line, `.subckt ${f[1]}: the name of a given device or subcircuit`);
			continue;
		}
		if (head === ".ends") {
			current = null;
			continue;
		}
		if (head.startsWith(".")) {
			if (![".param", ".end"].includes(head)) err(line, `${f[0]}: only .subckt, .ends, .param and .end lines are allowed`);
			continue;
		}
		if (!current) {
			err(line, `${f[0]}: an element outside a .subckt`);
			continue;
		}
		if (fitted.has(current)) continue;
		const kind = head[0];
		if ("vibefgh".includes(kind)) err(line, `${f[0]}: no sources in the design (block ${current} is not a fitted model of a fit_to_spice record)`);
		else if (kind === "r" || kind === "l" || kind === "c") {
			const max = { r: wiring.r_ohm, l: wiring.l_h, c: wiring.c_f }[kind];
			const v = spiceValue(f[3], params);
			if (max === undefined) err(line, `${f[0]}: an ideal ${kind.toUpperCase()} is not allowed`);
			else if (!(v > 0)) err(line, `${f[0]}: the value must be a positive number`);
			else if (v > max * (1 + 1e-9)) err(line, `${f[0]}: ideal ${kind.toUpperCase()} ${f[3]} is above ${max} (wiring models only)`);
		} else if (kind === "k") {
			if (!couplings) err(line, `${f[0]}: a coupling K is not allowed`);
			else if (!(Math.abs(spiceValue(f[3], params)) <= 1)) err(line, `${f[0]}: a coupling must be between -1 and 1`);
		} else if (kind === "x") {
			const plain = f.filter((x) => !x.includes("="));
			const name = plain.at(-1)?.toLowerCase() ?? "";
			const inst = Object.fromEntries(f.filter((x) => x.includes("=")).map((x) => [x.split("=")[0].toLowerCase(), x.slice(x.indexOf("=") + 1)]));
			if (devices.has(name)) {
				const cls = classOf(name);
				const allowed = new Set([...(cls?.allowed ?? []), ...(cls?.allowed_per_device?.[name] ?? []), ...(rules.allow_params?.[name] ?? []).map((x) => x.toLowerCase())]);
				for (const [p, v] of Object.entries(inst)) {
					if (cls && !allowed.has(p)) {
						const what = cls.physics?.[p];
						err(line, `${f[0]}: ${p}=${v} on ${name}: ${what ? `${what}; a parameter that changes the device physics` : "not an instance parameter that a design sets"} (allowed: ${[...allowed].join(", ")})`);
					} else if (!Number.isFinite(spiceValue(v, params))) err(line, `${f[0]}: ${p}=${v} is not a number or an expression of .param values`);
				}
			} else if (given.has(name)) {
				const spec = given.get(name)?.params ?? {};
				for (const [p, lim] of Object.entries(spec)) {
					const raw = inst[p.toLowerCase()];
					if (raw === undefined) {
						if (lim.required) err(line, `${f[0]}: ${name} needs ${p}=<value>`);
						continue;
					}
					const v = spiceValue(raw, params);
					if (!Number.isFinite(v) || (lim.min !== undefined && v < lim.min) || (lim.max !== undefined && v > lim.max * (1 + 1e-9)))
						err(line, `${f[0]}: ${name} needs ${p} from ${lim.min ?? "-inf"} to ${lim.max ?? "inf"}, got ${raw}`);
				}
			} else if (!subs.has(name)) err(line, `${f[0]}: ${name} is not a device of the rules, a given subcircuit or a block of the file`);
		} else err(line, `${f[0]}: element kind ${kind.toUpperCase()} is not allowed`);
	}
	const top = subs.get(rules.subckt.toLowerCase());
	if (!top) err(null, `no .subckt ${rules.subckt}`);
	else if (top.pins.join(" ") !== rules.pins.map((p) => p.toLowerCase()).join(" ")) err(top.line, `${rules.subckt} pins are "${top.pins.join(" ")}", expected "${rules.pins.join(" ")}"`);
	const used = new Set<string>();
	const walk = (name: string, seen: Set<string>) => {
		const s = subs.get(name);
		if (!s || seen.has(name)) return;
		seen.add(name);
		for (const b of s.body) {
			if (!b.startsWith("x")) continue;
			const child = b.split(" ").filter((x) => !x.includes("=")).at(-1) ?? "";
			if (fitted.has(child)) used.add(child);
			walk(child, seen);
		}
	};
	walk(rules.subckt.toLowerCase(), new Set());
	const fittedUsed = [...used].map((n) => ({ subckt: n, fit: (fitted.get(n) as FittedModel).fit, em: (fitted.get(n) as FittedModel).em }));
	const em = fittedUsed.filter((x) => x.em).length;
	if ((rules.em_passives_min ?? 0) > em)
		err(null, `the block uses ${em} EM passive(s); at least ${rules.em_passives_min} needed: a fit_to_spice output (copied unchanged) whose Touchstone input is an openEMS output`);
	return { errors, fitted_used: fittedUsed };
}

// ------------------------------------------------------------------------------------------------- fit band

/** A deck with its .include files of the root inlined (files outside the root, for example the PDK, stay out). */
export function inlineDeck(root: string, deck: string, seen = new Set<string>()): string {
	const path = isAbsolute(deck) ? deck : join(root, deck);
	if (seen.has(path) || !existsSync(path)) return "";
	seen.add(path);
	const out: string[] = [];
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		const m = /^\s*\.inc(?:lude)?\s+["']?([^"'\s]+)["']?/i.exec(raw);
		if (m && !m[1].includes("$")) {
			const inc = resolve(dirname(path), m[1]);
			if (!relative(resolve(root), inc).startsWith("..")) {
				out.push(inlineDeck(root, inc, seen));
				continue;
			}
		}
		out.push(raw);
	}
	return out.join("\n");
}

export interface Analysis {
	kind: "op" | "dc" | "ac" | "sp" | "noise" | "tran" | "other";
	f_hz: [number, number] | null;
	text: string;
}

/** The analyses of a deck (dot lines and .control commands). Each frequency analysis gives its sweep band. */
export function deckAnalyses(text: string): Analysis[] {
	const out: Analysis[] = [];
	const params = paramTable(text);
	for (const raw of text.split("\n")) {
		const l = raw.replace(/[;$].*$/, "").trim();
		const m = /^\.?(op|dc|ac|sp|noise|tran|pss|hb)\b(.*)$/i.exec(l);
		if (!m) continue;
		const kind = m[1].toLowerCase();
		const f = m[2].trim().split(/\s+/);
		if (kind === "ac" || kind === "sp" || kind === "noise") {
			const i = f.findIndex((x) => /^(lin|dec|oct)$/i.test(x));
			const a = i >= 0 ? spiceValue(f[i + 2], params) : Number.NaN;
			const b = i >= 0 ? spiceValue(f[i + 3], params) : Number.NaN;
			out.push({ kind, f_hz: Number.isFinite(a) && Number.isFinite(b) ? [Math.min(a, b), Math.max(a, b)] : null, text: l } as Analysis);
		} else out.push({ kind: (["op", "dc", "tran"].includes(kind) ? kind : "other") as Analysis["kind"], f_hz: null, text: l });
	}
	return out;
}

export interface FitBandFinding {
	subckt: string;
	fit: string;
	pass: boolean;
	reason: string;
}

/**
 * The fit-band check of one deck: each fitted model that the deck instantiates against each analysis of the deck.
 * Every analysis solves a DC point first, so a fit with uses.dc false fails in any deck. A transient analysis is not
 * checked (its spectrum is not a band); it is named in the reason.
 */
export function fitBandFindings(root: string, deck: string, fits: FittedModel[]): FitBandFinding[] {
	const text = inlineDeck(root, deck);
	const subs = subcircuits(text);
	const used = new Map<string, FittedModel>();
	for (const s of subs.values()) {
		const fm = matchFit(s, fits);
		if (fm) used.set(s.name, fm);
	}
	if (!used.size) return [];
	const analyses = deckAnalyses(text);
	const out: FitBandFinding[] = [];
	const tol = 1 + 1e-6;
	for (const [name, fm] of used) {
		const problems: string[] = [];
		const notes: string[] = [];
		if (!fm.dc && analyses.length) problems.push(`the fit is for AC only (uses.dc false), and every analysis solves a DC point`);
		for (const a of analyses) {
			if (a.kind === "tran") notes.push(`"${a.text}" not checked (a transient has no band)`);
			if (!["ac", "sp", "noise"].includes(a.kind)) continue;
			if (!a.f_hz) {
				problems.push(`"${a.text}": the sweep band cannot be read`);
				continue;
			}
			if (!fm.band_hz) problems.push(`"${a.text}": the fit record has no band of use`);
			else if (a.f_hz[0] < fm.band_hz[0] / tol || a.f_hz[1] > fm.band_hz[1] * tol)
				problems.push(`"${a.text}" sweeps ${a.f_hz[0]} Hz to ${a.f_hz[1]} Hz; the fit is for ${fm.band_hz[0]} Hz to ${fm.band_hz[1]} Hz (outside it the model is an extrapolation of the data): fit again with uses.band_hz that covers the sweep`);
			if (a.kind === "noise") {
				if (!fm.noise_band_hz) problems.push(`"${a.text}": the fitted model has no port noise (give uses.noise_band_hz to fit_to_spice), so the noise of the passive is left out`);
				else if (a.f_hz[0] < fm.noise_band_hz[0] / tol || a.f_hz[1] > fm.noise_band_hz[1] * tol)
					problems.push(`"${a.text}": the port noise of the fit is for ${fm.noise_band_hz[0]} Hz to ${fm.noise_band_hz[1]} Hz`);
			}
		}
		out.push({ subckt: name, fit: fm.fit, pass: problems.length === 0, reason: [...problems, ...notes].join("; ") || `in band (${fm.band_hz?.join(" Hz to ")} Hz${fm.noise_band_hz ? `, noise ${fm.noise_band_hz.join(" Hz to ")} Hz` : ""})` });
	}
	return out;
}
