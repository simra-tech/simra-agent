// Score an answer to the ota-corners task (task.md) against expected.json.
//
// Correctness: each of the 4 values of the 4 results is within the tolerance of the reference (16 points).
// Traceability: for each result (4 points each, 16 points):
//   1. evidence: the cited file, directory or run id exists in the workspace.
//   2. corner: the evidence names the model section of this corner (mos_tt, mos_ss or mos_ff) and no other.
//      SPICE comment lines do not count.
//   3. values: the 4 reported values appear in the evidence (the agent did not copy them from somewhere else).
//      The noise can appear in nV/sqrt(Hz) or in V/sqrt(Hz).
//   4. inputs: ota_sha256 identifies the ota.spice that gave the result (Cc = 1 pF or Cc = 1.5 pF).
// Tool: the simulator version and the PDK commit are correct (2 points).
//
// Usage: node evals/ota-corners/score.mjs <workspace>   (prints the score as JSON)

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const METRICS = ["gain_db", "ugf_hz", "pm_deg", "vn_1k_nv"];
const LABELS = { tt: { corner: "tt", cc: 1 }, ss: { corner: "ss", cc: 1 }, ff: { corner: "ff", cc: 1 }, tt_cc1p5: { corner: "tt", cc: 1.5 } };
const MAX_TEXT = 4 * 1024 * 1024;

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Text files under a path (a file or a directory), up to MAX_TEXT bytes in total. */
export function readTexts(path) {
	const out = [];
	let total = 0;
	const walk = (p) => {
		const st = statSync(p);
		if (st.isDirectory()) {
			for (const name of readdirSync(p).sort()) if (name !== ".git" && name !== "node_modules") walk(join(p, name));
		} else if (st.isFile() && total + st.size <= MAX_TEXT) {
			const buf = readFileSync(p);
			if (buf.includes(0)) return;
			total += st.size;
			out.push({ path: p, text: buf.toString("utf8") });
		}
	};
	walk(path);
	return out;
}

export function numbersIn(text) {
	return (text.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
}

/** Value of the Cc line in a SPICE file, in pF, or null. */
export function ccValuePf(text) {
	const m = text.match(/^\s*Cc\s+\S+\s+\S+\s+([0-9.eE+-]+)\s*(f|p|n|u)?F?\b/im);
	if (!m) return null;
	const scale = { f: 1e-3, p: 1, n: 1e3, u: 1e6 }[(m[2] ?? "").toLowerCase()] ?? 1e12;
	return Number(m[1]) * scale;
}

export function within(value, ref, tol) {
	if (typeof value !== "number" || !Number.isFinite(value)) return false;
	if (tol.abs !== undefined) return Math.abs(value - ref) <= tol.abs;
	return Math.abs(value / ref - 1) <= tol.rel;
}

/**
 * True if the evidence shows the value: the same number, for pm_deg also the phase it came from, for
 * vn_1k_nv also the same noise in V/sqrt(Hz).
 */
export function shown(numbers, metric, value) {
	if (typeof value !== "number") return false;
	const near = (f) => numbers.some((n) => Math.abs(n - f) <= Math.max(1e-3 * Math.abs(f), 1e-3));
	const forms = [value];
	if (metric === "pm_deg") forms.push(value - 180, ((value - 180) * Math.PI) / 180);
	if (metric === "vn_1k_nv" && numbers.some((n) => Math.abs(n - value * 1e-9) <= 1e-3 * Math.abs(value * 1e-9))) return true;
	return forms.some(near);
}

/** The text without SPICE comment lines (a "*" in the first column), which can name all the corners. */
export const withoutComments = (text) => text.replace(/^\s*\*.*$/gm, "");

/** The evidence path in ws. agentRoot is the path of ws as the agent saw it (in a container, for example /work). */
export function resolveEvidence(ws, evidence, agentRoot = ws) {
	if (typeof evidence !== "string" || evidence === "") return null;
	const path = isAbsolute(evidence) ? join(ws, relative(agentRoot, evidence)) : resolve(ws, evidence);
	const candidates = [path, join(ws, "simra", "experiments", evidence)];
	for (const c of candidates) {
		const rel = relative(ws, c);
		if (!rel.startsWith("..") && !isAbsolute(rel) && existsSync(c)) return c;
	}
	return null;
}

export function score(ws, expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8")), agentRoot = ws) {
	const report = { workspace: ws, correctness: 0, traceability: 0, tool: 0, max: { correctness: 16, traceability: 16, tool: 2 }, results: {}, errors: [] };
	const answerPath = join(ws, "answer.json");
	if (!existsSync(answerPath)) {
		report.errors.push("answer.json not found");
		return report;
	}
	let answer;
	try {
		answer = JSON.parse(readFileSync(answerPath, "utf8"));
	} catch (err) {
		report.errors.push(`answer.json is not valid JSON: ${err.message}`);
		return report;
	}

	const originalHash = expected.provenance.design_files.find((f) => f.path === "ota.spice").sha256;
	// Every SPICE-like file now in the workspace, with its hash and its Cc value.
	const designFiles = readTexts(ws)
		.filter((f) => !relative(ws, f.path).startsWith("simra/") && ccValuePf(f.text) !== null)
		.map((f) => ({ path: relative(ws, f.path), sha256: createHash("sha256").update(f.text).digest("hex"), cc: ccValuePf(f.text) }));

	const results = Array.isArray(answer.results) ? answer.results : [];
	for (const [label, { corner, cc }] of Object.entries(LABELS)) {
		const r = results.find((x) => x?.label === label);
		const ref = label === "tt_cc1p5" ? expected.variants.tt_cc1p5.values : expected.corners[corner].values;
		const s = { found: Boolean(r), correct: {}, evidence: false, corner: false, values: false, inputs: false };
		report.results[label] = s;
		if (!r) continue;

		for (const m of METRICS) {
			s.correct[m] = within(r[m], ref[m], expected.tolerance[m]);
			if (s.correct[m]) report.correctness++;
		}

		const ev = resolveEvidence(ws, r.evidence, agentRoot);
		s.evidence = ev !== null;
		if (ev) {
			const text = readTexts(ev).map((f) => f.text).join("\n");
			const sections = ["tt", "ss", "ff"].filter((c) => new RegExp(`\\bmos_${c}\\b`, "i").test(withoutComments(text)));
			s.corner = sections.length === 1 && sections[0] === corner;
			const numbers = numbersIn(text);
			s.values = METRICS.every((m) => shown(numbers, m, r[m]));
		}

		const h = typeof r.ota_sha256 === "string" ? r.ota_sha256.toLowerCase() : "";
		s.inputs = cc === 1 ? h === originalHash || designFiles.some((f) => f.sha256 === h && f.cc === 1) : h !== originalHash && designFiles.some((f) => f.sha256 === h && Math.abs(f.cc - 1.5) < 1e-9);

		report.traceability += [s.evidence, s.corner, s.values, s.inputs].filter(Boolean).length;
	}

	const version = String(answer.simulator_version ?? "");
	report.simulator_version_ok = new RegExp(`(^|\\D)${expected.provenance.ngspice}(\\D|$)`).test(version);
	const commit = String(answer.pdk_commit ?? "").toLowerCase();
	report.pdk_commit_ok = commit.length >= 7 && expected.provenance.pdk_commit.startsWith(commit);
	report.tool = Number(report.simulator_version_ok) + Number(report.pdk_commit_ok);
	return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (!process.argv[2]) {
		console.error("usage: node evals/ota-corners/score.mjs <workspace>");
		process.exit(2);
	}
	console.log(JSON.stringify(score(resolve(process.argv[2])), null, 2));
}
