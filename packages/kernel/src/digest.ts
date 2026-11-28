// The owner digest: what the owner must see of a design root since a given time, short enough for a small screen.
//   - the class A decisions that wait for the owner (all of them, also the old ones), and the answered ones;
//   - the class B decisions (the work continued; the owner did not confirm them);
//   - the results whose pass rule changed, the runs with a pass rule that did not complete, and the checks that failed;
//   - the checks that are recorded as not run.
// It reads the records only (simra/decisions, simra/experiments, simra/checks). It runs no tool and writes nothing.
// A list is cut after a few entries; its count is never cut.

import { basename } from "node:path";
import { currentStatement, type DecisionRecord, type DecisionScan, decisionDependents, readDecisions, scanRecords, shortId, statusText, waitsForOwner } from "./decisions.ts";
import { passRuleFlags } from "./passrule.ts";

/**
 * A time for --since: an ISO date or time ("2026-11-27", "2026-11-27T18:00:00Z"), or a duration back from now
 * ("90m", "24h", "3d", "2w"). It throws on another text.
 */
export function parseSince(value: string, now = new Date()): Date {
	const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(value.trim());
	if (m) return new Date(now.getTime() - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "m" | "h" | "d" | "w"]);
	const t = /^\d{4}-\d{2}-\d{2}/.test(value.trim()) ? Date.parse(value.trim()) : Number.NaN;
	if (Number.isNaN(t)) throw new Error(`since "${value}": give an ISO date or time (2026-11-27, 2026-11-27T18:00:00Z) or a duration (90m, 24h, 3d, 2w)`);
	return new Date(t);
}

export interface DigestDecision {
	decision: DecisionRecord;
	/** The number of results that rest on the decision now. */
	dependents: number;
}

export interface DigestRun {
	id: string;
	kind: string;
	status: string;
	text: string;
}

export interface DigestNotRun {
	/** "check <id>" or "run <id>". */
	where: string;
	count: number;
	/** Of count: the rows that the check did not select. */
	not_selected: number;
	items: string[];
}

export interface Digest {
	root: string;
	since: string;
	until: string;
	/** Class A without an answer: all of them, also those older than since. */
	waiting: DigestDecision[];
	/** Class A with an answer, decided or answered since. */
	answered: DigestDecision[];
	/** Class B, decided or answered since. */
	listed: DigestDecision[];
	/** Class C, decided since: the count only. */
	logged: number;
	unreadable: string[];
	pass_rule: {
		changed: DigestRun[];
		/** Runs with a pass rule that did not complete, and checks with the status fail. */
		failed: DigestRun[];
		/** Completed runs with a pass rule. The kernel does not apply a pass rule: these are not judged. */
		not_applied: number;
	};
	not_run: DigestNotRun[];
	/** The runs that ended since and did not complete, by status. */
	not_completed: Record<string, number>;
	counts: { experiments: number; checks: number };
}

// "not run" as the adapters record it: "timing check: not run", "not run: the deck did not run", "pin check not run: ...",
// "the marker delta is not run". The text "does not run" is not a record of a check.
const NOT_RUN = /(^|[:;,(]\s*|\bis |\bcheck )not run\b/i;
const NOT_SELECTED = "not selected in this check";

function notRunItems(result: { diagnostics?: { message: string }[]; report?: string[]; measurements?: Record<string, { reason?: string }>; tool?: Record<string, unknown> | null }): string[] {
	// One check is often recorded three times (a measurement, a report line, a diagnostic). The named items count:
	// the measurements and the items of a pack check. Without them the report lines count, and without those the diagnostics.
	const out: string[] = [];
	for (const [name, m] of Object.entries(result.measurements ?? {})) if (m?.reason && NOT_RUN.test(m.reason)) out.push(`${name}: ${m.reason}`);
	const items = (result.tool as { check?: { items?: { name: string; status: string; reason?: string }[] } } | null | undefined)?.check?.items;
	if (Array.isArray(items)) for (const i of items) if (i?.status === "not run") out.push(`${i.name}: not run${i.reason ? ` (${i.reason})` : ""}`);
	if (!out.length) for (const line of result.report ?? []) if (typeof line === "string" && NOT_RUN.test(line)) out.push(line);
	if (!out.length) for (const d of result.diagnostics ?? []) if (typeof d?.message === "string" && NOT_RUN.test(d.message)) out.push(d.message);
	return [...new Set(out)];
}

const within = (time: string | undefined | null, since: Date): boolean => typeof time === "string" && Date.parse(time) >= since.getTime();

/** Read the records of the design root and collect the digest since the given time. */
export function buildDigest(root: string, since: Date, now = new Date()): Digest {
	const { decisions, unreadable } = readDecisions(root);
	const scan: DecisionScan = scanRecords(root);
	const entry = (decision: DecisionRecord): DigestDecision => ({ decision, dependents: decisionDependents(root, decision, scan).length });
	const recent = (d: DecisionRecord) => within(d.created_at, since) || d.answers.some((a) => within(a.at, since));
	const digest: Digest = {
		root,
		since: since.toISOString(),
		until: now.toISOString(),
		waiting: decisions.filter(waitsForOwner).map(entry),
		answered: decisions.filter((d) => d.class === "A" && !waitsForOwner(d) && recent(d)).map(entry),
		listed: decisions.filter((d) => d.class === "B" && recent(d)).map(entry),
		logged: decisions.filter((d) => d.class === "C" && recent(d)).length,
		unreadable,
		pass_rule: { changed: [], failed: [], not_applied: 0 },
		not_run: [],
		not_completed: {},
		counts: { experiments: 0, checks: 0 },
	};
	for (const { id, experiment, result } of scan.experiments) {
		if (!result || !within(result.finished_at, since)) continue;
		digest.counts.experiments++;
		const kind = `${experiment.adapter?.name ?? "?"}.${experiment.operation}`;
		let flags: string[] = [];
		try {
			flags = passRuleFlags(root, experiment, result);
		} catch {}
		if (flags.length) digest.pass_rule.changed.push({ id, kind, status: result.status, text: flags[0].replace(/^PASS RULE CHANGED: /, "") });
		if (experiment.pass_rule) {
			const rule = experiment.pass_rule.key ?? `"${(experiment.pass_rule.text ?? "").trim().split("\n")[0].slice(0, 60)}"`;
			if (result.status === "completed") digest.pass_rule.not_applied++;
			else digest.pass_rule.failed.push({ id, kind, status: result.status, text: `the run ended with the status ${result.status}; pass rule ${rule}` });
		}
		if (result.status !== "completed") digest.not_completed[result.status] = (digest.not_completed[result.status] ?? 0) + 1;
		const items = notRunItems(result);
		if (items.length) digest.not_run.push({ where: `run ${id} ${kind}`, count: items.length, not_selected: 0, items });
	}
	for (const v of scan.verdicts) {
		if (!within(v.created_at, since)) continue;
		digest.counts.checks++;
		const c = v.counts ?? { pass: 0, fail: 0, not_measured: 0, not_run: 0 };
		if (v.status === "fail") digest.pass_rule.failed.push({ id: v.id, kind: "check", status: "fail", text: `${c.fail} row${c.fail === 1 ? "" : "s"} fail of ${v.rows.length}` });
		const rows = v.rows.filter((r) => r.status === "not_run");
		if (rows.length) {
			const named = rows.filter((r) => r.reason !== NOT_SELECTED);
			digest.not_run.push({
				where: `check ${v.id}`,
				count: rows.length,
				not_selected: rows.length - named.length,
				items: named.map((r) => `${r.requirement}${r.condition === null ? "" : ` @ ${r.condition}`}${r.reason ? `: ${r.reason}` : ""}`),
			});
		}
	}
	return digest;
}

const cut = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};
const day = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** The first entries of a list, and one line with the number of the others. */
function some<T>(list: T[], max: number, line: (x: T) => string[], more: string): string[] {
	const out = list.slice(0, max).flatMap(line);
	if (list.length > max) out.push(`  ... ${list.length - max} more (${more})`);
	return out;
}

/** The digest as text: short lines, the items that need the owner first. */
export function formatDigest(d: Digest, max = 5): string {
	const lines = [`digest of ${basename(d.root)} since ${day(d.since)} UTC (to ${day(d.until)}): ${d.counts.experiments} run${d.counts.experiments === 1 ? "" : "s"} ended, ${d.counts.checks} check${d.counts.checks === 1 ? "" : "s"}`];
	lines.push("", `WAITING FOR OWNER: ${d.waiting.length} class A decision${d.waiting.length === 1 ? "" : "s"}`);
	lines.push(
		...some(
			d.waiting,
			max,
			({ decision: x, dependents }) => [
				`  A ${shortId(x.id)} since ${day(x.created_at)}: ${cut(x.statement, 120)}`,
				`    not taken: ${cut(x.alternative ?? "-", 100)}`,
				`    reverse: ${cut(x.reverse ?? "-", 100)}`,
				`    evidence: ${x.evidence.length ? cut(x.evidence.map((e) => e.path).join(", "), 100) : "none"}; results that rest on it: ${dependents}`,
			],
			"simra decision list --class A --status waiting",
		),
	);
	if (d.waiting.length) lines.push("  answer: simra decision answer <id> confirmed|changed|reversed --by <name>");
	lines.push("", `CLASS A ANSWERED: ${d.answered.length}`);
	lines.push(
		...some(
			d.answered,
			max,
			({ decision: x }) => {
				const last = x.answers[x.answers.length - 1];
				const marked = last && last.answer !== "confirmed" ? `; marked ${last.marked.length} result${last.marked.length === 1 ? "" : "s"}` : "";
				return [`  A ${shortId(x.id)} ${last?.answer ?? x.status} by ${last?.by ?? "?"} ${day(last?.at ?? x.created_at)}${marked}: ${cut(currentStatement(x), 100)}`];
			},
			"simra decision list --class A",
		),
	);
	lines.push("", `CLASS B: ${d.listed.length} (the work continued)`);
	lines.push(
		...some(
			d.listed,
			max,
			({ decision: x, dependents }) => [
				`  B ${shortId(x.id)} ${x.answers.length ? statusText(x).split(" ").slice(0, 3).join(" ") : "not confirmed"}: ${cut(currentStatement(x), 110)}`,
				`    reverse: ${cut(x.reverse ?? "-", 90)}; results: ${dependents}`,
			],
			"simra decision list --class B",
		),
	);
	lines.push(`CLASS C: ${d.logged} logged`);
	for (const file of d.unreadable) lines.push(`DECISION RECORD NOT READ: ${file} cannot be read. It is not in this digest.`);
	const p = d.pass_rule;
	lines.push("", `PASS RULE: ${p.changed.length} changed, ${p.failed.length} failed`);
	lines.push(...some(p.changed, max, (r) => [`  CHANGED ${r.id} ${r.kind}: ${cut(r.text, 140)}`], "simra show <id>"));
	lines.push(...some(p.failed, max, (r) => [`  FAILED ${r.kind === "check" ? `check ${r.id}` : `${r.id} ${r.kind}`}: ${cut(r.text, 120)}`], "simra list"));
	if (p.not_applied) lines.push(`  not judged: ${p.not_applied} completed run${p.not_applied === 1 ? " has" : "s have"} a pass rule. The kernel records a pass rule; it does not apply it.`);
	const total = d.not_run.reduce((n, x) => n + x.count, 0);
	lines.push("", `NOT RUN: ${total} item${total === 1 ? "" : "s"} in ${d.not_run.length} record${d.not_run.length === 1 ? "" : "s"}`);
	lines.push(
		...some(
			d.not_run,
			max,
			(x) => [
				`  ${x.where}: ${x.count} not run${x.not_selected ? ` (${x.not_selected} not selected)` : ""}`,
				...x.items.slice(0, 3).map((i) => `    ${cut(i, 130)}`),
				...(x.items.length > 3 ? [`    ... ${x.items.length - 3} more`] : []),
			],
			"simra query --source checks --status not_run",
		),
	);
	const states = Object.entries(d.not_completed).sort(([a], [b]) => a.localeCompare(b));
	if (states.length) lines.push(`RUNS THAT DID NOT COMPLETE: ${states.map(([s, n]) => `${n} ${s}`).join(", ")} (simra list)`);
	return lines.join("\n");
}
