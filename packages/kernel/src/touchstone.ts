// Touchstone files (S-parameters of an N-port, version 1.x and 2.0) as a record type.
//
// When an input file or an output of an experiment has the role "touchstone" or a name that ends in .sNp, the runner
// adds a summary to its entry in result.json: the port count, the frequency band and point count, the reference
// impedance, and two numbers that a reader needs before the data is used in a circuit:
//
//   passivity: the largest singular value of S over the data points. A passive network has at most 1.
//   reciprocity: the largest |S_ij - S_ji| over the data points. A reciprocal network (no active device, no ferrite)
//     has 0.
//
// The kernel reads the file itself; it does not trust the adapter for these numbers. Only S-parameters are read.
// The numbers are about the data points only: they say nothing between or outside the points.

import { readFileSync } from "node:fs";
import { basename } from "node:path";

export const TOUCHSTONE_SCHEMA = "simra.touchstone/0";

/** A Touchstone name: <stem>.s<N>p (case-insensitive). */
export const TOUCHSTONE_NAME = /\.s(\d+)p$/i;

export interface TouchstoneData {
	version: 1 | 2;
	nports: number;
	/** The format of the numbers in the file: RI (real, imaginary), MA (magnitude, angle in degrees), DB (dB, angle). */
	format: "RI" | "MA" | "DB";
	/** The reference impedance of each port, in ohm. */
	z0: number[];
	/** Frequencies in Hz, in the order of the file. */
	f: number[];
	/** S at each frequency: S[k][(i * nports + j) * 2] is Re S_ij and the next number is Im S_ij (i, j from 0). */
	s: Float64Array[];
	/** The file has noise parameters (2-port only). They are not read. */
	noise: boolean;
}

export interface TouchstoneSummary {
	schema: typeof TOUCHSTONE_SCHEMA;
	version: 1 | 2;
	nports: number;
	parameter: "S";
	format: TouchstoneData["format"];
	z0_ohm: number[];
	points: number;
	f_min_hz: number;
	f_max_hz: number;
	/** The data has a point at 0 Hz. Without it, a circuit simulation that solves a DC point uses an extrapolation. */
	dc_point: boolean;
	/** The frequency step is constant (relative tolerance 1e-6). */
	uniform_grid: boolean;
	noise_data: boolean;
	passivity: { max_singular_value: number; at_hz: number };
	reciprocity: { max_abs_difference: number; at_hz: number };
}

const UNITS: Record<string, number> = { HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9 };

interface Options {
	unit: number;
	parameter: string;
	format: "RI" | "MA" | "DB";
	r: number;
}

function parseOptions(line: string): Options {
	const words = line.slice(1).trim().toUpperCase().split(/\s+/).filter(Boolean);
	const o: Options = { unit: 1e9, parameter: "S", format: "MA", r: 50 };
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		if (w in UNITS) o.unit = UNITS[w];
		else if (["S", "Y", "Z", "G", "H"].includes(w)) o.parameter = w;
		else if (w === "RI" || w === "MA" || w === "DB") o.format = w;
		else if (w === "R") o.r = Number(words[++i]);
		else throw new Error(`option line: unknown word ${w}`);
	}
	if (!(o.r > 0)) throw new Error("option line: the reference resistance R must be a positive number");
	return o;
}

function toComplex(format: Options["format"], a: number, b: number): [number, number] {
	if (format === "RI") return [a, b];
	const mag = format === "MA" ? a : 10 ** (a / 20);
	const rad = (b * Math.PI) / 180;
	return [mag * Math.cos(rad), mag * Math.sin(rad)];
}

const numberTokens = (text: string): number[] =>
	text
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => {
			const x = Number(t);
			if (!Number.isFinite(x)) throw new Error(`not a number: ${t}`);
			return x;
		});

/**
 * Parse a Touchstone file. name is the file name: a version 1 file gives its port count only in the name (.sNp).
 * Throws an Error with a reason for a file that is not valid or not supported (parameters other than S, mixed mode).
 */
export function parseTouchstone(text: string, name: string): TouchstoneData {
	const lines = text.split(/\r?\n/).map((l) => l.replace(/!.*$/, "").trim());
	const isV2 = lines.some((l) => /^\[version\]\s*2/i.test(l));
	let options: Options | null = null;
	let nports = 0;
	let order21 = true; // version 1 two-port order: S11 S21 S12 S22
	let matrix: "FULL" | "LOWER" | "UPPER" = "FULL";
	let reference: number[] | null = null;
	let expected: number | null = null;
	const data: number[] = [];
	if (!isV2) {
		const m = TOUCHSTONE_NAME.exec(name);
		if (!m) throw new Error(`a version 1 file needs the port count in its name (.sNp): ${basename(name)}`);
		nports = Number(m[1]);
	}
	let section = isV2 ? "header" : "data";
	let collectingReference = false;
	for (const line of lines) {
		if (!line) continue;
		if (line.startsWith("#")) {
			if (!options) options = parseOptions(line);
			continue;
		}
		const kw = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
		if (kw) {
			collectingReference = false;
			const key = kw[1].trim().toUpperCase();
			const value = kw[2].trim();
			if (key === "VERSION") continue;
			if (key === "NUMBER OF PORTS") nports = Number(value);
			else if (key === "TWO-PORT DATA ORDER") order21 = value.toUpperCase() === "21_12";
			else if (key === "NUMBER OF FREQUENCIES") expected = Number(value);
			else if (key === "MATRIX FORMAT") matrix = value.toUpperCase() as typeof matrix;
			else if (key === "REFERENCE") {
				reference = value ? numberTokens(value) : [];
				collectingReference = true;
			} else if (key === "MIXED-MODE ORDER") throw new Error("mixed-mode data is not supported");
			else if (key === "NETWORK DATA") section = "data";
			else if (key === "NOISE DATA" || key === "END") section = "after";
			continue;
		}
		if (collectingReference && reference && reference.length < nports) {
			reference.push(...numberTokens(line));
			continue;
		}
		if (section === "data") data.push(...numberTokens(line));
	}
	if (!options) options = { unit: 1e9, parameter: "S", format: "MA", r: 50 };
	if (options.parameter !== "S") throw new Error(`parameter ${options.parameter}: only S-parameters are supported`);
	if (!Number.isInteger(nports) || nports < 1) throw new Error("the port count is not known");
	if (isV2 && nports === 2 && !lines.some((l) => /^\[two-port data order\]/i.test(l))) {
		throw new Error("a version 2 two-port file needs [Two-Port Data Order]");
	}
	const n = nports;
	const z0 = reference && reference.length ? reference : Array(n).fill(options.r);
	if (z0.length !== n || !z0.every((z) => z > 0)) throw new Error(`the reference impedances are not ${n} positive numbers`);
	const pairs = matrix === "FULL" ? n * n : (n * (n + 1)) / 2;
	const perPoint = 1 + 2 * pairs;
	const f: number[] = [];
	const s: Float64Array[] = [];
	let noise = false;
	for (let at = 0; at + perPoint <= data.length; at += perPoint) {
		const freq = data[at] * options.unit;
		// A version 1 two-port file has its noise data after the network data: the frequency starts again.
		if (f.length && freq <= f[f.length - 1]) {
			if (!isV2 && n === 2) {
				noise = true;
				break;
			}
			throw new Error(`the frequencies do not increase at ${freq} Hz`);
		}
		const point = new Float64Array(2 * n * n);
		let k = at + 1;
		const set = (i: number, j: number, re: number, im: number) => {
			point[(i * n + j) * 2] = re;
			point[(i * n + j) * 2 + 1] = im;
		};
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				if (matrix === "LOWER" && j > i) continue;
				if (matrix === "UPPER" && j < i) continue;
				const [re, im] = toComplex(options.format, data[k], data[k + 1]);
				k += 2;
				// The 2-port order 21_12 is S11 S21 S12 S22: the second pair is S21.
				const [r, c] = n === 2 && order21 && i !== j ? [j, i] : [i, j];
				set(r, c, re, im);
				if (matrix !== "FULL") set(c, r, re, im);
			}
		}
		f.push(freq);
		s.push(point);
	}
	const used = f.length * perPoint;
	if (!noise && used !== data.length) throw new Error(`the network data has ${data.length - used} numbers after the last full point`);
	if (!f.length) throw new Error("the file has no data points");
	if (expected !== null && expected !== f.length) throw new Error(`[Number of Frequencies] is ${expected}, the file has ${f.length} points`);
	if (isV2 && lines.some((l) => /^\[noise data\]/i.test(l))) noise = true;
	return { version: isV2 ? 2 : 1, nports: n, format: options.format, z0, f, s, noise };
}

/** The eigenvalues of a real symmetric matrix (row-major, size m), by cyclic Jacobi rotations. */
function symmetricEigenvalues(a: Float64Array, m: number): number[] {
	const x = Float64Array.from(a);
	for (let sweep = 0; sweep < 100; sweep++) {
		let off = 0;
		let total = 0;
		for (let p = 0; p < m; p++) {
			for (let q = 0; q < m; q++) {
				total += x[p * m + q] ** 2;
				if (p !== q) off += x[p * m + q] ** 2;
			}
		}
		if (off <= 1e-30 * Math.max(total, 1e-300)) break;
		for (let p = 0; p < m - 1; p++) {
			for (let q = p + 1; q < m; q++) {
				const apq = x[p * m + q];
				if (apq === 0) continue;
				const theta = (x[q * m + q] - x[p * m + p]) / (2 * apq);
				const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const sn = t * c;
				for (let k = 0; k < m; k++) {
					const akp = x[k * m + p];
					const akq = x[k * m + q];
					x[k * m + p] = c * akp - sn * akq;
					x[k * m + q] = sn * akp + c * akq;
				}
				for (let k = 0; k < m; k++) {
					const apk = x[p * m + k];
					const aqk = x[q * m + k];
					x[p * m + k] = c * apk - sn * aqk;
					x[q * m + k] = sn * apk + c * aqk;
				}
			}
		}
	}
	return Array.from({ length: m }, (_, i) => x[i * m + i]);
}

/**
 * The largest singular value of a complex n x n matrix (layout as in TouchstoneData.s). It is the square root of the
 * largest eigenvalue of A = S^H S. A is Hermitian; its real form [[Re A, -Im A], [Im A, Re A]] is real symmetric and
 * has the same eigenvalues, each twice.
 */
export function largestSingularValue(point: Float64Array, n: number): number {
	if (n === 1) return Math.hypot(point[0], point[1]);
	const re = (i: number, j: number) => point[(i * n + j) * 2];
	const im = (i: number, j: number) => point[(i * n + j) * 2 + 1];
	const m = 2 * n;
	const big = new Float64Array(m * m);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < n; j++) {
			let ar = 0;
			let ai = 0;
			for (let k = 0; k < n; k++) {
				// (conj(S_ki)) * S_kj
				ar += re(k, i) * re(k, j) + im(k, i) * im(k, j);
				ai += re(k, i) * im(k, j) - im(k, i) * re(k, j);
			}
			big[i * m + j] = ar;
			big[(i + n) * m + (j + n)] = ar;
			big[i * m + (j + n)] = -ai;
			big[(i + n) * m + j] = ai;
		}
	}
	return Math.sqrt(Math.max(0, ...symmetricEigenvalues(big, m)));
}

export function summarizeTouchstone(t: TouchstoneData): TouchstoneSummary {
	const n = t.nports;
	let sigma = { max_singular_value: -1, at_hz: t.f[0] };
	let recip = { max_abs_difference: 0, at_hz: t.f[0] };
	t.s.forEach((point, k) => {
		const sv = largestSingularValue(point, n);
		if (sv > sigma.max_singular_value) sigma = { max_singular_value: sv, at_hz: t.f[k] };
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const d = Math.hypot(point[(i * n + j) * 2] - point[(j * n + i) * 2], point[(i * n + j) * 2 + 1] - point[(j * n + i) * 2 + 1]);
				if (d > recip.max_abs_difference) recip = { max_abs_difference: d, at_hz: t.f[k] };
			}
		}
	});
	const steps = t.f.slice(1).map((x, i) => x - t.f[i]);
	const uniform = steps.every((d) => Math.abs(d - steps[0]) <= 1e-6 * Math.abs(steps[0]));
	return {
		schema: TOUCHSTONE_SCHEMA,
		version: t.version,
		nports: n,
		parameter: "S",
		format: t.format,
		z0_ohm: t.z0,
		points: t.f.length,
		f_min_hz: t.f[0],
		f_max_hz: t.f[t.f.length - 1],
		dc_point: t.f[0] === 0,
		uniform_grid: uniform,
		noise_data: t.noise,
		passivity: sigma,
		reciprocity: recip,
	};
}

export function readTouchstone(path: string): TouchstoneData {
	return parseTouchstone(readFileSync(path, "utf8"), basename(path));
}

/** A Touchstone entry of a record: by role, or by its name. */
export function isTouchstoneEntry(f: { path: string; role?: string }): boolean {
	return f.role === "touchstone" || TOUCHSTONE_NAME.test(f.path);
}

/** The summary of a Touchstone file, or the reason why the file cannot be read. */
export function describeTouchstone(path: string): TouchstoneSummary | { error: string } {
	try {
		return summarizeTouchstone(readTouchstone(path));
	} catch (e) {
		return { error: (e as Error).message };
	}
}

/** One line for a summary: ports, band, points, reference impedance, passivity and reciprocity. */
export function formatTouchstone(t: TouchstoneSummary | { error: string }): string {
	if ("error" in t) return `touchstone: not readable: ${t.error}`;
	const g = (x: number) => Number(x.toPrecision(4)).toString();
	const z0 = new Set(t.z0_ohm).size === 1 ? `${g(t.z0_ohm[0])}` : t.z0_ohm.map(g).join("/");
	const sv = t.passivity.max_singular_value;
	return (
		`touchstone: ${t.nports}-port, ${g(t.f_min_hz)} to ${g(t.f_max_hz)} Hz, ${t.points} points${t.dc_point ? "" : " (no DC point)"}, ` +
		`z0 ${z0} ohm, max singular value ${sv.toFixed(4)}${sv > 1 ? " (NOT PASSIVE at the data points)" : ""} at ${g(t.passivity.at_hz)} Hz, ` +
		`reciprocity ${t.reciprocity.max_abs_difference.toExponential(1)}`
	);
}

/** Complex helpers for the derived quantities (S in dB, stability factor mu). */
type C = [number, number];
const cmul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const csub = (a: C, b: C): C => [a[0] - b[0], a[1] - b[1]];
const conj = (a: C): C => [a[0], -a[1]];
const cabs = (a: C) => Math.hypot(a[0], a[1]);

export function entry(t: TouchstoneData, k: number, i: number, j: number): C {
	const n = t.nports;
	return [t.s[k][(i * n + j) * 2], t.s[k][(i * n + j) * 2 + 1]];
}

/** 20 log10 |S_ij| at point k; i and j from 1. */
export function sDb(t: TouchstoneData, k: number, i: number, j: number): number {
	return 20 * Math.log10(cabs(entry(t, k, i - 1, j - 1)));
}

/**
 * The stability factor mu of a 2-port at point k (Edwards and Sinsky, 1992):
 * mu = (1 - |S11|^2) / (|S22 - conj(S11) * Delta| + |S12 * S21|), Delta = S11 S22 - S12 S21.
 * The 2-port is unconditionally stable when mu > 1 at the frequency.
 */
export function stabilityMu(t: TouchstoneData, k: number): number {
	const s11 = entry(t, k, 0, 0);
	const s12 = entry(t, k, 0, 1);
	const s21 = entry(t, k, 1, 0);
	const s22 = entry(t, k, 1, 1);
	const delta = csub(cmul(s11, s22), cmul(s12, s21));
	return (1 - cabs(s11) ** 2) / (cabs(csub(s22, cmul(conj(s11), delta))) + cabs(cmul(s12, s21)));
}
