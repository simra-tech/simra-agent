// Score a workspace of the lna-sg13g2 task (task.md, spec.md).
//
// The scorer does not trust the answer. It checks the device rules of spec.md on lna.spice (a text check), finds the
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

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runCheck } from "@simra-tech/kernel";
import { spiceNumber } from "../det-cell-sg13g2/score.mjs";
import { numbersIn, readTexts, within } from "../ota-corners/score.mjs";

const here = new URL(".", import.meta.url).pathname;
const DESIGN = "lna.spice";
const PINS = ["rfin", "rfout", "vcc18", "iref1", "iref2", "iref3"];
const DEVICES = ["npn13g2", "cap_cmim", "rppd", "rsil", "rhigh"];
const LINES = ["tm2_w6", "tm2_w13", "tm2_w23"];
const BENCH_FILES = ["simra.config.json", "simra.local.json", "sp.spice", "noise.spice", "lines.spice", "requirements.json"];
export const TOLERANCE = {
	gain: { abs: 0.1 },
	s22: { abs: 0.3 },
	nf_db: { abs: 0.1 },
	mu: { rel: 0.02 },
	idd_a: { rel: 0.02 },
};

/** The logical lines of a SPICE text: comments removed, continuations joined. */
export function logicalLines(text) {
	const lines = [];
	for (const raw of text.split("\n")) {
		const l = raw.replace(/[;$].*$/, "").trim();
		if (!l || l.startsWith("*")) continue;
		if (l.startsWith("+") && lines.length) lines[lines.length - 1] += ` ${l.slice(1).trim()}`;
		else lines.push(l);
	}
	return lines;
}

/** The subcircuits of a SPICE text: name -> {pins, body (normalised element lines)}. */
export function subcircuits(text) {
	const out = new Map();
	let current = null;
	for (const l of logicalLines(text)) {
		const f = l.split(/\s+/);
		const head = f[0].toLowerCase();
		if (head === ".subckt") {
			current = { name: f[1].toLowerCase(), pins: f.slice(2).filter((x) => !x.includes("=")).map((x) => x.toLowerCase()), body: [] };
			out.set(current.name, current);
		} else if (head === ".ends") current = null;
		else if (current) current.body.push(f.join(" ").toLowerCase());
	}
	return out;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * The fitted subcircuits of the records of a workspace that come from an EM run: [{name, body, fit, em}], and the
 * refused fits with a reason. A fit counts when its input Touchstone file has the SHA-256 of a Touchstone output of a
 * completed openems experiment.
 */
export function emFits(ws) {
	const dir = join(ws, "simra", "experiments");
	const found = [];
	const refused = [];
	if (!existsSync(dir)) return { found, refused };
	const records = [];
	for (const id of readdirSync(dir).sort()) {
		const e = join(dir, id);
		if (!existsSync(join(e, "experiment.json")) || !existsSync(join(e, "result.json"))) continue;
		try {
			records.push({ id, exp: readJson(join(e, "experiment.json")), res: readJson(join(e, "result.json")) });
		} catch {
			// an unreadable record is not evidence
		}
	}
	const emHashes = new Map();
	for (const r of records) {
		if (r.exp.adapter?.name !== "openems" || r.res.status !== "completed") continue;
		for (const o of r.res.outputs ?? []) if (o.role === "touchstone" && o.sha256) emHashes.set(o.sha256, r.id);
	}
	for (const r of records) {
		if (r.exp.adapter?.name !== "touchstone" || r.exp.operation !== "fit_to_spice") continue;
		if (r.res.status !== "completed") {
			refused.push({ fit: r.id, reason: `status ${r.res.status}` });
			continue;
		}
		const inputs = r.res.input_files?.files ?? [];
		const em = inputs.map((f) => emHashes.get(f.sha256)).find(Boolean);
		if (!em) {
			refused.push({ fit: r.id, reason: "its Touchstone input is not the output of an openems record" });
			continue;
		}
		for (const o of r.res.outputs ?? []) {
			if (o.role !== "subckt") continue;
			const path = join(ws, o.path);
			if (!existsSync(path) || sha256(path) !== o.sha256) {
				refused.push({ fit: r.id, reason: `${o.path} is missing or changed` });
				continue;
			}
			for (const s of subcircuits(readFileSync(path, "utf8")).values()) found.push({ name: s.name, body: s.body, fit: r.id, em });
		}
	}
	return { found, refused };
}

/** The .param values of a SPICE text (all scopes in one table; a later line wins). Values may use earlier names. */
export function paramTable(text) {
	const table = {};
	for (const l of logicalLines(text)) {
		if (!/^\.param\s/i.test(l)) continue;
		for (const m of l.slice(6).matchAll(/([A-Za-z_]\w*)\s*=\s*(\{[^}]*\}|\S+)/g)) {
			const v = value(m[2], table);
			if (Number.isFinite(v)) table[m[1].toLowerCase()] = v;
		}
	}
	return table;
}

/** A number, a number with a SPICE suffix, or {expression} of numbers, .param names and + - * / ( ); else NaN. */
export function value(text, table = {}) {
	if (text === undefined) return Number.NaN;
	const m = /^\{(.*)\}$/.exec(text.trim());
	if (!m) return spiceNumber(text);
	let bad = false;
	const expr = m[1].replace(/(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)(meg|[fpnumkgt])?(?![\w.])|([A-Za-z_]\w*)/gi, (all, num, suffix, name) => {
		if (name !== undefined) {
			const v = table[name.toLowerCase()];
			if (!Number.isFinite(v)) bad = true;
			return `(${v})`;
		}
		return `(${spiceNumber(num + (suffix ?? ""))})`;
	});
	if (bad || !/^[\d\s.eE+\-*/()]*$/.test(expr)) return Number.NaN;
	try {
		const v = Function(`"use strict"; return (${expr});`)();
		return typeof v === "number" ? v : Number.NaN;
	} catch {
		return Number.NaN;
	}
}

/** The device rules of spec.md on the text of lna.spice. fits: the fitted subcircuits of emFits. Returns {errors, em}. */
export function checkDesign(text, fits = []) {
	const errors = [];
	const subs = subcircuits(text);
	const params = paramTable(text);
	const fitted = new Map();
	for (const s of subs.values()) {
		const f = fits.find((x) => x.body.length === s.body.length && x.body.every((b, i) => b === s.body[i]));
		if (f) fitted.set(s.name, f);
	}
	let current = null;
	for (const l of logicalLines(text)) {
		const f = l.split(/\s+/);
		const head = f[0].toLowerCase();
		if (head === ".subckt") {
			current = f[1].toLowerCase();
			if (LINES.includes(current) || DEVICES.includes(current)) errors.push(`.subckt ${f[1]}: the name of a given device or line`);
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
		if (fitted.has(current)) continue;
		const kind = head[0];
		if ("vibefgh".includes(kind)) errors.push(`${f[0]}: no sources in the amplifier (subcircuit ${current} is not a recorded EM fit)`);
		else if (kind === "c" || kind === "l" || kind === "r") {
			const v = value(f[3], params);
			const max = { c: 50e-15, l: 50e-12, r: 50 }[kind];
			if (!(v > 0)) errors.push(`${f[0]}: the value must be a positive number`);
			else if (v > max * (1 + 1e-9)) errors.push(`${f[0]}: ideal ${kind.toUpperCase()} ${f[3]} is above ${max} (wiring models only)`);
		} else if (kind === "k") {
			if (!(Math.abs(value(f[3], params)) <= 1)) errors.push(`${f[0]}: a coupling must be between -1 and 1`);
		} else if (kind === "x") {
			const name = f.filter((x) => !x.includes("=")).at(-1).toLowerCase();
			if (LINES.includes(name)) {
				const len = f.find((x) => /^len=/i.test(x));
				const v = len ? value(len.slice(4), params) : Number.NaN;
				if (!(v > 0 && v <= 1e-3 * (1 + 1e-9))) errors.push(`${f[0]}: ${name} needs len=<metres>, 0 < len <= 1e-3`);
			} else if (!DEVICES.includes(name) && !subs.has(name)) errors.push(`${f[0]}: ${name} is not a device of spec.md`);
		} else errors.push(`${f[0]}: element kind ${kind.toUpperCase()} is not allowed`);
	}
	const lna = subs.get("lna");
	if (!lna) errors.push("no .subckt lna");
	else if (lna.pins.join(" ") !== PINS.join(" ")) errors.push(`lna pins are "${lna.pins.join(" ")}", expected "${PINS.join(" ")}"`);
	// the fitted subcircuits that lna uses, directly or through other subcircuits
	const used = new Set();
	const walk = (name, seen = new Set()) => {
		if (seen.has(name) || !subs.has(name)) return;
		seen.add(name);
		for (const b of subs.get(name).body) {
			if (!b.startsWith("x")) continue;
			const child = b.split(" ").filter((x) => !x.includes("=")).at(-1);
			if (fitted.has(child)) used.add(child);
			walk(child, seen);
		}
	};
	walk("lna");
	return { errors, em: [...used].map((n) => ({ subckt: n, fit: fitted.get(n).fit, em: fitted.get(n).em })) };
}

/** Run the check of requirements.json on the design text in root. Returns {rows: {"corner requirement": {value, pass, status}}, experiments}. */
export async function verify(taskDir, designText, root, parallel = 5) {
	const task = readJson(join(taskDir, "task.json"));
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	for (const f of BENCH_FILES) {
		const from = resolve(taskDir, task.files[f] ?? f);
		if (existsSync(from)) copyFileSync(from, join(root, f));
	}
	writeFileSync(join(root, DESIGN), designText);
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
		verified = await verifier(here, text, verifyRoot);
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
