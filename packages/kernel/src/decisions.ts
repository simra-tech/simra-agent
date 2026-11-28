// Decision records. An agent writes one at the moment it decides: what it chose, the alternative that it did not take,
// why, how to reverse the choice, the evidence, and what the choice affects. The records are plain JSON files in the
// design repository, next to the experiment records:
//
//   <root>/simra/decisions/<id>.json   one decision (schema simra.decision/0)
//
// Each decision has a class:
//   A  it changes the scope, the cost, the schedule, an external claim or a number that a third party will see.
//      The decision waits for the owner (status "waiting for owner"). A run that cites it does not start.
//   B  a technical direction that is costly to reverse. The work continues; the decision is listed for the owner.
//   C  routine. The decision is in the log only.
//
// "adopted" (by the policy above) is never the same as an answer of the owner. The owner answers a decision with
// confirmed, changed or reversed; the answer is added to the record. A changed or reversed decision marks the results
// that depended on it. A result depends on a decision when its run cites the decision (experiment.json "decisions"),
// or when the decision names it in "affects": an experiment, a check, a pass rule, a file, a requirement or an
// assumption. The summary of such a result has a line "UNCONFIRMED DECISION", "DECISION REVERSED" or "DECISION
// CHANGED". The lines are computed from the records, as the pass rule flags are (passrule.ts); no result is rewritten.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { ackDecisionInbox, type DecisionMarker, INBOX_SCHEMA, readDecisionInbox, writeDecisionMarker } from "./inbox.ts";
import { experimentDir, experimentsDir, type ExperimentRecord, newExperimentId, readJson, type ResultRecord, writeJsonAtomic } from "./records.ts";
import type { VerdictRecord } from "./requirements.ts";

// The directory of the checks (requirements.ts checksDir). It is repeated here: requirements.ts imports the runner,
// and the runner imports this file.
const checksDir = (root: string): string => join(root, "simra", "checks");

export const DECISION_SCHEMA = "simra.decision/0";

export type DecisionClass = "A" | "B" | "C";
export const DECISION_CLASSES: DecisionClass[] = ["A", "B", "C"];

/** "waiting for owner": class A without an answer. "adopted": class B or C without an answer. Else the last answer of the owner. */
export type DecisionStatus = "waiting for owner" | "adopted" | "confirmed" | "changed" | "reversed";
export type OwnerAnswer = "confirmed" | "changed" | "reversed";
export const OWNER_ANSWERS: OwnerAnswer[] = ["confirmed", "changed", "reversed"];

/**
 * What a decision affects. experiment and check: the id of a record. pass_rule: the key of a pass rule (its id, or its
 * file path). file: a file or a directory of the design root. requirement and assumption: an id of requirements.json.
 * claim: a statement for a reader outside the project, as a text (no record is matched).
 */
export type AffectKind = "experiment" | "check" | "pass_rule" | "file" | "requirement" | "assumption" | "claim";
export const AFFECT_KINDS: AffectKind[] = ["experiment", "check", "pass_rule", "file", "requirement", "assumption", "claim"];

export interface DecisionAffect {
	kind: AffectKind;
	ref: string;
}

/** An evidence file of the design root, with its hash at the time of the decision. */
export interface DecisionEvidence {
	path: string;
	sha256: string;
	bytes: number;
}

/** A result that depended on a decision when the owner changed or reversed it. */
export interface DecisionMark {
	kind: "experiment" | "check";
	id: string;
	/** How the result depends on the decision, for example "cited by the run" or "file rtl/top.v". */
	via: string;
	/** true: a run without result.json at that time (it waits or it runs). It is not a result; its later result has the mark. */
	no_result?: true;
}

export interface DecisionAnswer {
	answer: OwnerAnswer;
	at: string;
	/** Who answered, as the caller gave it. */
	by: string;
	/** How the answer arrived: the command line, or a command that the user typed in a session. */
	via: "cli" | "session";
	/** cli: true when the command ran in a terminal. An answer from a script or from the shell of an agent has false. */
	terminal: boolean;
	note?: string;
	/** changed: the statement of the owner, which replaces the statement of the decision. */
	statement?: string;
	/** changed and reversed: the results that depended on the decision at the time of the answer. */
	marked: DecisionMark[];
}

export interface DecisionRecord {
	schema: typeof DECISION_SCHEMA;
	id: string;
	created_at: string;
	class: DecisionClass;
	/** What was decided. */
	statement: string;
	/** The alternative that was not taken (null: class C without one). */
	alternative: string | null;
	why: string;
	/** How to reverse the decision, and what that costs (null: class C without one). */
	reverse: string | null;
	evidence: DecisionEvidence[];
	affects: DecisionAffect[];
	/** Who decided, as the caller gave it (for example the name of an agent or of a session), or null. */
	decided_by: string | null;
	status: DecisionStatus;
	/** "policy": adopted by the class rule, without an answer of the owner. "owner": the owner answered. */
	authority: "policy" | "owner";
	/** The answers of the owner, oldest first. The status is the last answer. */
	answers: DecisionAnswer[];
}

/** What the caller gives. An entry of affects is {kind, ref} or the text "kind:ref". An entry of evidence is a path, or the id of an experiment or of a check. */
export interface DecisionInput {
	class: DecisionClass;
	statement: string;
	alternative?: string;
	why: string;
	reverse?: string;
	evidence?: string[];
	affects?: (DecisionAffect | string)[];
	decided_by?: string;
}

export function decisionsDir(root: string): string {
	return join(root, "simra", "decisions");
}

const text = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
const rankOf: Record<DecisionClass, number> = { C: 0, B: 1, A: 2 };

/** The entries of affects as {kind, ref}; a text "kind:ref" is split at the first colon. An entry that is neither stays as it is. */
function affectsOf(input: DecisionInput): unknown[] {
	if (!Array.isArray(input.affects)) return [];
	return input.affects.map((a) => {
		if (typeof a !== "string") return a;
		const i = a.indexOf(":");
		return i < 0 ? a : { kind: a.slice(0, i).trim(), ref: a.slice(i + 1).trim() };
	});
}

const validAffect = (a: unknown): a is DecisionAffect => !!a && typeof a === "object" && AFFECT_KINDS.includes((a as DecisionAffect).kind) && text((a as DecisionAffect).ref);

/** Every problem of the input, so that the author can fix them all at once. An empty list means valid. */
export function validateDecision(input: DecisionInput): string[] {
	const errors: string[] = [];
	if (!input || typeof input !== "object") return ["a decision is an object with class, statement, why, alternative, reverse, evidence and affects"];
	const known = ["class", "statement", "alternative", "why", "reverse", "evidence", "affects", "decided_by"];
	for (const k of Object.keys(input)) if (!known.includes(k)) errors.push(`${k}: unknown field; the fields are ${known.join(", ")}`);
	const cls = input.class;
	if (!DECISION_CLASSES.includes(cls)) errors.push(`class is ${JSON.stringify(cls)}, expected A (scope, cost, schedule, an external claim or a number for a third party), B (a technical direction that is costly to reverse) or C (routine)`);
	if (!text(input.statement)) errors.push("statement is required: what was decided");
	if (!text(input.why)) errors.push("why is required");
	for (const k of ["alternative", "reverse", "decided_by"] as const) if (input[k] !== undefined && !text(input[k])) errors.push(`${k} must be a text`);
	if (input.evidence !== undefined && !(Array.isArray(input.evidence) && input.evidence.every(text))) errors.push("evidence must be a list of paths in the design root (or ids of experiments or checks)");
	if (input.affects !== undefined && !Array.isArray(input.affects)) errors.push("affects must be a list");
	const affects = affectsOf(input);
	for (const a of affects) if (!validAffect(a)) errors.push(`affects entry ${JSON.stringify(a)}: give {kind, ref} or "kind:ref"; the kinds are ${AFFECT_KINDS.join(", ")}`);
	if (!DECISION_CLASSES.includes(cls)) return errors;
	if (cls !== "C") {
		if (!text(input.alternative)) errors.push(`alternative is required for class ${cls}: the alternative that was not taken`);
		if (!text(input.reverse)) errors.push(`reverse is required for class ${cls}: how to reverse the decision, and what that costs`);
		if (!affects.some(validAffect)) errors.push(`affects is required for class ${cls}: name at least one experiment, check, pass_rule, file, requirement, assumption or claim`);
	}
	// The class has a floor that follows from what the decision affects.
	const kinds = new Set(affects.filter(validAffect).map((a) => a.kind));
	if (kinds.has("claim") && cls !== "A") errors.push(`class ${cls} with a claim in affects: a decision that affects a claim for a reader outside the project is class A`);
	const rules = (["pass_rule", "requirement", "assumption"] as const).filter((k) => kinds.has(k));
	if (rules.length && rankOf[cls] < rankOf.B) errors.push(`class C with ${rules.join(", ")} in affects: a decision that changes what passes is class B or A`);
	return errors;
}

const VALID_ID = /^[\w.-]+$/;

/** An evidence entry as a path relative to the design root: a path, or the id of an experiment (its result.json) or of a check (its verdict.json). */
function evidencePath(root: string, entry: string): string {
	if (VALID_ID.test(entry) && !existsSync(resolve(root, entry))) {
		const result = join(experimentDir(root, entry), "result.json");
		if (existsSync(result)) return relative(root, result);
		const verdict = join(checksDir(root), entry, "verdict.json");
		if (existsSync(verdict)) return relative(root, verdict);
	}
	const full = resolve(root, entry);
	const path = relative(resolve(root), full);
	if (!inRoot(path)) throw new Error(`decision: the evidence ${entry} is not in the design root`);
	let isFile = false;
	try {
		isFile = statSync(full).isFile();
	} catch {}
	if (!isFile) throw new Error(`decision: the evidence ${entry} is not a file of the design root (and not the id of an experiment with a result, or of a check). Evidence that is not there is not evidence: leave it out and say so in why.`);
	// The file that is read and hashed is the target of a link: it must be in the design root too.
	if (!inRoot(relative(realpathSync(resolve(root)), realpathSync(full)))) throw new Error(`decision: the evidence ${entry} is a link to a file that is not in the design root`);
	return path;
}

/** true for a relative path that stays in the root ("..x" is a file name, "../x" leaves the root). */
const inRoot = (path: string): boolean => path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);

function hashEvidence(root: string, path: string): DecisionEvidence {
	const data = readFileSync(join(root, path));
	return { path, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
}

/** The first status of a class: A waits for the owner, B and C are adopted. */
export const firstStatus = (cls: DecisionClass): DecisionStatus => (cls === "A" ? "waiting for owner" : "adopted");

/**
 * Check the input and write the record. A class A decision gets the status "waiting for owner" and a marker in the
 * inbox of the design root. It throws on an invalid input, with every problem in the message.
 */
export function recordDecision(root: string, input: DecisionInput, now = new Date()): DecisionRecord {
	const errors = validateDecision(input);
	if (errors.length) throw new Error(`invalid decision:\n- ${errors.join("\n- ")}`);
	const evidence = [...new Set((input.evidence ?? []).map((e) => evidencePath(root, e.trim())))].map((p) => hashEvidence(root, p));
	const affects = (affectsOf(input) as DecisionAffect[]).map((a) => ({ kind: a.kind, ref: a.kind === "file" ? affectPath(root, a.ref) : a.ref.trim() }));
	// A record that is named must be there: a wrong id would mark nothing, without a word.
	for (const a of affects) {
		if (a.kind === "experiment" && !(VALID_ID.test(a.ref) && existsSync(join(experimentDir(root, a.ref), "experiment.json")))) throw new Error(`invalid decision:\n- affects names the experiment ${a.ref}, and simra/experiments has no such record (give the full id)`);
		if (a.kind === "check" && !(VALID_ID.test(a.ref) && existsSync(join(checksDir(root), a.ref, "verdict.json")))) throw new Error(`invalid decision:\n- affects names the check ${a.ref}, and simra/checks has no such record (give the full id)`);
	}
	mkdirSync(decisionsDir(root), { recursive: true });
	let id = newExperimentId(now);
	while (existsSync(decisionPath(root, id))) id = newExperimentId(now);
	const record: DecisionRecord = {
		schema: DECISION_SCHEMA,
		id,
		created_at: now.toISOString(),
		class: input.class,
		statement: input.statement.trim(),
		alternative: input.alternative?.trim() ?? null,
		why: input.why.trim(),
		reverse: input.reverse?.trim() ?? null,
		evidence,
		affects,
		decided_by: input.decided_by?.trim() ?? null,
		status: firstStatus(input.class),
		authority: "policy",
		answers: [],
	};
	writeJsonAtomic(decisionPath(root, id), record);
	if (record.class === "A") writeDecisionMarker(root, { kind: "decision", decision: id, class: "A", statement: record.statement, at: record.created_at });
	return record;
}

/** A file reference of affects as a path relative to the design root. It throws for a path outside the root. */
function affectPath(root: string, ref: string): string {
	const path = relative(resolve(root), resolve(root, ref.trim()));
	if (!inRoot(path)) throw new Error(`decision: the file ${ref} of affects is not in the design root`);
	return normalize(path);
}

function decisionPath(root: string, id: string): string {
	return join(decisionsDir(root), `${id}.json`);
}

const isTime = (x: unknown): x is string => typeof x === "string" && !Number.isNaN(Date.parse(x));
const validAnswer = (a: DecisionAnswer): boolean =>
	!!a && typeof a === "object" && OWNER_ANSWERS.includes(a.answer) && isTime(a.at) && text(a.by) && (a.answer !== "changed" || text(a.statement)) && Array.isArray(a.marked) && a.marked.every((m) => !!m && (m.kind === "experiment" || m.kind === "check") && text(m.id));

/**
 * true for a complete record with the given id. The status must follow from the class and the answers: a record
 * without its status, or a class A record that says "confirmed" without an answer, is not read. So a damaged record
 * cannot let a run start.
 */
function validRecord(d: DecisionRecord, id: string): boolean {
	if (!d || typeof d !== "object" || d.schema !== DECISION_SCHEMA || d.id !== id || !DECISION_CLASSES.includes(d.class)) return false;
	if (!text(d.statement) || !text(d.why) || !isTime(d.created_at)) return false;
	for (const k of ["alternative", "reverse", "decided_by"] as const) if (d[k] != null && typeof d[k] !== "string") return false;
	if (!Array.isArray(d.evidence) || !d.evidence.every((e) => !!e && typeof e === "object" && text(e.path) && typeof e.sha256 === "string")) return false;
	if (!Array.isArray(d.affects) || !d.affects.every(validAffect)) return false;
	if (!Array.isArray(d.answers) || !d.answers.every(validAnswer)) return false;
	const last = d.answers[d.answers.length - 1];
	return d.status === (last ? last.answer : firstStatus(d.class)) && d.authority === (last ? "owner" : "policy");
}

/** The decisions of the design root, oldest first, and the record files that cannot be read (never left out without a word). */
export function readDecisions(root: string): { decisions: DecisionRecord[]; unreadable: string[] } {
	let names: string[];
	try {
		names = readdirSync(decisionsDir(root)).filter((n) => n.endsWith(".json")).sort();
	} catch {
		return { decisions: [], unreadable: [] };
	}
	const decisions: DecisionRecord[] = [];
	const unreadable: string[] = [];
	for (const name of names) {
		const file = join("simra", "decisions", name);
		try {
			const d = readJson<DecisionRecord>(join(root, file));
			if (validRecord(d, name.slice(0, -5))) decisions.push(d);
			else unreadable.push(file);
		} catch {
			unreadable.push(file);
		}
	}
	// Two ids of the same second sort by their random part: the time of the record decides.
	decisions.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
	return { decisions, unreadable };
}

export function listDecisions(root: string): DecisionRecord[] {
	return readDecisions(root).decisions;
}

/** The end of an id (the 6 characters after the time), as a short handle for a reader. */
export const shortId = (id: string): string => id.slice(id.lastIndexOf("-") + 1);

/**
 * One decision by its id, or by the start or the end of its id (at least 4 characters, for example the 6 characters
 * after the time). It throws when no decision or more than one decision matches.
 */
export function findDecision(root: string, ref: string, decisions = listDecisions(root)): DecisionRecord {
	const exact = decisions.find((d) => d.id === ref);
	if (exact) return exact;
	const part = ref.trim();
	const found = part.length >= 4 ? decisions.filter((d) => d.id.startsWith(part) || d.id.endsWith(part)) : [];
	if (found.length === 1) return found[0];
	if (found.length > 1) throw new Error(`decision "${ref}": ${found.length} decisions match (${found.map((d) => d.id).join(", ")}); give more of the id`);
	throw new Error(`decision "${ref}" is not in simra/decisions${part.length < 4 ? " (give the id, or at least 4 characters of its start or end)" : ""}`);
}

/** The statement that holds now: the statement of the owner after a "changed" answer, else the statement of the decision. */
export function currentStatement(d: DecisionRecord): string {
	// The last "changed" answer holds, also after a later "confirmed" or "reversed".
	for (let i = d.answers.length - 1; i >= 0; i--) {
		const a = d.answers[i];
		if (a.answer === "changed" && a.statement) return a.statement;
	}
	return d.statement;
}

const lastAnswer = (d: DecisionRecord): DecisionAnswer | null => d.answers[d.answers.length - 1] ?? null;

// The records that a dependency is matched against.

export interface DecisionExperiment {
	id: string;
	experiment: ExperimentRecord;
	result: ResultRecord | null;
}

/** The experiments and the verdicts of a design root, read once for several decisions. A record that cannot be read is skipped. */
export interface DecisionScan {
	experiments: DecisionExperiment[];
	verdicts: VerdictRecord[];
}

export function scanRecords(root: string): DecisionScan {
	const experiments: DecisionExperiment[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(experimentsDir(root)).sort();
	} catch {}
	for (const id of names) {
		const dir = experimentDir(root, id);
		try {
			const experiment = readJson<ExperimentRecord>(join(dir, "experiment.json"));
			let result: ResultRecord | null = null;
			try {
				if (existsSync(join(dir, "result.json"))) result = readJson<ResultRecord>(join(dir, "result.json"));
			} catch {}
			experiments.push({ id, experiment, result });
		} catch {}
	}
	// Two ids of the same second sort by their random part: the time of the record decides.
	experiments.sort((a, b) => String(a.experiment.created_at).localeCompare(String(b.experiment.created_at)) || a.id.localeCompare(b.id));
	return { experiments, verdicts: listVerdicts(root) };
}

/** All verdicts of the design root, oldest first. A verdict that cannot be read is skipped. */
export function listVerdicts(root: string): VerdictRecord[] {
	let names: string[] = [];
	try {
		names = readdirSync(checksDir(root)).sort();
	} catch {}
	const out: VerdictRecord[] = [];
	for (const id of names) {
		try {
			const v = readJson<VerdictRecord>(join(checksDir(root), id, "verdict.json"));
			if (v && Array.isArray(v.rows)) out.push(v);
		} catch {}
	}
	return out;
}

/** true when the path is the reference, or a file under the reference (a directory). Both are relative to the design root. */
function underPath(root: string, path: unknown, ref: string): boolean {
	if (typeof path !== "string" || !path) return false;
	const rel = normalize(isAbsolute(path) ? relative(resolve(root), path) : path);
	// "." is the design root: every path in it.
	if (ref === ".") return inRoot(rel);
	return rel === ref || rel.startsWith(`${ref}/`);
}

/** Every text in the inputs of an experiment (a deck, a run directory, a list of files). */
function inputTexts(value: unknown, out: string[] = [], depth = 0): string[] {
	if (typeof value === "string") out.push(value);
	else if (depth < 4 && Array.isArray(value)) for (const v of value) inputTexts(v, out, depth + 1);
	else if (depth < 4 && value && typeof value === "object") for (const v of Object.values(value)) inputTexts(v, out, depth + 1);
	return out;
}

/** How an experiment depends on a decision, or null when it does not. */
export function experimentDependsOn(root: string, d: DecisionRecord, e: DecisionExperiment): string | null {
	if (e.experiment.decisions?.includes(d.id)) return "cited by the run";
	for (const a of d.affects) {
		if (a.kind === "experiment" && a.ref === e.id) return "named by the decision";
		// A pass rule is named by its key (its id, else its file) or by its file.
		const rule = e.experiment.pass_rule;
		if (a.kind === "pass_rule" && rule && (rule.key === a.ref || (typeof rule.file === "string" && normalize(rule.file) === normalize(a.ref)))) return `pass rule ${a.ref}`;
		if (a.kind === "file") {
			const files = [...(e.result?.input_files?.files ?? []).map((f) => f.path), e.experiment.pass_rule?.file, ...inputTexts(e.experiment.inputs)];
			if (files.some((f) => underPath(root, f, a.ref))) return `file ${a.ref}`;
		}
	}
	return null;
}

/** How a check depends on a decision, or null when it does not. A check depends on a decision when one of its experiments does. */
export function verdictDependsOn(root: string, d: DecisionRecord, v: VerdictRecord, experiments: DecisionExperiment[]): string | null {
	for (const a of d.affects) {
		if (a.kind === "check" && a.ref === v.id) return "named by the decision";
		if (a.kind === "requirement" && v.rows.some((r) => r.requirement === a.ref)) return `requirement ${a.ref}`;
		if (a.kind === "assumption" && v.rows.some((r) => r.assumptions?.includes(a.ref))) return `assumption ${a.ref}`;
		// A reported row is not scored, but its value is in the summary of the check.
		if (a.kind === "requirement" && v.reported?.some((r) => r.requirement === a.ref)) return `requirement ${a.ref} (reported row)`;
		if (a.kind === "assumption" && v.reported?.some((r) => r.assumptions?.includes(a.ref))) return `assumption ${a.ref} (reported row)`;
		if (a.kind === "file" && (underPath(root, v.requirements_file?.path, a.ref) || underPath(root, v.design_file?.path, a.ref))) return `file ${a.ref}`;
	}
	const ids = new Set((v.experiments ?? []).map((x) => x.id));
	for (const e of experiments) {
		if (!ids.has(e.id)) continue;
		if (experimentDependsOn(root, d, e) !== null) return `experiment ${e.id}`;
	}
	return null;
}

/**
 * The results that depend on a decision now: experiments first, then checks, each oldest first. A run without
 * result.json is in the list with no_result: it is not a result, and its later result depends on the decision.
 */
export function decisionDependents(root: string, d: DecisionRecord, scan: DecisionScan = scanRecords(root)): DecisionMark[] {
	const out: DecisionMark[] = [];
	for (const e of scan.experiments) {
		const via = experimentDependsOn(root, d, e);
		if (via !== null) out.push({ kind: "experiment", id: e.id, via, ...(e.result ? {} : { no_result: true as const }) });
	}
	for (const v of scan.verdicts) {
		const via = verdictDependsOn(root, d, v, scan.experiments);
		if (via !== null) out.push({ kind: "check", id: v.id, via });
	}
	return out;
}

/** A decision that the owner must still answer: class A, no answer. The answers decide, not the status text. */
export const waitsForOwner = (d: DecisionRecord): boolean => d.class === "A" && d.answers.length === 0;

const quote = (s: string, max = 160) => {
	const line = s.replace(/\s+/g, " ").trim();
	return `"${line.length > max ? `${line.slice(0, max - 3)}...` : line}"`;
};

interface ResultMark {
	answer: DecisionAnswer;
	/** The last answer of the decision, when it is later than the answer that marked the result. */
	later: DecisionAnswer | null;
}

/** The last "changed" or "reversed" answer that marked the result. A later answer does not take the mark away. */
function markOf(d: DecisionRecord, kind: DecisionMark["kind"], id: string): ResultMark | null {
	for (let i = d.answers.length - 1; i >= 0; i--) {
		const a = d.answers[i];
		if (a.answer !== "confirmed" && a.marked.some((m) => m.kind === kind && m.id === id)) return { answer: a, later: i < d.answers.length - 1 ? d.answers[d.answers.length - 1] : null };
	}
	return null;
}

/** The flag line of one decision for a result: the result is marked by an answer, or it depends now on a decision that waits. */
function flagLine(d: DecisionRecord, mark: ResultMark | null, live: boolean): string | null {
	if (mark) {
		const a = mark.answer;
		const later = mark.later ? ` The last answer of the owner is "${mark.later.answer}" (${mark.later.by}, ${mark.later.at}).` : "";
		if (a.answer === "reversed") return `DECISION REVERSED: the owner (${a.by}) reversed decision ${d.id} on ${a.at}: ${quote(currentStatement(d))}. This result depended on it. Do not use it for a claim.${later}`;
		return `DECISION CHANGED: the owner (${a.by}) changed decision ${d.id} on ${a.at}: now ${quote(a.statement ?? currentStatement(d))}. This result depended on the earlier statement. Judge it again, or run again.${later}`;
	}
	if (waitsForOwner(d) && live) {
		return `UNCONFIRMED DECISION: this result rests on decision ${d.id} (class A, waiting for owner since ${d.created_at}): ${quote(d.statement)}. The owner did not confirm it.`;
	}
	return null;
}

const flagged = (d: DecisionRecord): boolean => waitsForOwner(d) || d.answers.some((a) => a.answer !== "confirmed");

/**
 * The decision lines of one experiment: `UNCONFIRMED DECISION:` for a class A decision that waits for the owner and
 * that the result rests on; `DECISION REVERSED:` and `DECISION CHANGED:` for a result that the answer of the owner
 * marked. An empty list: no such decision.
 */
export function experimentDecisionFlags(root: string, experiment: ExperimentRecord, result: ResultRecord | null, decisions = listDecisions(root)): string[] {
	const out: string[] = [];
	const e = { id: experiment.id, experiment, result };
	for (const d of decisions) {
		if (!flagged(d)) continue;
		const line = flagLine(d, markOf(d, "experiment", e.id), waitsForOwner(d) && experimentDependsOn(root, d, e) !== null);
		if (line) out.push(line);
	}
	// A cited decision whose record is gone: the run rests on a decision that cannot be read.
	for (const id of experiment.decisions ?? []) {
		if (!decisions.some((d) => d.id === id)) out.push(`UNCONFIRMED DECISION: this run cites decision ${id}, and simra/decisions has no readable record of it.`);
	}
	return out;
}

/** The decision lines of one check (see experimentDecisionFlags). A check rests on a decision when one of its experiments does. */
export function verdictDecisionFlags(root: string, verdict: VerdictRecord, decisions = listDecisions(root)): string[] {
	const out: string[] = [];
	const wanted = decisions.filter(flagged);
	if (!wanted.length) return out;
	const experiments: DecisionExperiment[] = [];
	if (wanted.some(waitsForOwner)) {
		for (const x of verdict.experiments ?? []) {
			try {
				const dir = experimentDir(root, x.id);
				const result = existsSync(join(dir, "result.json")) ? readJson<ResultRecord>(join(dir, "result.json")) : null;
				experiments.push({ id: x.id, experiment: readJson<ExperimentRecord>(join(dir, "experiment.json")), result });
			} catch {}
		}
	}
	for (const d of wanted) {
		const line = flagLine(d, markOf(d, "check", verdict.id), waitsForOwner(d) && verdictDependsOn(root, d, verdict, experiments) !== null);
		if (line) out.push(line.replace("this result rests", "this check rests").replace("This result depended", "This check depended"));
	}
	return out;
}

/** `decision: <id> class B, adopted by policy (no answer of the owner): "<statement>"`, one line for a decision that a run cites. */
export function formatCited(d: DecisionRecord): string {
	return `decision: ${d.id} class ${d.class}, ${statusText(d)}: ${quote(currentStatement(d))}`;
}

/** The status with who gave it: "adopted by policy (no answer of the owner)", "confirmed by <name> <time>". */
export function statusText(d: DecisionRecord): string {
	const last = lastAnswer(d);
	if (!last) return d.status === "adopted" ? "adopted by policy (no answer of the owner)" : d.status;
	return `${last.answer} by ${last.by} ${last.at}${last.via === "cli" && !last.terminal ? " (command line, not from a terminal)" : ""}`;
}

/**
 * The decisions that a run cites, as full ids. It throws when a decision is not found, when a cited class A decision
 * waits for the owner, or when the owner reversed a cited decision: the run does not start.
 */
export function citeDecisions(root: string, refs: string[]): string[] {
	if (!Array.isArray(refs) || !refs.every((r) => typeof r === "string" && r)) throw new Error("decisions: give a list of decision ids");
	const { decisions: all, unreadable } = readDecisions(root);
	const ids: string[] = [];
	for (const ref of refs) {
		// A record that cannot be read can be a class A decision that waits: the run does not start.
		const damaged = unreadable.find((file) => {
			const id = file.slice(file.lastIndexOf("/") + 1, -5);
			return id === ref || (ref.trim().length >= 4 && (id.startsWith(ref.trim()) || id.endsWith(ref.trim())));
		});
		if (damaged) throw new Error(`the run did not start: the record of decision ${damaged.slice(damaged.lastIndexOf("/") + 1, -5)} cannot be read (${damaged}). Repair the record, or record the decision again.`);
		const d = findDecision(root, ref, all);
		if (waitsForOwner(d)) {
			throw new Error(`the run did not start: decision ${d.id} (class A) waits for the owner: ${quote(d.statement)}. Do work that does not depend on it. The owner answers with: simra decision answer ${shortId(d.id)} confirmed|changed|reversed --by <name>`);
		}
		if (d.status === "reversed") {
			const last = lastAnswer(d);
			throw new Error(`the run did not start: the owner (${last?.by ?? "owner"}) reversed decision ${d.id} on ${last?.at ?? "an unknown date"}: ${quote(d.statement)}. A run cannot rest on it.`);
		}
		if (!ids.includes(d.id)) ids.push(d.id);
	}
	return ids;
}

export interface AnswerInput {
	answer: OwnerAnswer;
	by: string;
	via?: "cli" | "session";
	terminal?: boolean;
	note?: string;
	/** changed: the statement of the owner. */
	statement?: string;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** How long a writer waits for the lock of a record before it gives up (a test can make it short). */
export const DECISION_LOCK = { wait_ms: 5000 };

/** true when a process of this host with the pid is there (EPERM: it is there, and it belongs to another user). */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Run fn while this process holds the lock of a record. The lock is a symbolic link `<record>.lock` whose target names
 * its owner (`pid:<pid>:<random>:<host>`), so the lock and its owner appear in one step. A lock is taken over only
 * when its owner is a process of this host that is gone. The age of a lock proves nothing: a writer can be paused
 * between its read and its write. A lock that this kernel did not write (for example a directory) is never removed.
 * fn gets held(): it throws when the lock is no longer the lock of this process; call it before the write.
 */
function withLock<T>(path: string, fn: (held: () => void) => T): T {
	const lock = `${path}.lock`;
	const token = `pid:${process.pid}:${randomBytes(6).toString("hex")}:${hostname()}`;
	const end = Date.now() + DECISION_LOCK.wait_ms;
	for (;;) {
		try {
			symlinkSync(token, lock);
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		let owner: string | null = null;
		try {
			owner = readlinkSync(lock);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
		}
		const m = owner === null ? null : /^pid:(\d+):[^:]*(?::(.*))?$/.exec(owner);
		const local = m !== null && (m[2] === undefined || m[2] === hostname());
		if (owner !== null && m !== null && local && !alive(Number(m[1]))) {
			// Two processes can find the same dead owner. A short guard lets one of them remove that lock, and only that lock.
			const guard = `${lock}.takeover`;
			try {
				mkdirSync(guard);
				try {
					if (readlinkSync(lock) === owner) unlinkSync(lock);
				} catch {
				} finally {
					rmdirSync(guard);
				}
				continue;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
				let age = 0;
				try {
					age = Date.now() - statSync(guard).mtimeMs;
				} catch {}
				if (age > 10_000) rmSync(guard, { recursive: true, force: true });
			}
		}
		if (Date.now() >= end) throw new Error(`the record ${path} is locked by another process (${m ? `process ${m[1]}${local ? "" : ` of host ${m[2]}`}` : "a lock that this kernel did not write"}): ${lock}. Nothing was written. Try again. When no process works on the record, remove the lock.`);
		sleepSync(25);
	}
	const held = () => {
		let now: string | null = null;
		try {
			now = readlinkSync(lock);
		} catch {}
		if (now !== token) throw new Error(`the lock of the record ${path} was taken by another process. Nothing was written. Try again.`);
	};
	try {
		return fn(held);
	} finally {
		try {
			if (readlinkSync(lock) === token) unlinkSync(lock);
		} catch {}
	}
}

/** The record of a decision as it is in the file now. It throws when the record is not complete. */
function readRecord(root: string, id: string): DecisionRecord {
	let d: DecisionRecord | null = null;
	try {
		d = readJson<DecisionRecord>(decisionPath(root, id));
	} catch {}
	if (!d || !validRecord(d, id)) throw new Error(`the record of decision ${id} cannot be read (${relative(root, decisionPath(root, id))})`);
	return d;
}

/**
 * Add the answer of the owner to a decision. A changed or reversed decision marks the results that depend on it at this
 * time (the list is in the answer). The marker of the waiting decision leaves the inbox, and a marker of the answer
 * enters it, so that a session that waits learns of the answer. The record and the markers change under one lock:
 * two answers are recorded one after the other, and none is lost.
 */
export function answerDecision(root: string, ref: string, input: AnswerInput, now = new Date()): DecisionRecord {
	if (!OWNER_ANSWERS.includes(input.answer)) throw new Error(`answer is ${JSON.stringify(input.answer)}, expected ${OWNER_ANSWERS.join(", ")}`);
	if (!text(input.by)) throw new Error("answer: give who answers (by)");
	if (input.answer === "changed" && !text(input.statement)) throw new Error("answer changed: give the statement that replaces the decision (statement)");
	if (input.answer !== "changed" && input.statement !== undefined) throw new Error("answer: statement is for the answer changed only");
	if (input.note !== undefined && !text(input.note)) throw new Error("answer: note must be a text");
	const id = findDecision(root, ref).id;
	const path = decisionPath(root, id);
	return withLock(path, (held) => {
		const d = readRecord(root, id);
		const answer: DecisionAnswer = {
			answer: input.answer,
			at: now.toISOString(),
			by: input.by.trim(),
			via: input.via ?? "cli",
			terminal: input.terminal === true,
			...(input.note ? { note: input.note.trim() } : {}),
			...(input.statement ? { statement: input.statement.trim() } : {}),
			marked: input.answer === "confirmed" ? [] : decisionDependents(root, d),
		};
		const next: DecisionRecord = { ...d, status: input.answer, authority: "owner", answers: [...d.answers, answer] };
		held();
		writeJsonAtomic(path, next);
		ackDecisionInbox(root, "decision", [id]);
		writeDecisionMarker(root, { kind: "answer", decision: id, class: next.class, statement: currentStatement(next), at: answer.at, answer: answer.answer, by: answer.by });
		return next;
	});
}

/**
 * The reader saw the last answer of these decisions: the marker of the answer leaves the inbox. A decision that has
 * a newer answer than the one the reader holds keeps its marker. It returns the ids whose marker was removed.
 */
export function ackAnswers(root: string, decisions: DecisionRecord[]): string[] {
	const done: string[] = [];
	for (const seen of decisions) {
		try {
			withLock(decisionPath(root, seen.id), () => {
				const now = readRecord(root, seen.id);
				if (lastAnswer(now)?.at === lastAnswer(seen)?.at) done.push(...ackDecisionInbox(root, "answer", [seen.id]));
			});
		} catch {
			// The record is locked or cannot be read: the marker stays, and the answer is named again.
		}
	}
	return done;
}

/**
 * The decision part of the inbox, from the records: each class A decision that waits for the owner, and the last
 * answer of each decision whose answer nobody has read (its marker is in simra/inbox). The records decide what is
 * said; a marker that is lost or out of date does not change it.
 */
export function decisionInbox(root: string, decisions = listDecisions(root)): DecisionMarker[] {
	const unread = new Set(readDecisionInbox(root).filter((m) => m.kind === "answer").map((m) => m.decision));
	const out: DecisionMarker[] = [];
	for (const d of decisions) {
		const last = lastAnswer(d);
		if (waitsForOwner(d)) out.push({ schema: INBOX_SCHEMA, kind: "decision", decision: d.id, class: d.class, statement: d.statement, at: d.created_at });
		else if (last && unread.has(d.id)) out.push({ schema: INBOX_SCHEMA, kind: "answer", decision: d.id, class: d.class, statement: currentStatement(d), at: last.at, answer: last.answer, by: last.by });
	}
	return out.sort((a, b) => a.at.localeCompare(b.at) || a.decision.localeCompare(b.decision));
}

/** The current sha256 of an evidence file, "missing" or "unreadable". */
function evidenceNow(root: string, e: DecisionEvidence): string {
	try {
		return createHash("sha256").update(readFileSync(join(root, e.path))).digest("hex");
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
	}
}

const affectText = (a: DecisionAffect) => (a.kind === "claim" ? `claim ${quote(a.ref)}` : `${a.kind} ${a.ref}`);

/** The full text of one decision: every field, the results that rest on it, and the answers. */
export function formatDecision(root: string, d: DecisionRecord, scan?: DecisionScan): string {
	const lines = [`decision ${d.id}: class ${d.class}, ${statusText(d)}`];
	lines.push(`record: ${relative(root, decisionPath(root, d.id))}`);
	lines.push(`  statement: ${d.statement}`);
	if (d.alternative) lines.push(`  not taken: ${d.alternative}`);
	lines.push(`  why: ${d.why}`);
	if (d.reverse) lines.push(`  reverse: ${d.reverse}`);
	if (d.decided_by) lines.push(`  decided by: ${d.decided_by}`);
	if (!d.evidence.length) lines.push("  evidence: none");
	for (const e of d.evidence) {
		const now = evidenceNow(root, e);
		const note = now === e.sha256 ? "" : now === "missing" ? " (now missing)" : now === "unreadable" ? " (cannot be read now)" : ` (changed after the decision, now sha256:${now.slice(0, 12)})`;
		lines.push(`  evidence: ${e.path} sha256:${e.sha256.slice(0, 12)}${note}`);
	}
	lines.push(`  affects: ${d.affects.length ? d.affects.map(affectText).join("; ") : "nothing named"}`);
	const all = decisionDependents(root, d, scan);
	const dependents = all.filter((m) => !m.no_result);
	const open = all.filter((m) => m.no_result);
	if (dependents.length) {
		lines.push(`  results that rest on it now: ${dependents.length}`);
		for (const m of dependents.slice(0, 8)) lines.push(`    ${m.kind} ${m.id} (${m.via})`);
		if (dependents.length > 8) lines.push(`    ... ${dependents.length - 8} more`);
	} else lines.push("  results that rest on it now: none");
	if (open.length) {
		lines.push(`  runs without a result that rest on it now: ${open.length}`);
		for (const m of open.slice(0, 8)) lines.push(`    ${m.kind} ${m.id} (${m.via})`);
		if (open.length > 8) lines.push(`    ... ${open.length - 8} more`);
	}
	for (const a of d.answers) {
		lines.push(`  answer: ${a.answer} by ${a.by}, ${a.at} (${a.via === "session" ? "command of the user in a session" : a.terminal ? "command line, terminal" : "command line, not from a terminal"})${a.note ? `: ${a.note}` : ""}`);
		if (a.statement) lines.push(`    statement of the owner: ${a.statement}`);
		if (a.answer !== "confirmed") {
			const open = a.marked.filter((m) => m.no_result).length;
			const results = a.marked.length - open;
			lines.push(`    marked ${results} result${results === 1 ? "" : "s"} that depended on it${open ? `, and ${open} run${open === 1 ? "" : "s"} without a result` : ""}${a.marked.length ? ":" : ""}`);
			for (const m of a.marked.slice(0, 8)) lines.push(`      ${m.kind} ${m.id} (${m.via}${m.no_result ? "; no result at that time" : ""})`);
			if (a.marked.length > 8) lines.push(`      ... ${a.marked.length - 8} more (all are in the record)`);
		}
	}
	return lines.join("\n");
}

/** What the author of a decision reads after the record is written: the record, and for class A the stop. */
export function formatRecorded(root: string, d: DecisionRecord): string {
	const lines = [formatDecision(root, d)];
	if (waitsForOwner(d)) {
		lines.push(
			"STOP: this is a class A decision. It waits for the owner. Do not act on it, and do not start work that depends on it.",
			"Do work that does not depend on it, or end your work and name this decision in your report.",
			`The owner answers with: simra decision answer ${shortId(d.id)} confirmed|changed|reversed --by <name>`,
		);
	} else if (d.class === "B") lines.push("Class B: the work continues. The decision is listed for the owner (simra digest).");
	else lines.push("Class C: logged.");
	return lines.join("\n");
}

/** One line per decision: `<class> <short id> <status>: <statement>`. */
export function formatDecisionList(decisions: DecisionRecord[]): string {
	if (!decisions.length) return "no decision is recorded in simra/decisions";
	return decisions.map((d) => `${d.class} ${d.id} ${d.status}${d.answers.length ? ` (${lastAnswer(d)?.by})` : ""}: ${quote(currentStatement(d), 110)}`).join("\n");
}
