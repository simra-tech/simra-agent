// Connection table and its gate. The connection table (schema simra.connections/0) is the machine-readable interface of
// a chip: for each block its pins, the net of each pin, the supply of each supply pin, the value of each bias need
// (current or voltage, tolerance, temperature behaviour, provider) and the encoding of each control. It exists before
// the block work. Each block keeps a block interface record (schema simra.block_interface/0): its netlist and
// subcircuit, and the supplies, bias values and control encodings that its own simulations used. The gate compares the
// record with the table, one row per item; a block without a record cannot pass.
//
// The table check (checkTable) finds the problems of the table itself: a bias need without a provider, a provider that
// is not a pin of the table, a control pin without a control definition, a supply pin on a net that is not a supply, a
// bias output on a net that no other pin uses.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const CONNECTIONS_SCHEMA = "simra.connections/0";
export const BLOCK_INTERFACE_SCHEMA = "simra.block_interface/0";

export type PinKind = "supply" | "ground" | "bias" | "bias_out" | "control" | "signal";
export const PIN_KINDS: PinKind[] = ["supply", "ground", "bias", "bias_out", "control", "signal"];
export type Tc = "constant" | "ptat" | "ctat";

export interface TablePin {
	net: string;
	kind: PinKind;
	/** bias: the value at 27 C (one of current_a and voltage_v) and the tolerance (relative or absolute). */
	current_a?: number;
	voltage_v?: number;
	tolerance_rel?: number;
	tolerance_abs?: number;
	tc?: Tc;
	/** bias: the pin that gives it, "<block>.<pin>" (a pin of kind bias_out on the same net). */
	provider?: string;
	/** control: the name of the control in "controls". */
	control?: string;
}

export interface Control {
	bits: number;
	encoding: "binary" | "thermometer" | "one_hot" | "gray";
	/** 1-bit controls: the level that enables. */
	active?: "high" | "low";
	reset: number;
	/** The logic level (a supply name), for example "vcc33". */
	level?: string;
}

export interface ConnectionTable {
	schema: typeof CONNECTIONS_SCHEMA;
	supplies: Record<string, { volts: number; tolerance_rel?: number }>;
	blocks: Record<string, { subckt?: string; pins: Record<string, TablePin> }>;
	controls?: Record<string, Control>;
}

export interface BlockInterface {
	schema: typeof BLOCK_INTERFACE_SCHEMA;
	block: string;
	/** The netlist of record and its subcircuit; the gate reads the pin list from the .subckt line. */
	netlist?: { path: string; subckt: string };
	/** The pins, when there is no netlist yet. */
	pins?: string[];
	/** The supply voltage of each supply pin in the block's own simulations. */
	supplies?: Record<string, number>;
	/** The bias that the block's own simulations used, per pin. */
	bias?: Record<string, { current_a?: number; voltage_v?: number; tc?: Tc }>;
	/** The control encodings that the block decodes, per pin. */
	controls?: Record<string, { bits: number; encoding: Control["encoding"]; active?: "high" | "low"; reset?: number }>;
}

export interface ConnectionRow {
	item: string;
	status: "pass" | "fail" | "not_run";
	expected: number | [number, number] | string | null;
	got: number | string | null;
	unit: string | null;
	reason: string | null;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** A number for a message: six significant digits. */
const g = (v: number | undefined) => (v === undefined ? "?" : String(Number(v.toPrecision(6))));

function readJsonFile<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Validate a connection table. Returns the error messages (empty when valid). */
export function validateTable(t: ConnectionTable): string[] {
	const errors: string[] = [];
	if (t?.schema !== CONNECTIONS_SCHEMA) return [`schema must be ${CONNECTIONS_SCHEMA}`];
	if (!t.supplies || typeof t.supplies !== "object") errors.push("supplies is required");
	if (!t.blocks || typeof t.blocks !== "object") return [...errors, "blocks is required"];
	for (const [name, s] of Object.entries(t.supplies ?? {})) if (!isNumber(s?.volts)) errors.push(`supplies.${name}: volts must be a number`);
	for (const [b, block] of Object.entries(t.blocks)) {
		for (const [p, pin] of Object.entries(block.pins ?? {})) {
			const at = `blocks.${b}.pins.${p}`;
			if (typeof pin.net !== "string" || !pin.net) errors.push(`${at}: net is required`);
			if (!PIN_KINDS.includes(pin.kind)) errors.push(`${at}: kind must be one of ${PIN_KINDS.join(", ")}`);
			if (pin.kind === "bias" || pin.kind === "bias_out") {
				if (isNumber(pin.current_a) === isNumber(pin.voltage_v)) errors.push(`${at}: give one of current_a and voltage_v`);
				if (pin.kind === "bias" && !isNumber(pin.tolerance_rel) && !isNumber(pin.tolerance_abs)) errors.push(`${at}: tolerance_rel or tolerance_abs is required`);
			}
			if (pin.kind === "control" && typeof pin.control !== "string") errors.push(`${at}: control (a name in controls) is required`);
		}
	}
	for (const [c, ctl] of Object.entries(t.controls ?? {})) {
		if (!Number.isInteger(ctl.bits) || ctl.bits < 1) errors.push(`controls.${c}: bits must be an integer >= 1`);
		if (!["binary", "thermometer", "one_hot", "gray"].includes(ctl.encoding)) errors.push(`controls.${c}: encoding must be binary, thermometer, one_hot or gray`);
		if (!Number.isInteger(ctl.reset)) errors.push(`controls.${c}: reset must be an integer`);
	}
	return errors;
}

export function loadConnectionTable(path: string): ConnectionTable {
	const t = readJsonFile<ConnectionTable>(path);
	const errors = validateTable(t);
	if (errors.length) throw new Error(`${path}: ${errors.join("; ")}`);
	return t;
}

/** The problems of the table itself (rows with item "table ..."). */
export function checkTable(t: ConnectionTable): ConnectionRow[] {
	const rows: ConnectionRow[] = [];
	const fail = (item: string, reason: string) => rows.push({ item, status: "fail", expected: null, got: null, unit: null, reason });
	const onNet = new Map<string, number>();
	for (const block of Object.values(t.blocks)) for (const pin of Object.values(block.pins)) onNet.set(pin.net, (onNet.get(pin.net) ?? 0) + 1);
	for (const [b, block] of Object.entries(t.blocks)) {
		for (const [p, pin] of Object.entries(block.pins)) {
			const at = `table ${b}.${p}`;
			if (pin.kind === "supply" && !t.supplies[pin.net]) fail(at, `supply pin on net ${pin.net}, which is not a supply`);
			if (pin.kind === "control" && pin.control && !t.controls?.[pin.control]) fail(at, `control ${pin.control} is not defined in controls`);
			if (pin.kind === "bias_out" && (onNet.get(pin.net) ?? 0) < 2) fail(at, `bias output on net ${pin.net} has no consumer`);
			if (pin.kind === "bias") {
				if (!pin.provider) {
					fail(at, `bias need on net ${pin.net} has no provider`);
					continue;
				}
				const [pb, pp] = pin.provider.split(".");
				const prov = t.blocks[pb]?.pins[pp];
				if (!prov) fail(at, `provider ${pin.provider} is not a pin of the table`);
				else if (prov.kind !== "bias_out") fail(at, `provider ${pin.provider} is a ${prov.kind} pin, not bias_out`);
				else if (prov.net !== pin.net) fail(at, `provider ${pin.provider} is on net ${prov.net}, the need on net ${pin.net}`);
				else {
					const need = pin.current_a ?? pin.voltage_v;
					const give = prov.current_a ?? prov.voltage_v;
					const tol = pin.tolerance_abs ?? Math.abs(need as number) * (pin.tolerance_rel ?? 0);
					if (isNumber(pin.current_a) !== isNumber(prov.current_a)) fail(at, `the need is a ${isNumber(pin.current_a) ? "current" : "voltage"}, the provider gives a ${isNumber(prov.current_a) ? "current" : "voltage"}`);
					else if (Math.abs((give as number) - (need as number)) > tol) fail(at, `provider ${pin.provider} gives ${g(give)}, the need is ${g(need)} +- ${g(tol)}`);
					else if (pin.tc && prov.tc && pin.tc !== prov.tc) fail(at, `provider ${pin.provider} is ${prov.tc}, the need is ${pin.tc}`);
				}
			}
		}
	}
	return rows;
}

/** The pin names of a .subckt in a SPICE file (continuation lines with +; parameters name=value are left out). */
export function subcktPins(path: string, subckt: string): string[] {
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	const joined: string[] = [];
	for (const l of lines) {
		if (/^\s*\+/.test(l) && joined.length) joined[joined.length - 1] += ` ${l.replace(/^\s*\+/, "")}`;
		else joined.push(l);
	}
	for (const l of joined) {
		const tok = l.trim().split(/\s+/);
		if (tok[0]?.toLowerCase() === ".subckt" && tok[1]?.toLowerCase() === subckt.toLowerCase()) {
			const pins: string[] = [];
			for (const x of tok.slice(2)) {
				if (/^params:$/i.test(x) || x.includes("=")) break;
				pins.push(x);
			}
			return pins;
		}
	}
	throw new Error(`${path}: no .subckt ${subckt}`);
}

/** Compare a block interface record with the connection table: one row per pin set, supply, bias need and control. */
export function checkBlock(t: ConnectionTable, iface: BlockInterface, root = "."): ConnectionRow[] {
	const rows: ConnectionRow[] = [];
	const add = (item: string, ok: boolean, expected: ConnectionRow["expected"], got: ConnectionRow["got"], unit: string | null, reason: string | null) =>
		rows.push({ item, status: ok ? "pass" : "fail", expected, got, unit, reason: ok ? null : reason });
	const block = t.blocks[iface.block];
	if (!block) return [{ item: `block ${iface.block}`, status: "fail", expected: null, got: null, unit: null, reason: `block ${iface.block} is not in the connection table` }];
	let pins: string[] | null = iface.pins ?? null;
	if (iface.netlist) {
		const path = isAbsolute(iface.netlist.path) ? iface.netlist.path : join(root, iface.netlist.path);
		if (!existsSync(path)) rows.push({ item: "pins", status: "not_run", expected: null, got: null, unit: null, reason: `netlist ${iface.netlist.path} not found` });
		else {
			pins = subcktPins(path, iface.netlist.subckt);
			if (block.subckt) add("subckt", block.subckt.toLowerCase() === iface.netlist.subckt.toLowerCase(), block.subckt, iface.netlist.subckt, null, "the subcircuit name differs");
		}
	}
	if (pins) {
		const want = Object.keys(block.pins);
		const lower = new Set(pins.map((p) => p.toLowerCase()));
		const wantLower = new Set(want.map((p) => p.toLowerCase()));
		for (const p of want) add(`pin ${p}`, lower.has(p.toLowerCase()), "present", lower.has(p.toLowerCase()) ? "present" : "missing", null, `pin ${p} of the table is not a pin of the block`);
		for (const p of pins) if (!wantLower.has(p.toLowerCase())) add(`pin ${p}`, false, "absent", "present", null, `pin ${p} of the block is not in the connection table`);
	} else if (!rows.length) {
		rows.push({ item: "pins", status: "not_run", expected: null, got: null, unit: null, reason: "the block interface record has no netlist and no pins" });
	}
	for (const [p, pin] of Object.entries(block.pins)) {
		if (pin.kind === "supply") {
			const want = t.supplies[pin.net]?.volts;
			const got = iface.supplies?.[p];
			const tol = Math.abs(want ?? 0) * (t.supplies[pin.net]?.tolerance_rel ?? 1e-6);
			if (!isNumber(got)) rows.push({ item: `supply ${p}`, status: "not_run", expected: want ?? null, got: null, unit: "V", reason: `the record has no supply voltage for pin ${p}` });
			else add(`supply ${p}`, isNumber(want) && Math.abs(got - want) <= tol, want ?? null, got, "V", `the block was simulated at ${got} V, the net ${pin.net} is ${want} V`);
		}
		if (pin.kind === "bias") {
			const current = isNumber(pin.current_a);
			const want = (current ? pin.current_a : pin.voltage_v) as number;
			const tol = pin.tolerance_abs ?? Math.abs(want) * (pin.tolerance_rel ?? 0);
			const rec = iface.bias?.[p];
			const got = current ? rec?.current_a : rec?.voltage_v;
			const unit = current ? "A" : "V";
			if (!isNumber(got)) {
				rows.push({ item: `bias ${p}`, status: "not_run", expected: [want - tol, want + tol], got: null, unit, reason: `the record has no ${current ? "current" : "voltage"} for bias pin ${p}` });
				continue;
			}
			add(`bias ${p}`, Math.abs(got - want) <= tol, [Number((want - tol).toPrecision(12)), Number((want + tol).toPrecision(12))], got, unit, `the block used ${g(got)} ${unit}; the table gives ${g(want)} ${unit} +- ${g(tol)}`);
			if (pin.tc && !rec?.tc) rows.push({ item: `bias ${p} tc`, status: "not_run", expected: pin.tc, got: null, unit: null, reason: `the record states no temperature behaviour for bias pin ${p}` });
			else if (pin.tc) add(`bias ${p} tc`, rec?.tc === pin.tc, pin.tc, rec?.tc ?? null, null, `the block used ${rec?.tc} temperature behaviour; the table gives ${pin.tc}`);
		}
		if (pin.kind === "control" && pin.control) {
			const ctl = t.controls?.[pin.control];
			const rec = iface.controls?.[p];
			if (!ctl) continue;
			if (!rec) {
				rows.push({ item: `control ${p}`, status: "not_run", expected: `${ctl.bits} bit ${ctl.encoding}`, got: null, unit: null, reason: `the record has no encoding for control pin ${p}` });
				continue;
			}
			add(`control ${p} bits`, rec.bits === ctl.bits, ctl.bits, rec.bits, null, `the block decodes ${rec.bits} bits; control ${pin.control} has ${ctl.bits}`);
			add(`control ${p} encoding`, rec.encoding === ctl.encoding, ctl.encoding, rec.encoding, null, `the block decodes ${rec.encoding}; control ${pin.control} is ${ctl.encoding}`);
			if (ctl.active) add(`control ${p} active`, rec.active === ctl.active, ctl.active, rec.active ?? null, null, `the block enables on ${rec.active ?? "an unstated level"}; control ${pin.control} is active ${ctl.active}`);
			if (rec.reset !== undefined) add(`control ${p} reset`, rec.reset === ctl.reset, ctl.reset, rec.reset, null, `the block assumes the reset value ${rec.reset}; control ${pin.control} resets to ${ctl.reset}`);
		}
	}
	for (const p of Object.keys(iface.bias ?? {})) if (block.pins[p]?.kind !== "bias") add(`bias ${p}`, false, "a bias pin of the table", "a bias need of the block", null, `the block needs bias on pin ${p}, which is not a bias pin of the table (a need without a provider)`);
	for (const p of Object.keys(iface.controls ?? {})) if (block.pins[p]?.kind !== "control") add(`control ${p}`, false, "a control pin of the table", "a control of the block", null, `the block decodes a control on pin ${p}, which is not a control pin of the table`);
	return rows;
}

/** The gate: the table rows that name the block, then the block rows; a missing record is one not-run row. */
export function connectionGate(root: string, tablePath: string, block: string, interfacePath: string): ConnectionRow[] {
	const t = loadConnectionTable(isAbsolute(tablePath) ? tablePath : join(root, tablePath));
	const tableRows = checkTable(t).filter((r) => r.item.startsWith(`table ${block}.`));
	const ip = isAbsolute(interfacePath) ? interfacePath : join(root, interfacePath);
	if (!existsSync(ip)) return [...tableRows, { item: "record", status: "not_run", expected: null, got: null, unit: null, reason: `no block interface record ${interfacePath}: the block cannot pass without it` }];
	const iface = readJsonFile<BlockInterface>(ip);
	if (iface.schema !== BLOCK_INTERFACE_SCHEMA) return [...tableRows, { item: "record", status: "fail", expected: BLOCK_INTERFACE_SCHEMA, got: String(iface.schema), unit: null, reason: `${interfacePath}: schema must be ${BLOCK_INTERFACE_SCHEMA}` }];
	if (iface.block !== block) return [...tableRows, { item: "record", status: "fail", expected: block, got: iface.block, unit: null, reason: `${interfacePath} is the record of block ${iface.block}` }];
	return [...tableRows, ...checkBlock(t, iface, root)];
}

export function formatConnectionRows(rows: ConnectionRow[]): string {
	const counts = { pass: 0, fail: 0, not_run: 0 };
	for (const r of rows) counts[r.status]++;
	const fmt = (v: ConnectionRow["expected"]) => (Array.isArray(v) ? `${v[0]} to ${v[1]}` : v === null ? "-" : String(v));
	const lines = [`connections: ${rows.length} rows (${counts.pass} pass, ${counts.fail} fail, ${counts.not_run} not run)`];
	for (const r of rows) lines.push(`  ${r.status.padEnd(7)} ${r.item}: expected ${fmt(r.expected)}, got ${fmt(r.got)}${r.unit ? ` ${r.unit}` : ""}${r.reason ? ` (${r.reason})` : ""}`);
	return lines.join("\n");
}
