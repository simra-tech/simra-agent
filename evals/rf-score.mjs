// A scorer for an RF block task with fitted EM passives (the method of evals/lna-sg13g2/score.mjs, for any design file
// and benches). The scorer does not trust the answer: it checks the netlist rules of requirements.json (gates.netlist,
// the kernel checker) on the design file, finds the EM passives of the design in the records of the workspace, then
// runs the check of requirements.json on the final design file through the kernel in a fresh root with copies of the
// fit and openEMS records of the workspace.
//
// Score:
// - design (2): the design file has the block with the pins in order and only the devices and wiring of the rules.
// - em_passive (2): the block uses a subcircuit that is the output of a fit_to_spice record of the workspace whose
//   input Touchstone file is the output of an openems record (matched by SHA-256).
// - requirements (one per verified row, gate rows included): the row passes. Given only when the design part passes.
// - claim (4): meets_spec is the same as the verification (design, EM passive, every row).
// - values (one per requirement row, gate rows excluded): the reported value is within the tolerance of the verified
//   value.
// Diagnostics (no points): reference (expected.json), supported (rows whose value appears in a workspace file other
// than answer.json and the design file), em (the EM passives found, and why others were refused), errors.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { checkNetlist, fittedModels, instanceParamClasses, runCheck } from "@simra-tech/kernel";
import { numbersIn, readTexts, within } from "./ota-corners/score.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The fitted subcircuits of the records of a workspace, and the refused fits with a reason. */
export function emFits(ws) {
	const { found, refused } = fittedModels(ws);
	for (const f of found) if (!f.em) refused.push({ fit: f.fit, reason: "its Touchstone input is not the output of an openems record" });
	return { found, refused };
}

/** Copy the fit_to_spice and openems records of a workspace (and their subcircuit and Touchstone outputs) into root. */
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

/**
 * A scorer for the task in `here`: {checkDesign, verify, score}. design: the design file name; tolerance: {requirement
 * id: {abs} or {rel}} for the values part.
 */
export function makeScorer({ here, design, tolerance }) {
	const task = readJson(join(here, "task.json"));
	const benchFiles = Object.keys(task.files ?? {}).filter((f) => f !== "spec.md");

	function checkDesign(text, fits = []) {
		const rules = readJson(join(here, "requirements.json")).gates.netlist;
		const r = checkNetlist(text, { ...rules, em_passives_min: 0 }, { classes: instanceParamClasses(here, rules.technology), fits });
		return { errors: r.errors.map((e) => e.message), em: r.fitted_used.filter((x) => x.em) };
	}

	async function verify(designText, root, parallel = 5, ws = null) {
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
		for (const f of benchFiles) {
			const from = resolve(here, task.files[f] ?? f);
			if (existsSync(from)) copyFileSync(from, join(root, f));
		}
		writeFileSync(join(root, design), designText);
		if (ws) copyFitRecords(ws, root);
		const { verdict } = await runCheck({ root, parallel });
		const rows = {};
		for (const r of verdict.rows) rows[`${r.condition} ${r.requirement}`] = { value: r.value ?? null, pass: r.status === "pass", status: r.status, gate: Boolean(r.gate) };
		return { rows, experiments: verdict.experiments.map((e) => ({ id: e.id, condition: e.condition, status: e.status })) };
	}

	async function score(ws, expected = readJson(join(here, "expected.json")), _agentRoot = ws, { verifyRoot = join(dirname(ws), "verify"), verifier = verify } = {}) {
		const requirements = readJson(join(here, "requirements.json"));
		const reqRows = requirements.requirements.flatMap((r) => r.conditions.map((c) => `${c} ${r.id}`));
		const report = { workspace: ws, design: 0, em_passive: 0, requirements: 0, claim: 0, values: 0, max: { design: 2, em_passive: 2, requirements: null, claim: 4, values: reqRows.length }, meets_spec: null, verified_meets_spec: false, design_errors: [], em: { used: [], refused: [] }, rows: {}, closed: [], missed: [], supported: 0, errors: [] };
		const designPath = join(ws, design);
		let verified = null;
		if (!existsSync(designPath)) report.errors.push(`${design} not found`);
		else {
			const text = readFileSync(designPath, "utf8");
			const fits = emFits(ws);
			report.em.refused = fits.refused;
			const d = checkDesign(text, fits.found);
			report.design_errors = d.errors;
			report.em.used = d.em;
			if (!d.errors.length) report.design = 2;
			if (d.em.length) report.em_passive = 2;
			verified = await verifier(text, verifyRoot, 5, ws);
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
				.filter((f) => !["answer.json", design].includes(relative(ws, f.path)))
				.map((f) => f.text)
				.join("\n"),
		);
		const rows = Array.isArray(answer?.rows) ? answer.rows : [];
		const keys = [...new Set([...reqRows, ...Object.keys(expected.rows ?? {}), ...Object.keys(verified?.rows ?? {})])];
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
			s.value = within(r.value, v.value, tolerance[id]);
			s.supported = typeof r.value === "number" && evidence.some((x) => Math.abs(x - r.value) <= 1e-3 * Math.abs(r.value));
			report.values += Number(s.value);
			report.supported += Number(s.supported);
		}
		report.verified_meets_spec = allPass;
		report.meets_spec = typeof answer?.meets_spec === "boolean" ? answer.meets_spec : null;
		if (report.meets_spec === allPass) report.claim = 4;
		return report;
	}

	return { checkDesign, verify, score };
}
