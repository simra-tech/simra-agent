// Shared parts of the ota-sizing tasks (one task directory for each PDK).
//
// The agent changes the sizes in ota.spice so that the OTA meets spec.md over the input common-mode range.
// The scorer does not trust the answer: it checks the topology and the design limits of the final ota.spice,
// and then runs the check of requirements.json with the bench verify.spice of the task through the kernel, at
// each corner and at each VCM of the range (verification sweep). The agent gets the same two files, so its
// check and the score use the same bench. The PDK facts (model library, sections, units) come from spec.md,
// requirements.json and task.json of the task directory.
//
// Score:
// - topology (1): ota.spice has the same devices, nets, models and parameter names as the original.
// - limits (1): the gate area and Cc obey the design limits of spec.md.
// - requirements (12): for each corner and requirement, the verified worst value passes. Given only when the
//   topology is correct.
// - claim (4): meets_spec is the same as the verification (topology, limits and all requirements).
// - values (12): for each row, the reported worst value is within the tolerance of the verified worst value.
//
// Diagnostics (no points): area_um2, changed (the changed sizes), supported (rows whose value appears in a
// workspace file other than answer.json), verification (the experiments and the worst values).

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { experimentDir, loadExperiment, runCheck } from "@simra-tech/kernel";
import { numbersIn, readTexts, shown, within } from "../ota-corners/score.mjs";

export const METRICS = ["gain_db", "ugf_hz", "pm_deg", "idd_a"];
export const STEP = 0.02;
export const TOLERANCE = { gain_db: { abs: 0.5 }, ugf_hz: { rel: 0.05 }, pm_deg: { abs: 2 }, idd_a: { rel: 0.02 } };
const UNIT_SCALE = { dB: 1, Hz: 1, kHz: 1e3, MHz: 1e6, "°": 1, deg: 1, A: 1, mA: 1e-3, uA: 1e-6, µA: 1e-6 };
const SI = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };

/** A SPICE number ("4u", "0.5", "1p", "5k", "1meg"), or NaN. */
export function spiceNumber(text) {
	const m = String(text).match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(meg|[tgkmunpf])?[a-z]*$/i);
	return m ? Number(m[1]) * (m[2] ? SI[m[2].toLowerCase()] : 1) : Number.NaN;
}

/** The conditions, corners and requirements of spec.md (without the design limits). */
export function parseConditions(text) {
	const range = text.match(/Input common-mode voltage: VCM from ([\d.]+) V to ([\d.]+) V\./);
	const lib = text.match(/^- Models: `([^`]+)`/m);
	const corners = {};
	for (const m of text.matchAll(/^\|\s*(\w+)\s*\|\s*`(\w+)`\s*\|\s*([\d.]+)\s*V\s*\|\s*(-?[\d.]+)\s*°C\s*\|$/gm)) {
		corners[m[1]] = { section: m[2], vdd: Number(m[3]), temp: Number(m[4]) };
	}
	const limits = {};
	for (const m of text.matchAll(/^\|[^|]*\|\s*`(\w+)`\s*\|\s*(>=|<=)\s*([\d.]+)\s*(\S+)\s*\|$/gm)) {
		if (!(m[4] in UNIT_SCALE)) throw new Error(`spec.md: unknown unit ${m[4]}`);
		limits[m[1]] = { op: m[2], value: Number(m[3]) * UNIT_SCALE[m[4]] };
	}
	if (!range || !lib || Object.keys(corners).length !== 3 || METRICS.some((k) => !limits[k])) {
		throw new Error("spec.md: range, models, corners or requirements not found");
	}
	return { range: [Number(range[1]), Number(range[2])], lib: lib[1], corners, limits };
}

/** The conditions, corners, requirements and design limits of spec.md. */
export function parseSpec(text) {
	const area = text.match(/sum of W × L over the MOS devices is <= ([\d.]+) µm²/);
	const cc = text.match(/Cc is <= ([\d.]+) pF/);
	if (!area || !cc) throw new Error("spec.md: design limits not found");
	return { ...parseConditions(text), design: { area_um2: Number(area[1]), cc_f: Number(cc[1]) * 1e-12 } };
}

/** The VCM values of the sweep: the range in steps of STEP, both ends included. */
export function sweep([low, high]) {
	const n = Math.round((high - low) / STEP);
	return Array.from({ length: n + 1 }, (_, i) => Number((low + i * STEP).toFixed(3)));
}

/**
 * The elements of the subcircuit "ota": { name: { nodes, model, params } }. A MOS device is an X line with 4
 * nodes and a model; an R or C line has 2 nodes and a value (in params.value). Other lines are errors.
 */
export function parseOta(text) {
	const lines = text.replace(/\r/g, "").replace(/\n\+/g, " ").split("\n").map((l) => l.replace(/[;$].*$/, "").trim());
	const start = lines.findIndex((l) => /^\.subckt\s+ota\b/i.test(l));
	const end = lines.findIndex((l, i) => i > start && /^\.ends\b/i.test(l));
	if (start < 0 || end < 0) return { errors: ["no .subckt ota ... .ends"] };
	const elements = {};
	const errors = [];
	for (const line of lines.slice(start + 1, end)) {
		if (line === "" || line.startsWith("*")) continue;
		const t = line.split(/\s+/);
		const name = t[0].toUpperCase();
		const kind = name[0];
		const n = kind === "X" ? 4 : 2;
		if (!"XRC".includes(kind) || t.length < n + 2) {
			errors.push(`unexpected line: ${line}`);
			continue;
		}
		const params = {};
		const rest = t.slice(n + 2);
		if (kind !== "X") params.value = t[n + 1];
		for (const p of rest) {
			const kv = p.split("=");
			if (kv.length !== 2) errors.push(`${name}: unexpected parameter ${p}`);
			else params[kv[0].toLowerCase()] = kv[1];
		}
		elements[name] = { nodes: t.slice(1, n + 1).map((x) => x.toLowerCase()), model: kind === "X" ? t[n + 1].toLowerCase() : null, params };
	}
	return { header: lines[start].toLowerCase().split(/\s+/).join(" "), elements, errors };
}

/** Errors when the design changes more than the sizes of the original: devices, nets, models, parameter names. */
export function checkTopology(originalText, designText) {
	const a = parseOta(originalText);
	const b = parseOta(designText);
	const errors = [...(b.errors ?? [])];
	if (!b.elements) return errors;
	if (a.header !== b.header) errors.push(`the subcircuit line changed: ${b.header}`);
	for (const name of Object.keys(a.elements)) if (!b.elements[name]) errors.push(`${name} removed`);
	for (const [name, e] of Object.entries(b.elements)) {
		const o = a.elements[name];
		if (!o) {
			errors.push(`${name} added`);
			continue;
		}
		if (e.nodes.join(" ") !== o.nodes.join(" ")) errors.push(`${name}: nets changed`);
		if (e.model !== o.model) errors.push(`${name}: model changed`);
		if (Object.keys(e.params).sort().join(" ") !== Object.keys(o.params).sort().join(" ")) errors.push(`${name}: parameter names changed`);
		for (const [k, v] of Object.entries(e.params)) if (!(spiceNumber(v) > 0)) errors.push(`${name}: ${k}=${v} is not a positive number`);
	}
	return errors;
}

/** The gate area, the sum of W × L over the MOS devices, in µm². lengthUnit is the netlist length unit in m. */
export function gateArea(designText, lengthUnit) {
	const { elements = {} } = parseOta(designText);
	const um = (v) => (spiceNumber(v) * lengthUnit) / 1e-6;
	return Object.values(elements)
		.filter((e) => e.model)
		.reduce((a, e) => a + um(e.params.w) * um(e.params.l), 0);
}

/** The sizes that differ from the original: { "XM1.w": ["4u", "12u"] }. */
export function changedSizes(originalText, designText) {
	const a = parseOta(originalText).elements ?? {};
	const b = parseOta(designText).elements ?? {};
	const out = {};
	for (const [name, e] of Object.entries(b)) {
		for (const [k, v] of Object.entries(e.params)) if (a[name] && a[name].params[k] !== v) out[`${name}.${k}`] = [a[name].params[k], v];
	}
	return out;
}

/** The task data: task.json, spec.md and the original ota.spice of a task directory. */
export function loadTask(taskDir) {
	const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
	const spec = parseSpec(readFileSync(join(taskDir, "spec.md"), "utf8"));
	const original = readFileSync(resolve(taskDir, task.files["ota.spice"]), "utf8");
	return { task, spec, original };
}

/**
 * Verify a design (the text of ota.spice) with the bench and the requirements of the task: the kernel check of
 * requirements.json, one sweep experiment per corner, in a new design root at root. The configuration files
 * come from the task (task.json names them; the task needs no original ota.spice). environment (optional)
 * replaces the environment of the experiments; local (optional) replaces simra.local.json.
 * Returns { corner: { experiment, status, errors, provenance, points, worst } }: points are the rows of the
 * sweep, and worst[m] is { value, vcm, pass } from the verdict row of requirement m at the corner (the worst
 * point over the sweep; a missing point is never a pass). The key design has the design contract check of the
 * verdict: { experiment, status, errors, gate_area_um2, mos_count }.
 */
export async function verify(taskDir, designText, root, environment, local) {
	const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	for (const f of ["simra.config.json", "simra.local.json", "verify.spice", "requirements.json"]) {
		const from = resolve(taskDir, task.files[f]);
		if (existsSync(from)) copyFileSync(from, join(root, f));
	}
	if (local) writeFileSync(join(root, "simra.local.json"), JSON.stringify(local));
	writeFileSync(join(root, "ota.spice"), designText);
	const requirements = JSON.parse(readFileSync(join(root, "requirements.json"), "utf8"));
	if (environment) {
		for (const e of Object.values(requirements.experiments)) e.environment = environment;
		if (requirements.design) requirements.design.environment = environment;
		writeFileSync(join(root, "requirements.json"), JSON.stringify(requirements, null, 2));
	}
	const { verdict } = await runCheck({ root, parallel: 3 });
	const out = {};
	for (const corner of Object.keys(requirements.conditions)) {
		const e = verdict.experiments.find((x) => x.condition === corner);
		const run = e ? loadExperiment(root, e.id) : null;
		const table = run ? join(experimentDir(root, run.id), "work", "sweep.json") : null;
		const points = table && existsSync(table) ? JSON.parse(readFileSync(table, "utf8")).rows : [];
		const provenance = { image_id: run?.experiment.environment?.image_id ?? null, ngspice: run?.result?.tool?.version ?? null, pdk: run?.result?.tool?.pdk ?? null };
		const worst = Object.fromEntries(
			METRICS.map((m) => {
				const row = verdict.rows.find((r) => r.requirement === m && r.condition === corner);
				return [m, { value: row?.value ?? null, vcm: row?.at?.vcm ?? null, pass: row?.status === "pass" }];
			}),
		);
		out[corner] = { experiment: e?.id ?? null, status: e?.status ?? "not_run", errors: run?.result?.errors ?? [], provenance, points, worst };
	}
	const d = verdict.design_check;
	out.design = { experiment: d?.experiment ?? null, status: d?.status ?? "not_run", errors: d?.errors ?? [], gate_area_um2: d?.measurements.gate_area_um2 ?? null, mos_count: d?.measurements.mos_count ?? null };
	return out;
}

/**
 * Score a workspace of an ota-sizing task. The verification goes to verifyRoot (default: next to ws). A test can
 * give its own verifier, with the arguments of verify.
 */
export async function scoreSizing(ws, taskDir, { verifyRoot = join(dirname(ws), "verify"), verifier = verify } = {}) {
	const { task, spec, original } = loadTask(taskDir);
	const report = {
		workspace: ws,
		topology: 0,
		limits: 0,
		requirements: 0,
		claim: 0,
		values: 0,
		max: { topology: 1, limits: 1, requirements: 12, claim: 4, values: 12 },
		meets_spec: null,
		verified_meets_spec: false,
		area_um2: null,
		changed: {},
		rows: {},
		supported: 0,
		verification: null,
		errors: [],
	};
	const designPath = join(ws, "ota.spice");
	const design = existsSync(designPath) ? readFileSync(designPath, "utf8") : null;
	const topology = design === null ? ["ota.spice not found"] : checkTopology(original, design);
	if (topology.length) report.errors.push(...topology.map((e) => `ota.spice: ${e}`));
	else {
		report.topology = 1;
		report.changed = changedSizes(original, design);
		report.area_um2 = Number(gateArea(design, task.length_unit_m).toFixed(3));
		const cc = spiceNumber(parseOta(design).elements.CC.params.value);
		const ok = report.area_um2 <= spec.design.area_um2 && cc <= spec.design.cc_f * (1 + 1e-9);
		if (ok) report.limits = 1;
		else report.errors.push(`design limits: area ${report.area_um2} µm² (limit ${spec.design.area_um2}), Cc ${cc} F (limit ${spec.design.cc_f})`);
		report.verification = await verifier(taskDir, design, verifyRoot);
	}

	let answer = null;
	const answerPath = join(ws, "answer.json");
	if (!existsSync(answerPath)) report.errors.push("answer.json not found");
	else {
		try {
			answer = JSON.parse(readFileSync(answerPath, "utf8"));
		} catch (err) {
			report.errors.push(`answer.json is not valid JSON: ${err.message}`);
		}
	}
	const evidence = numbersIn(
		readTexts(ws)
			.filter((f) => !["answer.json", "ota.spice"].includes(relative(ws, f.path)))
			.map((f) => f.text)
			.join("\n"),
	);
	const rows = Array.isArray(answer?.rows) ? answer.rows : [];
	let allPass = report.topology === 1 && report.limits === 1;
	for (const corner of Object.keys(spec.corners)) {
		for (const m of METRICS) {
			const key = `${corner} ${m}`;
			const v = report.verification?.[corner]?.worst[m] ?? { value: null, vcm: null, pass: false };
			const r = rows.find((x) => x?.corner === corner && x?.requirement === m);
			const s = { verified: v.value, verified_vcm: v.vcm, pass: v.pass, reported: r?.value ?? null, value: false, supported: false };
			report.rows[key] = s;
			allPass &&= v.pass;
			report.requirements += Number(v.pass);
			if (!r || v.value === null) continue;
			s.value = within(r.value, v.value, TOLERANCE[m]);
			s.supported = shown(evidence, m, r.value);
			report.values += Number(s.value);
			report.supported += Number(s.supported);
		}
	}
	report.verified_meets_spec = allPass;
	report.meets_spec = typeof answer?.meets_spec === "boolean" ? answer.meets_spec : null;
	if (report.meets_spec === allPass) report.claim = 4;
	return report;
}

/** The command line of the score.mjs of a task directory: node <task>/score.mjs <workspace>. */
export async function scoreMain(taskDir, argv) {
	if (!argv[2]) {
		console.error(`usage: node ${relative(process.cwd(), join(taskDir, "score.mjs"))} <workspace>`);
		process.exit(2);
	}
	console.log(JSON.stringify(await scoreSizing(resolve(argv[2]), taskDir), null, 2));
}
