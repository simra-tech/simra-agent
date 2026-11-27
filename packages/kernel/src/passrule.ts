// The pass rule of a run: the rule that decides pass or fail, recorded in experiment.json before the run starts.
// A rule is a text or a file of the design root. The record has its sha256. Three changes are flagged:
//   - an earlier run with a result used another rule under the same key (the rule changed after results existed);
//   - the rule file changed after the run started;
//   - the rule in experiment.json is not the rule that the runner copied into result.json.
// The check reads the records and hashes files, as the design record does (record.ts). It runs no tool.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { currentHash } from "./record.ts";
import { type ExperimentRecord, listExperiments, type ResultRecord } from "./records.ts";

/** What the caller gives: a text, or a file (relative to the design root, or absolute). The id joins runs that answer the same question. */
export interface PassRuleInput {
	id?: string;
	text?: string;
	file?: string;
}

/** An earlier run with a result that used another rule under the same key. */
export interface PassRuleChange {
	experiment: string;
	sha256: string;
	finished_at: string;
}

export interface PassRuleRecord {
	/** The key that joins runs: the id, else the file path, else null (a text without id is compared with no other run). */
	key: string | null;
	text?: string;
	/** The rule file, relative to the design root. */
	file?: string;
	bytes?: number;
	/** The sha256 of the text (UTF-8) or of the file, at recorded_at. */
	sha256: string;
	recorded_at: string;
	/** The earlier runs with a result and another rule under the same key. Empty: the rule did not change after a result. */
	changed_after_results: PassRuleChange[];
}

export const sha256Text = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Check the input and make the record. It throws on a rule without text and file, with both, or with a missing file. */
export function recordPassRule(root: string, input: PassRuleInput, now = new Date()): PassRuleRecord {
	const hasText = typeof input.text === "string" && input.text.trim() !== "";
	const hasFile = typeof input.file === "string" && input.file !== "";
	if (hasText === hasFile) throw new Error("pass_rule: give the rule as text or as file (one of the two)");
	if (input.id !== undefined && (typeof input.id !== "string" || !input.id)) throw new Error("pass_rule: id must be a text");
	let record: PassRuleRecord;
	if (hasFile) {
		const full = resolve(root, input.file as string);
		const file = relative(resolve(root), full);
		if (file.startsWith("..") || isAbsolute(file)) throw new Error(`pass_rule: the file ${input.file} is not in the design root`);
		let bytes: number;
		try {
			const st = statSync(full);
			if (!st.isFile()) throw new Error("not a file");
			bytes = st.size;
		} catch {
			throw new Error(`pass_rule: the file ${input.file} is not there. Write the rule before the run.`);
		}
		record = { key: input.id ?? file, file, bytes, sha256: currentHash(root, file), recorded_at: now.toISOString(), changed_after_results: [] };
	} else {
		const text = input.text as string;
		record = { key: input.id ?? null, text, sha256: sha256Text(text), recorded_at: now.toISOString(), changed_after_results: [] };
	}
	record.changed_after_results = earlierRules(root, record);
	return record;
}

/** The runs with a result that used another rule under the key of this rule, oldest first. */
function earlierRules(root: string, rule: PassRuleRecord): PassRuleChange[] {
	if (rule.key === null) return [];
	let all: ReturnType<typeof listExperiments> = [];
	try {
		all = listExperiments(root);
	} catch {}
	const out: PassRuleChange[] = [];
	for (const { id, experiment, result } of all) {
		const other = experiment.pass_rule;
		if (!result || !other || other.key !== rule.key || other.sha256 === rule.sha256) continue;
		out.push({ experiment: id, sha256: other.sha256, finished_at: result.finished_at });
	}
	return out;
}

/** `pass rule: <key or text> sha256:<12 chars>, recorded <time> (before the run)`. */
export function formatPassRule(rule: PassRuleRecord): string {
	const what = rule.file ? `file ${rule.file}` : `"${(rule.text ?? "").trim().split("\n")[0].slice(0, 100)}"`;
	const id = rule.key !== null && rule.key !== rule.file ? `${rule.key}: ` : "";
	return `pass rule: ${id}${what} sha256:${rule.sha256.slice(0, 12)}, recorded ${rule.recorded_at} (before the run)`;
}

/**
 * The flags of the pass rule of one experiment, as lines that start with `PASS RULE CHANGED:`. An empty list means
 * that no change was found, or that the run has no pass rule.
 */
export function passRuleFlags(root: string, experiment: ExperimentRecord, result: ResultRecord | null): string[] {
	const rule = experiment.pass_rule;
	if (!rule) return [];
	const out: string[] = [];
	for (const c of rule.changed_after_results) {
		out.push(`PASS RULE CHANGED: experiment ${c.experiment} (ended ${c.finished_at}) used sha256:${c.sha256.slice(0, 12)} for the rule ${rule.key}; this run uses sha256:${rule.sha256.slice(0, 12)}. The rule changed after a result existed.`);
	}
	if (rule.file) {
		const now = currentHash(root, rule.file);
		if (now !== rule.sha256) out.push(`PASS RULE CHANGED: file ${rule.file} changed after this run started (${now === "missing" ? "now missing" : `now sha256:${now.slice(0, 12)}`}). Judge this run with the recorded rule, or run again.`);
	} else if (rule.text !== undefined && sha256Text(rule.text) !== rule.sha256) {
		out.push("PASS RULE CHANGED: the rule text in experiment.json does not have the recorded sha256. The record was changed after the run started.");
	}
	if (result && result.pass_rule_sha256 !== undefined && result.pass_rule_sha256 !== rule.sha256) {
		out.push(`PASS RULE CHANGED: experiment.json has sha256:${rule.sha256.slice(0, 12)}; the run started with sha256:${result.pass_rule_sha256.slice(0, 12)} (result.json). The record was changed after the run started.`);
	}
	return out;
}

/** The path of the rule file of a record, for a reader of the record. */
export function passRulePath(root: string, rule: PassRuleRecord): string | null {
	return rule.file ? join(root, rule.file) : null;
}
