// Score a workspace of the det-cell-sg13g2 task (task.md, spec.md).
//
// The scorer does not trust the answer. It checks the device rules of spec.md on det_cell.spice (a text check), then
// runs the check of requirements.json on the final det_cell.spice through the kernel (the bench at each corner).
//
// Score:
// - design (2): det_cell.spice has the subcircuit with the pins in order and only the devices of spec.md.
// - requirements (30): for each corner and requirement, the verified value passes. Given only when the design part
//   passes.
// - claim (4): meets_spec is the same as the verification (the design part and all requirements).
// - values (30): for each row, the reported value is within the tolerance of the verified value.
//
// Diagnostics (no points): reference (the value of the reference design of record through the same bench, from
// expected.json, and the verified value over it), supported (rows whose value appears in a workspace file other than
// answer.json and det_cell.spice), vce_max_v (reported; the bench does not check it), errors.
//
// Usage: node evals/det-cell-sg13g2/score.mjs <workspace>   (prints the score as JSON)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runCheck } from "@simra-tech/kernel";
import { numbersIn, readTexts, within } from "../ota-corners/score.mjs";

const here = new URL(".", import.meta.url).pathname;
const DESIGN = "det_cell.spice";
const PINS = ["lin", "vcc18", "outd", "outr", "iref"];
const DEVICES = ["npn13g2", "cap_cmim", "rppd", "rsil", "rhigh"];
/** Value tolerance of a reported row: relative, or absolute in the unit of the requirement. */
export const TOLERANCE = {
	idd_a: { rel: 0.02 },
	loss_db: { abs: 0.005, rel: 0.05 },
	vout_m10_v: { rel: 0.05 },
	ratio_0_m10: { rel: 0.05 },
	noise_rms_v: { rel: 0.05 },
	offset_v: { abs: 1e-4, rel: 0.05 },
};

const SUFFIX = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9, t: 1e12 };
/** A SPICE number with a scale suffix, or NaN. */
export function spiceNumber(text) {
	const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|[fpnumkgt])?[a-z]*$/i.exec(text);
	return m ? Number(m[1]) * (m[2] ? SUFFIX[m[2].toLowerCase()] : 1) : Number.NaN;
}

/** The device rules of spec.md on the text of det_cell.spice. Returns a list of errors. */
export function checkDesign(text) {
	const errors = [];
	const lines = [];
	for (const raw of text.split("\n")) {
		const l = raw.replace(/[;$].*$/, "").trim();
		if (!l || l.startsWith("*")) continue;
		if (l.startsWith("+") && lines.length) lines[lines.length - 1] += ` ${l.slice(1)}`;
		else lines.push(l);
	}
	const subckts = new Map();
	let current = null;
	for (const l of lines) {
		const f = l.split(/\s+/);
		const head = f[0].toLowerCase();
		if (head === ".subckt") {
			current = f[1].toLowerCase();
			subckts.set(current, f.slice(2).filter((x) => !x.includes("=")).map((x) => x.toLowerCase()));
			continue;
		}
		if (head === ".ends") {
			current = null;
			continue;
		}
		if (head.startsWith(".")) {
			if (![".param", ".end"].includes(head)) errors.push(`${f[0]}: only .subckt, .ends and .param lines are allowed`);
			continue;
		}
		if (!current) {
			errors.push(`${f[0]}: an element outside a .subckt`);
			continue;
		}
		const kind = head[0];
		if ("vibefgh".includes(kind)) errors.push(`${f[0]}: no sources in the cell`);
		else if (kind === "c" || kind === "l" || kind === "r") {
			const v = spiceNumber(f[3] ?? "");
			const max = { c: 50e-15, l: 50e-12, r: 50 }[kind];
			if (!(v > 0)) errors.push(`${f[0]}: the value must be a positive number`);
			else if (v > max * (1 + 1e-9)) errors.push(`${f[0]}: ideal ${kind.toUpperCase()} ${f[3]} is above ${max} (wiring models only)`);
		} else if (kind === "k") {
			const v = spiceNumber(f[3] ?? "");
			if (!(Math.abs(v) <= 1)) errors.push(`${f[0]}: a coupling must be between -1 and 1`);
		} else if (kind === "x") {
			const name = f.filter((x) => !x.includes("=")).at(-1).toLowerCase();
			if (!DEVICES.includes(name) && !subckts.has(name) && !lines.some((x) => x.toLowerCase().startsWith(`.subckt ${name} `)))
				errors.push(`${f[0]}: ${name} is not a device of spec.md`);
		} else errors.push(`${f[0]}: element kind ${kind.toUpperCase()} is not allowed`);
	}
	const pins = subckts.get("det_cell");
	if (!pins) errors.push("no .subckt det_cell");
	else if (pins.join(" ") !== PINS.join(" ")) errors.push(`det_cell pins are "${pins.join(" ")}", expected "${PINS.join(" ")}"`);
	return errors;
}

/** Run the check of requirements.json on the design text in root. Returns {rows: {"corner id": {value, pass}}, experiments}. */
export async function verify(taskDir, designText, root, parallel = 5) {
	const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	for (const f of ["simra.config.json", "simra.local.json", "verify.spice", "requirements.json"]) {
		const from = resolve(taskDir, task.files[f] ?? f);
		if (existsSync(from)) copyFileSync(from, join(root, f));
	}
	writeFileSync(join(root, DESIGN), designText);
	const { verdict } = await runCheck({ root, parallel });
	const rows = {};
	for (const r of verdict.rows) rows[`${r.condition} ${r.requirement}`] = { value: r.value ?? null, pass: r.status === "pass", status: r.status };
	return { rows, experiments: verdict.experiments.map((e) => ({ id: e.id, condition: e.condition, status: e.status })) };
}

export async function score(ws, expected = JSON.parse(readFileSync(join(here, "expected.json"), "utf8")), _agentRoot = ws, { verifyRoot = join(dirname(ws), "verify"), verifier = verify } = {}) {
	const requirements = JSON.parse(readFileSync(join(here, "requirements.json"), "utf8"));
	const corners = Object.keys(requirements.conditions);
	const ids = requirements.requirements.map((r) => r.id);
	const n = corners.length * ids.length;
	const report = { workspace: ws, design: 0, requirements: 0, claim: 0, values: 0, max: { design: 2, requirements: n, claim: 4, values: n }, meets_spec: null, verified_meets_spec: false, design_errors: [], rows: {}, closed: [], missed: [], supported: 0, vce_max_v: null, errors: [] };
	const designPath = join(ws, DESIGN);
	let verified = null;
	if (!existsSync(designPath)) report.errors.push(`${DESIGN} not found`);
	else {
		const text = readFileSync(designPath, "utf8");
		report.design_errors = checkDesign(text);
		if (!report.design_errors.length) report.design = 2;
		verified = await verifier(here, text, verifyRoot);
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
	report.vce_max_v = typeof answer?.vce_max_v === "number" ? answer.vce_max_v : null;
	const evidence = numbersIn(
		readTexts(ws)
			.filter((f) => !["answer.json", DESIGN].includes(relative(ws, f.path)))
			.map((f) => f.text)
			.join("\n"),
	);
	const rows = Array.isArray(answer?.rows) ? answer.rows : [];
	let allPass = report.design === 2;
	for (const c of corners) {
		for (const id of ids) {
			const key = `${c} ${id}`;
			const v = verified?.rows[key] ?? { value: null, pass: false, status: "not_run" };
			const r = rows.find((x) => x?.corner === c && x?.requirement === id);
			const ref = expected.rows?.[key] ?? null;
			const s = { verified: v.value, status: v.status, reported: r?.value ?? null, value: false, supported: false, reference: ref, over_reference: v.value !== null && ref ? v.value / ref : null };
			report.rows[key] = s;
			allPass &&= v.pass;
			if (report.design === 2) report.requirements += Number(v.pass);
			(v.pass ? report.closed : report.missed).push(key);
			if (!r || v.value === null) continue;
			s.value = within(r.value, v.value, TOLERANCE[id]);
			s.supported = typeof r.value === "number" && evidence.some((x) => Math.abs(x - r.value) <= 1e-3 * Math.abs(r.value));
			report.values += Number(s.value);
			report.supported += Number(s.supported);
		}
	}
	report.verified_meets_spec = allPass;
	report.meets_spec = typeof answer?.meets_spec === "boolean" ? answer.meets_spec : null;
	if (report.meets_spec === allPass) report.claim = 4;
	return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (!process.argv[2]) {
		console.error("usage: node evals/det-cell-sg13g2/score.mjs <workspace>");
		process.exit(2);
	}
	console.log(JSON.stringify(await score(resolve(process.argv[2])), null, 2));
}
