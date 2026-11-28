// The owner digest: what the owner must see of a design root since a given time, short enough for a small screen.
//   - the class A decisions that wait for the owner (all of them, also the old ones), and the answered ones;
//   - the class B decisions (the work continued; the owner did not confirm them);
//   - the results whose pass rule changed, the runs with a pass rule that did not complete, and the checks that failed;
//   - the checks that are recorded as not run.
// It reads the records only (simra/decisions, simra/experiments, simra/checks). It runs no tool and writes nothing.
// A list is cut after a few entries; its count is never cut.

import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { currentStatement, type DecisionRecord, type DecisionScan, decisionDependents, readDecisions, scanRecords, shortId, waitsForOwner } from "./decisions.ts";
import { passRuleFlags } from "./passrule.ts";
import { experimentDir } from "./records.ts";

/**
 * A time for --since: an ISO date or time ("2026-11-27", "2026-11-27T18:00:00Z"), or a duration back from now
 * ("90m", "24h", "3d", "2w"). It throws on another text.
 */
export function parseSince(value: string, now = new Date()): Date {
	const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(value.trim());
	const t = m ? now.getTime() - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "m" | "h" | "d" | "w"] : /^\d{4}-\d{2}-\d{2}/.test(value.trim()) ? Date.parse(value.trim()) : Number.NaN;
	// A duration that goes back before the first date of the calendar is not a time.
	if (Number.isNaN(t) || Number.isNaN(new Date(t).getTime())) throw new Error(`since "${value}": give an ISO date or time (2026-11-27, 2026-11-27T18:00:00Z) or a duration (90m, 24h, 3d, 2w)`);
	return new Date(t);
}

export interface DigestDecision {
	decision: DecisionRecord;
	/** The number of results that rest on the decision now. A run without a result is not counted. */
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
	/** The items that are recorded as not run. */
	count: number;
	/** Of count: the rows that the check did not select. */
	not_selected: number;
	/** A check: the rows whose experiment completed without a value for the row (not measured). They are not in count. */
	not_measured: number;
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
	/** Class C with an answer of the owner, decided or answered since. */
	logged_answered: DigestDecision[];
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

/** The name of the check in a "not run" text: the words before "not run" ("timing check: not run (...)" gives "timing check"). */
const checkName = (line: string): string => line.slice(0, Math.max(0, line.search(/\bnot run\b/i))).replace(/\b(is|check)\s*$/i, "");

function notRunItems(result: { diagnostics?: { message: string }[]; report?: string[]; measurements?: Record<string, { reason?: string }>; tool?: Record<string, unknown> | null }): string[] {
	// One check is often recorded three times (a measurement, a report line, a diagnostic). A line is left out only
	// when an item with the same check name is in the list. Two lines of two checks are two items.
	const out: string[] = [];
	const names = new Set<string>();
	const add = (name: string, line: string) => {
		const key = name.replace(/[\s:;,(_-]+/g, " ").trim().toLowerCase() || line.trim().toLowerCase();
		if (names.has(key)) return;
		names.add(key);
		out.push(line);
	};
	for (const [name, m] of Object.entries(result.measurements ?? {})) {
		if (!m?.reason || !NOT_RUN.test(m.reason)) continue;
		add(name, `${name}: ${m.reason}`);
		// A report line that repeats the reason of the measurement is the same check.
		names.add(m.reason.trim().toLowerCase());
	}
	const items = (result.tool as { check?: { items?: { name: string; status: string; reason?: string }[] } } | null | undefined)?.check?.items;
	if (Array.isArray(items)) for (const i of items) if (i?.status === "not run") add(String(i.name), `${i.name}: not run${i.reason ? ` (${i.reason})` : ""}`);
	for (const line of result.report ?? []) if (typeof line === "string" && NOT_RUN.test(line)) add(checkName(line), line);
	for (const d of result.diagnostics ?? []) if (typeof d?.message === "string" && NOT_RUN.test(d.message)) add(checkName(d.message), d.message);
	return out;
}

/**
 * The newest change time of the files that a pass rule flag of a run reads: the two records of the run and the rule
 * file. A rule file that is gone has no time: the time of the nearest folder above it that is there is used (a removal
 * changes its folder). null: a time cannot be read.
 */
function ruleFilesChanged(root: string, id: string, ruleFile: string | undefined): number | null {
	let newest = 0;
	try {
		for (const name of ["experiment.json", "result.json"]) newest = Math.max(newest, statSync(join(experimentDir(root, id), name)).mtimeMs);
	} catch {
		return null;
	}
	if (!ruleFile) return newest;
	for (let path = join(root, ruleFile), i = 0; i < 64; path = dirname(path), i++) {
		try {
			return Math.max(newest, statSync(path).mtimeMs);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) return null;
		}
	}
	return null;
}

const within = (time: string | undefined | null, since: Date): boolean => typeof time === "string" && Date.parse(time) >= since.getTime();

/** Read the records of the design root and collect the digest since the given time. */
export function buildDigest(root: string, since: Date, now = new Date()): Digest {
	const { decisions, unreadable } = readDecisions(root);
	const scan: DecisionScan = scanRecords(root);
	const entry = (decision: DecisionRecord): DigestDecision => ({ decision, dependents: decisionDependents(root, decision, scan).filter((m) => !m.no_result).length });
	const recent = (d: DecisionRecord) => within(d.created_at, since) || d.answers.some((a) => within(a.at, since));
	const digest: Digest = {
		root,
		since: since.toISOString(),
		until: now.toISOString(),
		waiting: decisions.filter(waitsForOwner).map(entry),
		answered: decisions.filter((d) => d.class === "A" && !waitsForOwner(d) && recent(d)).map(entry),
		listed: decisions.filter((d) => d.class === "B" && recent(d)).map(entry),
		logged: decisions.filter((d) => d.class === "C" && recent(d)).length,
		logged_answered: decisions.filter((d) => d.class === "C" && d.answers.length > 0 && recent(d)).map(entry),
		unreadable,
		pass_rule: { changed: [], failed: [], not_applied: 0 },
		not_run: [],
		not_completed: {},
		counts: { experiments: 0, checks: 0 },
	};
	for (const { id, experiment, result } of scan.experiments) {
		if (!result) continue;
		const kind = `${experiment.adapter?.name ?? "?"}.${experiment.operation}`;
		const ended = within(result.finished_at, since);
		let flags: string[] = [];
		try {
			flags = passRuleFlags(root, experiment, result);
		} catch {}
		// A pass rule can change after its run ended. A run that ended before the given time is named when its rule
		// file or one of its records changed in the time of the digest, or when the time of the change cannot be read.
		// The flags of a change before the run started are first in the list: they belong to the time of the run.
		// A file time has parts of a millisecond, and the time of the digest has none: the file time is cut.
		const late = ended ? [] : flags.slice(experiment.pass_rule?.changed_after_results?.length ?? 0);
		const changedAt = late.length ? ruleFilesChanged(root, id, experiment.pass_rule?.file) : null;
		if (ended && flags.length) digest.pass_rule.changed.push({ id, kind, status: result.status, text: flags[0].replace(/^PASS RULE CHANGED: /, "") });
		else if (late.length && (changedAt === null || (changedAt >= since.getTime() && Math.floor(changedAt) <= now.getTime()))) digest.pass_rule.changed.push({ id, kind, status: result.status, text: late[0].replace(/^PASS RULE CHANGED: /, "") });
		if (!ended) continue;
		digest.counts.experiments++;
		if (experiment.pass_rule) {
			const rule = experiment.pass_rule.key ?? `"${(experiment.pass_rule.text ?? "").trim().split("\n")[0].slice(0, 60)}"`;
			if (result.status === "completed") digest.pass_rule.not_applied++;
			else digest.pass_rule.failed.push({ id, kind, status: result.status, text: `the run ended with the status ${result.status}; pass rule ${rule}` });
		}
		if (result.status !== "completed") digest.not_completed[result.status] = (digest.not_completed[result.status] ?? 0) + 1;
		const items = notRunItems(result);
		if (items.length) digest.not_run.push({ where: `run ${id} ${kind}`, count: items.length, not_selected: 0, not_measured: 0, items });
	}
	for (const v of scan.verdicts) {
		if (!within(v.created_at, since)) continue;
		digest.counts.checks++;
		const c = v.counts ?? { pass: 0, fail: 0, not_measured: 0, not_run: 0 };
		if (v.status === "fail") digest.pass_rule.failed.push({ id: v.id, kind: "check", status: "fail", text: `${c.fail} row${c.fail === 1 ? "" : "s"} fail of ${v.rows.length}` });
		const rows = v.rows.filter((r) => r.status === "not_run");
		const unmeasured = v.rows.filter((r) => r.status === "not_measured");
		if (rows.length || unmeasured.length) {
			// A gate row gives the reason of its row after its own words ("no result at the required corner ss: not selected in this check").
			const named = rows.filter((r) => !(r.reason === NOT_SELECTED || r.reason?.endsWith(`: ${NOT_SELECTED}`)));
			const name = (r: (typeof rows)[number]) => `${r.requirement}${r.condition === null ? "" : ` @ ${r.condition}`}`;
			digest.not_run.push({
				where: `check ${v.id}`,
				count: rows.length,
				not_selected: rows.length - named.length,
				not_measured: unmeasured.length,
				items: [...named.map((r) => `${name(r)}${r.reason ? `: ${r.reason}` : ""}`), ...unmeasured.map((r) => `${name(r)}: not measured${r.reason ? `: ${r.reason}` : ""}`)],
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

/** One line of a decision that the owner answered: the class, who answered and when, the marked results, the statement that holds. */
function answeredLine(x: DecisionRecord): string {
	const last = x.answers[x.answers.length - 1];
	const results = last ? last.marked.filter((m) => !m.no_result).length : 0;
	const marked = last && last.answer !== "confirmed" ? `; marked ${results} result${results === 1 ? "" : "s"}` : "";
	return `  ${x.class} ${shortId(x.id)} ${last?.answer ?? x.status} by ${cut(last?.by ?? "?", 40)} ${day(last?.at ?? x.created_at)}${marked}: ${cut(currentStatement(x), 100)}`;
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
			({ decision: x }) => [answeredLine(x)],
			"simra decision list --class A",
		),
	);
	lines.push("", `CLASS B: ${d.listed.length} (the work continued)`);
	lines.push(
		...some(
			d.listed,
			max,
			({ decision: x, dependents }) => [
				`  B ${shortId(x.id)} ${x.answers.length ? `${x.answers[x.answers.length - 1].answer} by ${cut(x.answers[x.answers.length - 1].by, 40)}` : "not confirmed"}: ${cut(currentStatement(x), 110)}`,
				`    reverse: ${cut(x.reverse ?? "-", 90)}; results: ${dependents}`,
			],
			"simra decision list --class B",
		),
	);
	lines.push(`CLASS C: ${d.logged} logged${d.logged_answered.length ? `, ${d.logged_answered.length} answered by the owner` : ""}`);
	lines.push(...some(d.logged_answered, max, ({ decision: x }) => [answeredLine(x)], "simra decision list --class C"));
	for (const file of d.unreadable) lines.push(`DECISION RECORD NOT READ: ${file} cannot be read. It is not in this digest.`);
	const p = d.pass_rule;
	lines.push("", `PASS RULE: ${p.changed.length} changed, ${p.failed.length} failed`);
	lines.push(...some(p.changed, max, (r) => [`  CHANGED ${r.id} ${r.kind}: ${cut(r.text, 140)}`], "simra show <id>"));
	lines.push(...some(p.failed, max, (r) => [`  FAILED ${r.kind === "check" ? `check ${r.id}` : `${r.id} ${r.kind}`}: ${cut(r.text, 120)}`], "simra list"));
	if (p.not_applied) lines.push(`  not judged: ${p.not_applied} completed run${p.not_applied === 1 ? " has" : "s have"} a pass rule. The kernel records a pass rule; it does not apply it.`);
	const total = d.not_run.reduce((n, x) => n + x.count, 0);
	const unmeasured = d.not_run.reduce((n, x) => n + x.not_measured, 0);
	const records = d.not_run.filter((x) => x.count > 0).length;
	lines.push("", `NOT RUN: ${total} item${total === 1 ? "" : "s"} in ${records} record${records === 1 ? "" : "s"}${unmeasured ? `; NOT MEASURED: ${unmeasured} row${unmeasured === 1 ? "" : "s"}` : ""}`);
	lines.push(
		...some(
			d.not_run,
			max,
			(x) => [
				`  ${x.where}: ${x.count} not run${x.not_selected ? ` (${x.not_selected} not selected)` : ""}${x.not_measured ? `, ${x.not_measured} not measured` : ""}`,
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
