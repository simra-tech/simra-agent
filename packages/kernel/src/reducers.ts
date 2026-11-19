// Sweep reducers: one value from the points of a sweep (minimum, maximum, the crossing of a level, the compression
// point). The rule for every reducer: the value is invalid when a point inside its bracket has no value. The bracket
// is the set of points that decides the value:
// - min, max: every point (a point without a value can hold the extremum);
// - crossing: from the first point to the first point at or beyond the level (a point without a value before it can
//   hold an earlier crossing, and an interpolation across it is not supported by the data);
// - compression: the same as crossing, with the level "first value minus db", falling.
// A failed point after the bracket does not change the value. An invalid value has the status "failed" and a reason
// that names the point; a value that the data does not reach (no crossing) has the status "missing".

export interface SweepPoint {
	x: number;
	/** null: the point has no value (it failed, timed out or did not converge). */
	y: number | null;
}

export type ReducerSpec =
	| { kind: "min" }
	| { kind: "max" }
	| { kind: "crossing"; level: number; direction?: "rising" | "falling" | "either" }
	| { kind: "compression"; db?: number };

export interface Reduced {
	value: number | null;
	status: "measured" | "failed" | "missing";
	/** The x of the value (for min and max: of the extreme point). */
	at: number | null;
	/** The x range of the bracket that the value used. */
	bracket: [number, number] | null;
	reason: string | null;
}

export const REDUCER_KINDS = ["min", "max", "crossing", "compression"] as const;

const fmt = (x: number) => `${Number(x.toPrecision(6))}`;

/** The error message of an invalid reducer specification, or null. */
export function reducerError(spec: unknown): string | null {
	const s = spec as Record<string, unknown> | null;
	if (!s || typeof s !== "object" || !REDUCER_KINDS.includes(s.kind as (typeof REDUCER_KINDS)[number])) return `reduce.kind must be one of ${REDUCER_KINDS.join(", ")}`;
	if (s.kind === "crossing" && !(typeof s.level === "number" && Number.isFinite(s.level))) return "reduce.level must be a number for kind crossing";
	if (s.kind === "crossing" && s.direction !== undefined && !["rising", "falling", "either"].includes(s.direction as string)) return "reduce.direction must be rising, falling or either";
	if (s.kind === "compression" && s.db !== undefined && !(typeof s.db === "number" && s.db > 0)) return "reduce.db must be a positive number";
	return null;
}

function invalid(points: SweepPoint[], last: number, what: string): Reduced | null {
	const bad = points.slice(0, last + 1).find((p) => p.y === null || !Number.isFinite(p.y));
	if (!bad) return null;
	return { value: null, status: "failed", at: null, bracket: [points[0].x, points[last].x], reason: `the point ${fmt(bad.x)} has no value and is inside the bracket of the ${what}` };
}

/** Reduce the points (in sweep order) with the spec. */
export function reduceSweep(points: SweepPoint[], spec: ReducerSpec): Reduced {
	const err = reducerError(spec);
	if (err) throw new Error(err);
	if (!points.length) return { value: null, status: "missing", at: null, bracket: null, reason: "the sweep has no points" };
	if (spec.kind === "min" || spec.kind === "max") {
		const bad = invalid(points, points.length - 1, `${spec.kind === "min" ? "minimum" : "maximum"} (every point)`);
		if (bad) return bad;
		const pick = points.reduce((a, b) => ((spec.kind === "min" ? (b.y as number) < (a.y as number) : (b.y as number) > (a.y as number)) ? b : a));
		return { value: pick.y, status: "measured", at: pick.x, bracket: [points[0].x, points[points.length - 1].x], reason: null };
	}
	let level: number;
	let direction: "rising" | "falling" | "either";
	let what: string;
	if (spec.kind === "compression") {
		const db = spec.db ?? 1;
		if (points[0].y === null || !Number.isFinite(points[0].y))
			return { value: null, status: "failed", at: null, bracket: [points[0].x, points[0].x], reason: `the first point ${fmt(points[0].x)} (the reference) has no value` };
		level = (points[0].y as number) - db;
		direction = "falling";
		what = `${db} dB compression`;
	} else {
		level = spec.level;
		direction = spec.direction ?? "either";
		what = `crossing of ${fmt(level)}`;
	}
	const beyond = (y: number, ref: number) =>
		direction === "rising" ? y >= level && ref < level : direction === "falling" ? y <= level && ref > level : (y - level) * (ref - level) <= 0 && ref !== level;
	if (points[0].y === null || !Number.isFinite(points[0].y)) return invalid(points, 0, what) as Reduced;
	// Scan from the first point. A point without a value stops the scan: the bracket is not closed before it.
	for (let k = 1; k < points.length; k++) {
		const a = points[k - 1];
		const b = points[k];
		if (a.y === null || b.y === null || !Number.isFinite(a.y) || !Number.isFinite(b.y)) {
			return invalid(points, k, what) as Reduced;
		}
		if (beyond(b.y, a.y)) {
			const x = b.y === a.y ? b.x : a.x + ((level - a.y) * (b.x - a.x)) / (b.y - a.y);
			return { value: x, status: "measured", at: x, bracket: [points[0].x, b.x], reason: null };
		}
	}
	const last = points[points.length - 1];
	return { value: null, status: "missing", at: null, bracket: [points[0].x, last.x], reason: `no ${what} between ${fmt(points[0].x)} and ${fmt(last.x)}` };
}

/** The text of a reduced value for a summary: the value at its x, or the status and the reason. */
export function formatReduced(r: Reduced, unit?: string | null): string {
	if (r.status === "measured") return `${r.value}${unit ? ` ${unit}` : ""}${r.at !== null ? ` @ ${fmt(r.at)}` : ""}`;
	return `${r.status.toUpperCase()} (${r.reason})`;
}
