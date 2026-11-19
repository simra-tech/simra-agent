// Score a workspace of the lna-sg13g2 task (task.md, spec.md).
//
// The scorer does not trust the answer. It checks the device rules of spec.md on lna.spice (the kernel netlist checker with gates.netlist), finds the
// EM passives of lna.spice in the records of the workspace, then runs the check of requirements.json on the final
// lna.spice through the kernel (both benches at each corner, the stability gate and the operating-limit gate).
//
// Score:
// - design (2): lna.spice has the subcircuit lna with the pins in order and only the devices of spec.md.
// - em_passive (2): lna.spice has at least one subcircuit that is the output of a fit_to_spice record of the
//   workspace whose input Touchstone file is the output of an openems record (matched by SHA-256), and lna uses it.
//   The scorer does not run the EM simulation again, and it does not check that the passive is in the signal path.
// - requirements (one per verified row: the requirement rows and the gate rows): the row passes. Given only when the
//   design part passes.
// - claim (4): meets_spec is the same as the verification (design, EM passive, every row).
// - values (one per requirement row, gate rows excluded): the reported value is within the tolerance of the verified
//   value.
//
// Diagnostics (no points): reference (the value of the reference design through the same benches, from
// expected.json), supported (rows whose value appears in a workspace file other than answer.json and lna.spice),
// em (the EM passives found, and why others were refused), errors.
//
// Usage: node evals/lna-sg13g2/score.mjs <workspace>   (prints the score as JSON)

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { checkNetlist, fittedModels, instanceParamClasses, paramTable as kernelParamTable, runCheck, spiceValue } from "@simra-tech/kernel";
import { numbersIn, readTexts, within } from "../ota-corners/score.mjs";

const here = new URL(".", import.meta.url).pathname;
const DESIGN = "lna.spice";
const BENCH_FILES = ["simra.config.json", "simra.local.json", "sp.spice", "noise.spice", "lines.spice", "requirements.json"];
export const TOLERANCE = {
	gain: { abs: 0.1 },
	s22: { abs: 0.3 },
	nf_db: { abs: 0.1 },
	mu: { rel: 0.02 },
	idd_a: { rel: 0.02 },
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The .param values of a SPICE text (the kernel parser). */
export const paramTable = kernelParamTable;
/** A number, a number with a SPICE suffix, or {expression} of .param values; else NaN (the kernel parser). */
export const value = spiceValue;

/**
 * The fitted subcircuits of the records of a workspace (the kernel fittedModels): [{name, body, fit, em, ...}], and
 * the refused fits with a reason. em is the openems record whose Touchstone output (by SHA-256) is the fit input, or null.
 */
export function emFits(ws) {
	const { found, refused } = fittedModels(ws);
	for (const f of found) if (!f.em) refused.push({ fit: f.fit, reason: "its Touchstone input is not the output of an openems record" });
	return { found, refused };
}

/**
 * The device rules of spec.md on the text of lna.spice: the kernel netlist checker with gates.netlist of
 * requirements.json (the same check as the gate row). fits: the fitted subcircuits of emFits. Returns {errors, em}.
 */
export function checkDesign(text, fits = [], taskDir = here) {
	const rules = readJson(join(taskDir, "requirements.json")).gates.netlist;
	// the EM passive is the em_passive part of the score, not a design error here (the gate row checks both)
	const r = checkNetlist(text, { ...rules, em_passives_min: 0 }, { classes: instanceParamClasses(taskDir, rules.technology), fits });
	return { errors: r.errors.map((e) => e.message), em: r.fitted_used.filter((x) => x.em) };
}

/**
 * Copy the fit_to_spice and openems records of the workspace (experiment.json, result.json and their subcircuit and
 * Touchstone outputs) into the verify root, so that the netlist gate and the fit-band gate of the check see the
 * fitted models of the design. No other record is copied.
 */
export function copyFitRecords(ws, root) {
	const dir = join(ws, "simra", "experiments");
	if (!existsSync(dir)) return 0;
	let n = 0;
	for (const id of readdirSync(dir)) {
		const e = join(dir, id);
		let exp, res;
		try {
			exp = readJson(join(e, "experiment.json"));
			res = readJson(join(e, "result.json"));
		} catch {
			continue;
		}
		const fit = exp.adapter?.name === "touchstone" && exp.operation === "fit_to_spice";
		if (!fit && exp.adapter?.name !== "openems") continue;
		const to = join(root, "simra", "experiments", id);
		mkdirSync(to, { recursive: true });
		copyFileSync(join(e, "experiment.json"), join(to, "experiment.json"));
		copyFileSync(join(e, "result.json"), join(to, "result.json"));
		for (const o of res.outputs ?? []) {
			if (!["subckt", "touchstone"].includes(o.role)) continue;
			const from = join(ws, o.path);
			if (!existsSync(from) || relative(ws, from).startsWith("..")) continue;
			mkdirSync(dirname(join(root, o.path)), { recursive: true });
			copyFileSync(from, join(root, o.path));
		}
		n++;
	}
	return n;
}

/** Run the check of requirements.json on the design text in root. Returns {rows: {"corner requirement": {value, pass, status}}, experiments}. */
export async function verify(taskDir, designText, root, parallel = 5, ws = null) {
	const task = readJson(join(taskDir, "task.json"));
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	for (const f of BENCH_FILES) {
		const from = resolve(taskDir, task.files[f] ?? f);
		if (existsSync(from)) copyFileSync(from, join(root, f));
	}
	writeFileSync(join(root, DESIGN), designText);
	if (ws) copyFitRecords(ws, root);
	const { verdict } = await runCheck({ root, parallel });
	const rows = {};
	for (const r of verdict.rows) rows[`${r.condition} ${r.requirement}`] = { value: r.value ?? null, pass: r.status === "pass", status: r.status, gate: Boolean(r.gate) };
	return { rows, experiments: verdict.experiments.map((e) => ({ id: e.id, condition: e.condition, status: e.status })) };
}

export async function score(ws, expected = readJson(join(here, "expected.json")), _agentRoot = ws, { verifyRoot = join(dirname(ws), "verify"), verifier = verify } = {}) {
	const requirements = readJson(join(here, "requirements.json"));
	const reqRows = requirements.requirements.flatMap((r) => r.conditions.map((c) => `${c} ${r.id}`));
	const report = { workspace: ws, design: 0, em_passive: 0, requirements: 0, claim: 0, values: 0, max: { design: 2, em_passive: 2, requirements: null, claim: 4, values: reqRows.length }, meets_spec: null, verified_meets_spec: false, design_errors: [], em: { used: [], refused: [] }, rows: {}, closed: [], missed: [], supported: 0, errors: [] };
	const designPath = join(ws, DESIGN);
	let verified = null;
	if (!existsSync(designPath)) report.errors.push(`${DESIGN} not found`);
	else {
		const text = readFileSync(designPath, "utf8");
		const fits = emFits(ws);
		report.em.refused = fits.refused;
		const d = checkDesign(text, fits.found);
		report.design_errors = d.errors;
		report.em.used = d.em;
		if (!d.errors.length) report.design = 2;
		if (d.em.length) report.em_passive = 2;
		verified = await verifier(here, text, verifyRoot, 5, ws);
	}
	let answer = null;
	if (!existsSync(join(ws, "answer.json"))) report.errors.push("answer.json not found");
	else {
		try {
			answer = readJson(join(ws, "answer.json"));
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
	// every row of the reference verdict and of this verdict (gate rows included)
	// A "gate fit_band <network>" row of the reference names a network of the reference design; these rows come from the
	// verified run of the design under test only.
	const keys = [...new Set([...reqRows, ...Object.keys(expected.rows ?? {}).filter((k) => !/ gate fit_band /.test(k)), ...Object.keys(verified?.rows ?? {})])];
	report.max.requirements = keys.length;
	let allPass = report.design === 2 && report.em_passive === 2;
	for (const key of keys) {
		const v = verified?.rows[key] ?? { value: null, pass: false, status: "not_run" };
		const ref = expected.rows?.[key] ?? null;
		const s = { verified: v.value, status: v.status, reported: null, value: false, supported: false, reference: ref };
		report.rows[key] = s;
		allPass &&= v.pass;
		if (report.design === 2) report.requirements += Number(v.pass);
		(v.pass ? report.closed : report.missed).push(key);
		if (!reqRows.includes(key)) continue;
		const [corner, id] = key.split(" ");
		const r = rows.find((x) => x?.corner === corner && x?.requirement === id);
		s.reported = r?.value ?? null;
		if (!r || v.value === null) continue;
		s.value = within(r.value, v.value, TOLERANCE[id]);
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
		console.error("usage: node evals/lna-sg13g2/score.mjs <workspace>");
		process.exit(2);
	}
	console.log(JSON.stringify(await score(resolve(process.argv[2])), null, 2));
}
