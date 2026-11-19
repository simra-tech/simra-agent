// A query over the records of a design root: the measurements of the experiments, or the rows of a check, as a table.
// It reads simra/experiments/<id>/{experiment,result}.json and simra/checks/<id>/verdict.json; it runs no tool.
//
// Source "experiments": one row per measurement of each experiment (newest first). The condition of an experiment is
// the condition of its check ("check <id>: <experiment> at <condition>" in its purpose), else the temperature and
// params of its inputs. Source "checks": one row per verdict row of a check (default the newest check).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listExperiments, readJson } from "./records.ts";
import { checksDir, type VerdictRecord } from "./requirements.ts";

export interface QueryFilter {
	/** "experiments" (default) or "checks". A filter on check or requirement selects "checks". */
	source?: "experiments" | "checks";
	/** A check id, or "latest" (default for source checks). */
	check?: string;
	/** Experiments: an id prefix or a text in the purpose. Checks: the experiment name of the row. */
	experiment?: string;
	/** The condition (corner) name, exact. */
	condition?: string;
	/** A text in the measurement name, or /regex/. */
	measurement?: string;
	/** Checks: a text in the requirement id, or /regex/. */
	requirement?: string;
	/** Row status: measured, failed, missing (experiments); pass, fail, not_measured, not_run (checks). */
	status?: string;
	/** Experiments: the operation name (for example simulate, monte_carlo, device_limits). */
	operation?: string;
	/** The most rows in the table (default 200). */
	limit?: number;
}

export interface QueryRow {
	source: "experiment" | "check";
	id: string;
	created_at: string;
	condition: string | null;
	name: string;
	value: number | null;
	unit: string | null;
	status: string;
	/** Checks: the limit and the margin. Experiments: the purpose. */
	detail: string;
}

export interface QueryResult {
	source: "experiments" | "checks";
	rows: QueryRow[];
	/** Rows that matched before the limit. */
	matched: number;
	check: string | null;
}

function matcher(text: string | undefined): (s: string) => boolean {
	if (!text) return () => true;
	const m = /^\/(.+)\/([a-z]*)$/.exec(text);
	if (m) {
		const re = new RegExp(m[1], m[2]);
		return (s) => re.test(s);
	}
	const low = text.toLowerCase();
	return (s) => s.toLowerCase().includes(low);
}

const CHECK_PURPOSE = /^check (\S+): (.+?)(?: at (\S+))?$/;

/** The condition of an experiment: from its check purpose, else temp_c and params of the inputs, else null. */
export function experimentCondition(purpose: string | null, inputs: Record<string, unknown>): string | null {
	const m = purpose ? CHECK_PURPOSE.exec(purpose) : null;
	if (m?.[3]) return m[3];
	const parts: string[] = [];
	if (typeof inputs.temp_c === "number") parts.push(`T=${inputs.temp_c}`);
	const params = inputs.params as Record<string, unknown> | undefined;
	if (params && typeof params === "object") for (const [k, v] of Object.entries(params)) parts.push(`${k}=${v}`);
	return parts.length ? parts.join(" ") : null;
}

export function queryRecords(root: string, filter: QueryFilter = {}): QueryResult {
	const source = filter.source ?? (filter.check || filter.requirement ? "checks" : "experiments");
	const limit = filter.limit ?? 200;
	const mName = matcher(filter.measurement);
	const rows: QueryRow[] = [];
	let check: string | null = null;
	if (source === "checks") {
		const dir = checksDir(root);
		const ids = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, "verdict.json"))).sort() : [];
		check = !filter.check || filter.check === "latest" ? (ids.at(-1) ?? null) : (ids.find((d) => d === filter.check || d.startsWith(filter.check as string)) ?? null);
		if (!check) throw new Error(filter.check && filter.check !== "latest" ? `check ${filter.check} not found` : "no check in this design root");
		const v = readJson<VerdictRecord>(join(dir, check, "verdict.json"));
		const mReq = matcher(filter.requirement);
		const names = new Map(v.experiments.map((e) => [e.id, e.experiment]));
		for (const r of v.rows) {
			if (!mReq(r.requirement) || !mName(r.measurement)) continue;
			if (filter.condition !== undefined && r.condition !== filter.condition) continue;
			if (filter.status && r.status !== filter.status) continue;
			if (filter.experiment && !(names.get(r.experiment ?? "") ?? "").toLowerCase().includes(filter.experiment.toLowerCase())) continue;
			const lim = Array.isArray(r.limit) ? `[${r.limit.join(", ")}]` : String(r.limit);
			rows.push({
				source: "check",
				id: r.experiment ?? "-",
				created_at: v.created_at,
				condition: r.condition,
				name: `${r.requirement}: ${r.measurement}`,
				value: r.value,
				unit: r.unit,
				status: r.status,
				detail: `${r.op} ${lim}${r.margin === null ? "" : `, margin ${Number(r.margin.toPrecision(4))}`}${r.at ? ` @ ${Object.entries(r.at).map(([k, x]) => `${k}=${x}`).join(" ")}` : ""}${r.reason ? `; ${r.reason}` : ""}`,
			});
		}
	} else {
		const mExp = matcher(filter.experiment);
		for (const e of listExperiments(root).reverse()) {
			const purpose = e.experiment.purpose ?? "";
			if (filter.experiment && !e.id.startsWith(filter.experiment) && !mExp(purpose)) continue;
			if (filter.operation && e.experiment.operation !== filter.operation) continue;
			const condition = experimentCondition(e.experiment.purpose, e.experiment.inputs ?? {});
			if (filter.condition !== undefined && condition !== filter.condition) continue;
			const ms = e.result?.measurements ?? {};
			for (const [name, m] of Object.entries(ms)) {
				if (!mName(name)) continue;
				if (filter.status && m.status !== filter.status) continue;
				rows.push({ source: "experiment", id: e.id, created_at: e.experiment.created_at, condition, name, value: m.value, unit: m.unit, status: m.status, detail: `${e.experiment.adapter.name}.${e.experiment.operation}${purpose ? `: ${purpose}` : ""}` });
			}
		}
	}
	return { source, rows: rows.slice(0, limit), matched: rows.length, check };
}

const fmt = (x: number | null) => (x === null ? "-" : Number(x.toPrecision(5)).toString());

/** The rows as a text table (tab separated, one header line). */
export function formatQuery(q: QueryResult): string {
	const head = q.source === "checks" ? `check ${q.check}: ${q.matched} rows${q.matched > q.rows.length ? ` (first ${q.rows.length})` : ""}` : `${q.matched} measurements${q.matched > q.rows.length ? ` (first ${q.rows.length})` : ""}`;
	if (!q.rows.length) return `${head}\nno row matches the filter`;
	const lines = [head, ["experiment", "condition", "name", "value", "unit", "status", q.source === "checks" ? "limit" : "purpose"].join("\t")];
	for (const r of q.rows) lines.push([r.id, r.condition ?? "-", r.name, fmt(r.value), r.unit ?? "-", r.status, r.detail].join("\t"));
	return lines.join("\n");
}
