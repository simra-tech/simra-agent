// Answer consistency: the answer file of a task must belong to the final design file and to the last check of it.
// The harness uses this at the end of a session (end guard, and the run summary also after a hard end): a run whose
// answer does not agree ends as "inconsistent answer", with the items named.
//
// Rules (answer file with rows [{corner or condition, requirement, value}] and meets_spec):
// 1. The answer file exists and is valid JSON.
// 2. The answer file is not older than the design file.
// 3. A check of the final design file exists: the newest check whose recorded design file hash equals the hash of
//    the file now (for a check record without a hash: a check that started after the last change of the file).
// 4. That check completed every run (no row is not run because a run failed).
// 5. Each value of the answer equals the value of the row of that check (relative tolerance tol_rel, default 0.2 %:
//    a value written with 4 significant digits passes); a row with a value in the check needs a value in the answer.
// 6. meets_spec of the answer equals "every row of that check passes".

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { VerdictRecord } from "./requirements.ts";
import { sha256File } from "./runner.ts";

export interface AnswerConsistency {
	consistent: boolean;
	items: string[];
	/** The check the answer is compared with, or null. */
	check: string | null;
	design_sha256: string | null;
}

function verdicts(root: string): VerdictRecord[] {
	const dir = join(root, "simra", "checks");
	if (!existsSync(dir)) return [];
	const out: VerdictRecord[] = [];
	for (const id of readdirSync(dir).sort()) {
		const p = join(dir, id, "verdict.json");
		if (!existsSync(p)) continue;
		try {
			out.push(JSON.parse(readFileSync(p, "utf8")) as VerdictRecord);
		} catch {
			// a verdict that is being written: not a check of record
		}
	}
	return out;
}

/** The start time of a check from its id (yyyymmdd-hhmmss-xxxxxx, UTC), or NaN. */
function checkStart(id: string): number {
	const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
	return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Number.NaN;
}

const fmt = (x: unknown) => (typeof x === "number" ? Number(x.toPrecision(6)).toString() : String(x));

export function answerConsistency(root: string, answerFile: string, designFile: string | null, tolRel = 2e-3): AnswerConsistency {
	const items: string[] = [];
	const out = (check: string | null, sha: string | null): AnswerConsistency => ({ consistent: items.length === 0, items, check, design_sha256: sha });
	const ap = join(root, answerFile);
	if (!existsSync(ap)) {
		items.push(`${answerFile} does not exist.`);
		return out(null, null);
	}
	let answer: { meets_spec?: unknown; rows?: unknown };
	try {
		answer = JSON.parse(readFileSync(ap, "utf8"));
	} catch (e) {
		items.push(`${answerFile} is not valid JSON (${(e as Error).message}).`);
		return out(null, null);
	}
	const dp = designFile ? join(root, designFile) : null;
	if (!dp || !existsSync(dp)) {
		if (designFile) items.push(`${designFile} does not exist.`);
		return out(null, null);
	}
	const sha = sha256File(dp);
	const designTime = statSync(dp).mtimeMs;
	if (statSync(ap).mtimeMs < designTime) items.push(`${answerFile} is older than ${designFile}: the design changed after the answer was written.`);
	const all = verdicts(root);
	const ofDesign = all.filter((v) => (v.design_file ? v.design_file.path === designFile && v.design_file.sha256 === sha : checkStart(v.id) >= designTime - 1000));
	const check = ofDesign.at(-1);
	if (!check) {
		items.push(`No check of the final ${designFile} is recorded${all.length ? ` (the last check, ${all.at(-1)!.id}, was of another version of the file)` : ""}.`);
		return out(null, sha);
	}
	const failed = (check.experiments ?? []).filter((e) => e.status !== "completed");
	if (failed.length) items.push(`The check of the final design (${check.id}) has ${failed.length} run${failed.length === 1 ? "" : "s"} that did not complete (first: ${failed[0].experiment}${failed[0].condition ? ` at ${failed[0].condition}` : ""}).`);
	const rows = Array.isArray(answer.rows) ? (answer.rows as Record<string, unknown>[]) : [];
	const key = (c: unknown, r: unknown) => `${c ?? "null"} ${r}`;
	const given = new Map(rows.map((r) => [key(r.corner ?? r.condition ?? null, r.requirement), r.value]));
	const differ: string[] = [];
	for (const row of check.rows) {
		if (typeof row.value !== "number" || row.gate) continue;
		const k = key(row.condition, row.requirement);
		if (!given.has(k)) continue;
		const a = given.get(k);
		if (typeof a !== "number" || Math.abs(a - row.value) > Math.max(tolRel * Math.abs(row.value), 1e-15)) differ.push(`${k}: ${a === null || a === undefined ? "no value" : fmt(a)} in ${answerFile}, ${fmt(row.value)} in the check`);
	}
	if (differ.length) items.push(`${differ.length} value${differ.length === 1 ? "" : "s"} of ${answerFile} differ from the check of the final design (${check.id}): ${differ.slice(0, 3).join("; ")}${differ.length > 3 ? "; ..." : ""}.`);
	const allPass = check.rows.length > 0 && check.rows.every((r) => r.status === "pass");
	if (typeof answer.meets_spec === "boolean" && answer.meets_spec !== allPass) items.push(`meets_spec is ${answer.meets_spec} in ${answerFile}; in the check of the final design (${check.id}) ${allPass ? "every row passes" : "not every row passes"}.`);
	return out(check.id, sha);
}
