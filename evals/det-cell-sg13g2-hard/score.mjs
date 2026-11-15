// Score a workspace of the det-cell-sg13g2-hard task (task.md, spec.md).
//
// The scorer does not trust the answer. It checks the device rules of spec.md on det_cell.spice (the rules of the
// det-cell-sg13g2 task), then runs the check of requirements.json on the final det_cell.spice and the final tap.gds
// through the kernel: the transient bench at each corner, the Monte Carlo offset (100 seeds per corner), the
// operating-limit gate on the DC point, and the EM simulation of tap.gds with the ports of spec.md (openEMS).
//
// Score:
// - design (2): det_cell.spice has the subcircuit with the pins in order and only the devices of spec.md.
// - requirements (one per verified row: the requirement rows and the gate rows): the row passes. Given only when the
//   design part passes.
// - claim (4): meets_spec is the same as the verification (the design part and every row).
// - values (one per requirement row, gate rows excluded): the reported value is within the tolerance of the
//   verified value.
//
// Diagnostics (no points): reference (the value of the reference through the same check, from expected.json),
// supported (rows whose value appears in a workspace file other than answer.json and det_cell.spice), errors.
//
// Usage: node evals/det-cell-sg13g2-hard/score.mjs <workspace>   (prints the score as JSON)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runCheck } from "@simra-tech/kernel";
import { checkDesign, TOLERANCE as BASE_TOLERANCE } from "../det-cell-sg13g2/score.mjs";
import { numbersIn, readTexts, within } from "../ota-corners/score.mjs";

const here = new URL(".", import.meta.url).pathname;
const DESIGN = "det_cell.spice";
const LAYOUT = "tap.gds";
const BENCH_FILES = ["simra.config.json", "simra.local.json", "verify.spice", "offset.spice", "requirements.json"];
export const TOLERANCE = { ...BASE_TOLERANCE, offset_3s: { abs: 2e-4, rel: 0.05 }, tap_s21: { abs: 0.05 }, tap_s31: { abs: 0.5 } };

/** The key of a verdict row: "<condition> <requirement>", or "<requirement>" for a row without a condition. */
export const rowKey = (condition, requirement) => (condition ? `${condition} ${requirement}` : requirement);

/** Run the check of requirements.json on the design text and the layout in root. */
export async function verify(taskDir, designText, root, layoutPath = null, parallel = 5) {
	const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	for (const f of BENCH_FILES) {
		const from = resolve(taskDir, task.files[f] ?? f);
		if (existsSync(from)) copyFileSync(from, join(root, f));
	}
	writeFileSync(join(root, DESIGN), designText);
	if (layoutPath && existsSync(layoutPath)) copyFileSync(layoutPath, join(root, LAYOUT));
	const { verdict } = await runCheck({ root, parallel });
	const rows = {};
	for (const r of verdict.rows) rows[rowKey(r.condition, r.requirement)] = { value: r.value ?? null, pass: r.status === "pass", status: r.status, gate: Boolean(r.gate) };
	return { rows, experiments: verdict.experiments.map((e) => ({ id: e.id, condition: e.condition, status: e.status })) };
}

export async function score(ws, expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8")), _agentRoot = ws, { verifyRoot = join(dirname(ws), "verify"), verifier = verify } = {}) {
	const requirements = JSON.parse(readFileSync(join(here, "requirements.json"), "utf8"));
	const reqRows = requirements.requirements.flatMap((r) => (r.conditions ?? [null]).map((c) => ({ key: rowKey(c, r.id), corner: c, id: r.id })));
	const report = { workspace: ws, design: 0, requirements: 0, claim: 0, values: 0, max: { design: 2, requirements: null, claim: 4, values: reqRows.length }, meets_spec: null, verified_meets_spec: false, design_errors: [], rows: {}, closed: [], missed: [], supported: 0, errors: [] };
	const designPath = join(ws, DESIGN);
	let verified = null;
	if (!existsSync(designPath)) report.errors.push(`${DESIGN} not found`);
	else {
		const text = readFileSync(designPath, "utf8");
		report.design_errors = checkDesign(text, here);
		if (!report.design_errors.length) report.design = 2;
		if (!existsSync(join(ws, LAYOUT))) report.errors.push(`${LAYOUT} not found: the tap rows are not run`);
		verified = await verifier(here, text, verifyRoot, join(ws, LAYOUT));
	}
	let answer = null;
	if (!existsSync(join(ws, "answer.json"))) report.errors.push("answer.json not found");
	else {
		try {
			answer = JSON.parse(readFileSync(join(ws, "answer.json"), "utf8"));
		} catch (err) {
			report.errors.push(`answer.json is not valid JSON: ${err.message}`);
		}
	}
	const evidence = numbersIn(
		readTexts(ws)
			.filter((f) => !["answer.json", DESIGN].includes(relative(ws, f.path)))
			.map((f) => f.text)
			.join("\n"),
	);
	const rows = Array.isArray(answer?.rows) ? answer.rows : [];
	const keys = [...new Set([...reqRows.map((r) => r.key), ...Object.keys(expected.rows ?? {}), ...Object.keys(verified?.rows ?? {})])];
	report.max.requirements = keys.length;
	let allPass = report.design === 2;
	for (const key of keys) {
		const v = verified?.rows[key] ?? { value: null, pass: false, status: "not_run" };
		const ref = expected.rows?.[key] ?? null;
		const s = { verified: v.value, status: v.status, reported: null, value: false, supported: false, reference: ref };
		report.rows[key] = s;
		allPass &&= v.pass;
		if (report.design === 2) report.requirements += Number(v.pass);
		(v.pass ? report.closed : report.missed).push(key);
		const q = reqRows.find((x) => x.key === key);
		if (!q) continue;
		const r = rows.find((x) => (x?.corner ?? null) === q.corner && x?.requirement === q.id);
		s.reported = r?.value ?? null;
		if (!r || v.value === null) continue;
		s.value = within(r.value, v.value, TOLERANCE[q.id]);
		s.supported = typeof r.value === "number" && evidence.some((x) => Math.abs(x - r.value) <= 1e-3 * Math.abs(r.value));
		report.values += Number(s.value);
		report.supported += Number(s.supported);
	}
	report.verified_meets_spec = allPass;
	report.meets_spec = typeof answer?.meets_spec === "boolean" ? answer.meets_spec : null;
	if (report.meets_spec === allPass) report.claim = 4;
	return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (!process.argv[2]) {
		console.error("usage: node evals/det-cell-sg13g2-hard/score.mjs <workspace>");
		process.exit(2);
	}
	console.log(JSON.stringify(await score(resolve(process.argv[2])), null, 2));
}
