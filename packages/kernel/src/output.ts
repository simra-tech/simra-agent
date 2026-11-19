// Read simulator outputs without a script: the measurement lines, errors and warnings of a log, and the columns of a
// table (ngspice wrdata or print output, a whitespace table with an optional header, or a SPICE raw file in ASCII or
// binary form) by column and range.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const VALUE_LINE = new RegExp(String.raw`^\s*([A-Za-z_][\w.\[\]():#@-]*)\s*=\s*(${NUMBER})(?:\s|,|$)`);
const ERROR_LINE = /^\s*(?:\*+\s*)?(error|fatal)\b|\berror:|\bfailed\b|timestep too small|singular matrix|no convergence|aborted/i;
const WARNING_LINE = /^\s*(?:\*+\s*)?warning\b|\bwarning:/i;

export interface LogSummary {
	file: string;
	lines: number;
	measurements: { name: string; value: number; line: number }[];
	errors: { line: number; text: string }[];
	warnings: { line: number; text: string }[];
	/** Lines that match the pattern (with the line number), when a pattern is given. */
	matches: { line: number; text: string }[];
	/** Total counts; the lists hold at most `max` entries each. */
	counts: { measurements: number; errors: number; warnings: number; matches: number };
}

/** The path of a file of the design root (absolute, inside the root), or an error. */
export function outputPath(root: string, file: string): string {
	const path = isAbsolute(file) ? file : join(root, file);
	const rel = relative(resolve(root), resolve(path));
	if (rel.startsWith("..")) throw new Error(`${file} is outside the design root`);
	if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${file} not found`);
	return path;
}

/** The measurement lines (name = value), errors, warnings and the lines that match a pattern, of a simulator log. */
export function readLog(root: string, file: string, opts: { pattern?: string; max?: number } = {}): LogSummary {
	const text = readFileSync(outputPath(root, file), "utf8");
	const max = opts.max ?? 50;
	const re = opts.pattern ? new RegExp(opts.pattern, "i") : null;
	const out: LogSummary = { file, lines: 0, measurements: [], errors: [], warnings: [], matches: [], counts: { measurements: 0, errors: 0, warnings: 0, matches: 0 } };
	const seen = new Set<string>();
	const lines = text.split("\n");
	out.lines = lines.length;
	lines.forEach((raw, i) => {
		const l = raw.replace(/\s+$/, "");
		if (!l) return;
		const n = i + 1;
		const m = VALUE_LINE.exec(l);
		if (m) {
			out.counts.measurements++;
			if (out.measurements.length < max) out.measurements.push({ name: m[1], value: Number(m[2]), line: n });
		}
		if (ERROR_LINE.test(l)) {
			out.counts.errors++;
			// a repeated message counts but is listed once
			if (!seen.has(l) && out.errors.length < max) out.errors.push({ line: n, text: l.trim() });
			seen.add(l);
		} else if (WARNING_LINE.test(l)) {
			out.counts.warnings++;
			if (!seen.has(l) && out.warnings.length < max) out.warnings.push({ line: n, text: l.trim() });
			seen.add(l);
		}
		if (re?.test(l)) {
			out.counts.matches++;
			if (out.matches.length < max) out.matches.push({ line: n, text: l.trim() });
		}
	});
	return out;
}

export interface Table {
	columns: string[];
	rows: number[][];
	/** "raw-ascii", "raw-binary", "text". */
	format: string;
	complex: boolean;
}

function parseRaw(buf: Buffer): Table {
	const head = buf.toString("latin1", 0, Math.min(buf.length, 1 << 20));
	const flags = /^Flags:\s*(.*)$/im.exec(head)?.[1] ?? "";
	const nv = Number(/^No\. Variables:\s*(\d+)/im.exec(head)?.[1]);
	const np = Number(/^No\. Points:\s*(\d+)/im.exec(head)?.[1]);
	const vstart = head.search(/^Variables:/im);
	if (!(nv > 0) || vstart < 0) throw new Error("not a SPICE raw file (no Variables section)");
	const complex = /complex/i.test(flags);
	const names: string[] = [];
	const varLines = head.slice(vstart).split("\n").slice(1);
	for (const l of varLines) {
		if (names.length >= nv) break;
		const f = l.trim().split(/\s+/);
		if (f.length >= 2 && /^\d+$/.test(f[0])) names.push(f[1]);
	}
	const columns = complex ? names.flatMap((n, i) => (i === 0 ? [n] : [`${n}.re`, `${n}.im`])) : names;
	const bin = /^Binary:\s*$/im.exec(head);
	const rows: number[][] = [];
	if (bin) {
		let off = (bin.index ?? 0) + bin[0].length;
		while (buf[off] === 0x0a || buf[off] === 0x0d) off++;
		const per = complex ? nv * 2 : nv;
		const n = Number.isFinite(np) ? np : Math.floor((buf.length - off) / (8 * per));
		for (let p = 0; p < n && off + 8 * per <= buf.length; p++) {
			const v: number[] = [];
			for (let k = 0; k < per; k++) v.push(buf.readDoubleLE(off + 8 * k));
			off += 8 * per;
			// the scale of a complex plot is stored as a complex number; keep its real part
			rows.push(complex ? [v[0], ...v.slice(2)] : v);
		}
		return { columns, rows, format: "raw-binary", complex };
	}
	const vals = head.search(/^Values:/im);
	if (vals < 0) throw new Error("not a SPICE raw file (no Values or Binary section)");
	const nums = buf.toString("latin1", vals).split("\n").slice(1).join(" ").trim().split(/[\s,]+/).filter(Boolean);
	// each point: an index, then nv values (complex values as "re,im")
	const step = complex ? 1 + nv * 2 : 1 + nv;
	for (let i = 0; i + step <= nums.length; i += step) {
		const v = nums.slice(i + 1, i + step).map(Number);
		rows.push(complex ? [v[0], ...v.slice(2)] : v);
	}
	return { columns, rows, format: "raw-ascii", complex };
}

function parseText(text: string): Table {
	const rows: number[][] = [];
	let columns: string[] | null = null;
	for (const raw of text.split("\n")) {
		const l = raw.trim();
		if (!l || l.startsWith("*") || l.startsWith("#") || /^-+$/.test(l)) continue;
		const f = l.split(/[\s,]+/).filter(Boolean);
		const nums = f.map(Number);
		if (nums.every((x) => Number.isFinite(x))) {
			// an ngspice print row starts with an index; it has one field more than the header
			rows.push(columns && f.length === columns.length + 1 && Number.isInteger(nums[0]) ? nums.slice(1) : nums);
		} else if (!rows.length) columns = f.filter((x) => x.toLowerCase() !== "index");
	}
	const width = Math.max(0, ...rows.map((r) => r.length));
	if (!columns || columns.length !== width) columns = Array.from({ length: width }, (_, i) => (columns?.[i] ?? `col${i}`));
	return { columns, rows: rows.filter((r) => r.length === width), format: "text", complex: false };
}

/** A table file: a SPICE raw file (ASCII or binary), or a whitespace table (wrdata, print output, csv). */
export function readTable(root: string, file: string): Table {
	const buf = readFileSync(outputPath(root, file));
	const head = buf.toString("latin1", 0, 400);
	if (/^Title:/m.test(head) && /^Plotname:/m.test(buf.toString("latin1", 0, 4000))) return parseRaw(buf);
	return parseText(buf.toString("utf8"));
}

export interface TableQuery {
	/** Columns to give (names, or a /regex/); default all. The first column (the scale) is always given. */
	columns?: string[];
	/** The rows whose value of `by` (default the first column) is in [from, to]. */
	by?: string;
	from?: number;
	to?: number;
	/** At most this many rows (default 40), spread evenly over the range. */
	max_rows?: number;
}

export interface TableResult {
	file: string;
	format: string;
	columns: string[];
	all_columns: string[];
	rows_total: number;
	rows_in_range: number;
	rows: number[][];
	/** Per given column: the minimum and the maximum in the range, with the scale value at each. */
	stats: { column: string; min: number; at_min: number; max: number; at_max: number }[];
}

export function queryTable(root: string, file: string, q: TableQuery = {}): TableResult {
	const t = readTable(root, file);
	const find = (name: string) => {
		const i = t.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
		if (i < 0) throw new Error(`no column "${name}"; the columns are ${t.columns.join(", ")}`);
		return i;
	};
	let idx: number[];
	if (!q.columns?.length) idx = t.columns.map((_, i) => i);
	else {
		idx = [0];
		for (const c of q.columns) {
			const m = /^\/(.*)\/$/.exec(c);
			if (m) {
				const re = new RegExp(m[1], "i");
				t.columns.forEach((name, i) => re.test(name) && idx.push(i));
			} else idx.push(find(c));
		}
		idx = [...new Set(idx)];
	}
	const by = q.by ? find(q.by) : 0;
	const inRange = t.rows.filter((r) => (q.from === undefined || r[by] >= q.from) && (q.to === undefined || r[by] <= q.to));
	const max = q.max_rows ?? 40;
	const pick = inRange.length <= max ? inRange : Array.from({ length: max }, (_, k) => inRange[Math.round((k * (inRange.length - 1)) / (max - 1))]);
	const stats = idx.slice(1).map((i) => {
		let lo = Number.POSITIVE_INFINITY;
		let hi = Number.NEGATIVE_INFINITY;
		let atLo = Number.NaN;
		let atHi = Number.NaN;
		for (const r of inRange) {
			if (r[i] < lo) [lo, atLo] = [r[i], r[0]];
			if (r[i] > hi) [hi, atHi] = [r[i], r[0]];
		}
		return { column: t.columns[i], min: lo, at_min: atLo, max: hi, at_max: atHi };
	});
	return { file, format: t.format, columns: idx.map((i) => t.columns[i]), all_columns: t.columns, rows_total: t.rows.length, rows_in_range: inRange.length, rows: pick.map((r) => idx.map((i) => r[i])), stats };
}

const g = (x: number) => (Number.isFinite(x) ? Number(x.toPrecision(6)).toString() : String(x));

export function formatLog(s: LogSummary): string {
	const out = [`${s.file}: ${s.lines} lines; ${s.counts.measurements} measurement lines, ${s.counts.errors} error lines, ${s.counts.warnings} warning lines${s.counts.matches ? `, ${s.counts.matches} matches` : ""}`];
	if (s.errors.length) out.push("errors:", ...s.errors.map((e) => `  ${e.line}: ${e.text}`));
	if (s.warnings.length) out.push("warnings:", ...s.warnings.map((e) => `  ${e.line}: ${e.text}`));
	if (s.measurements.length) out.push("measurements:", ...s.measurements.map((m) => `  ${m.name} = ${g(m.value)} (line ${m.line})`));
	if (s.matches.length) out.push("matches:", ...s.matches.map((e) => `  ${e.line}: ${e.text}`));
	return out.join("\n");
}

export function formatTable(r: TableResult): string {
	const out = [`${r.file} (${r.format}): ${r.rows_total} rows, ${r.rows_in_range} in range; columns: ${r.all_columns.join(", ")}`];
	out.push(r.columns.join("\t"), ...r.rows.map((row) => row.map(g).join("\t")));
	if (r.rows.length < r.rows_in_range) out.push(`(${r.rows.length} of ${r.rows_in_range} rows shown, evenly spread)`);
	out.push("min / max in range:", ...r.stats.map((s) => `  ${s.column}: min ${g(s.min)} at ${g(s.at_min)}, max ${g(s.max)} at ${g(s.at_max)}`));
	return out.join("\n");
}
