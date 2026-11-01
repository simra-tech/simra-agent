// Spec families of the synthesis tasks (ota-synthesis, comparator-synthesis): variants of a task with tighter
// limits, derived from a hidden target design point.
//
// Two concepts:
// - the reference (<task>/<pdk>/expected.json): the known answer of the base task. It sets the base limits and the
//   known-answer tests. It does not change.
// - the target (<task>/<pdk>/target.json): the best known design point of the task on one PDK, with provenance. At
//   first the target is the reference. A verified design of an arm run replaces it when the design is at least as
//   good on every derived metric.
//
// <task>/family.json names the roles of expected.json (reference, known_fail, cheat, input_load) and the limits that
// derive from the target: "requirements" by requirement id, "design" by design limit (only area_um2, the MOS gates
// plus the R and C). Each has
// a kind (upper: limit = worst × f, for <=; lower: limit = worst / f, for >=; lower_db: limit = worst − 20·log10(f),
// for a quantity in dB), the unit and scale of the text of spec.md, and step, the rounding step in the text unit.
// A requirement that family.json does not name (for example iin_a) keeps the limit of the base.
//
// The derivation, for a factor f:
// 1. The worst value of a metric is the worst over the corners of target.result; the area is
//    target.result.design_check.area_um2.
// 2. The raw limit is worst × f, worst / f or worst − 20·log10(f).
// 3. An upper limit rounds up to a multiple of step, a lower or lower_db limit rounds down, so the real margin of
//    the target is at least f.
// 4. A limit never loosens: the variant limit is the tighter of the rounded limit and the base limit.
// f must be at least 1 (the target would fail) and below the largest base factor (base limit / worst, in the
// direction of the kind): else no limit changes.
//
// Usage:
//   node evals/synthesis-family.mjs target <task dir>             the target from the reference role of expected.json
//   node evals/synthesis-family.mjs target <task dir> <run dir>   the target from an arm run (score.json, ws/<design>)
//   node evals/synthesis-family.mjs variant <task dir> <factor>   write the variant directory <task dir>-f<factor>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { designOf } from "./ota-sizing/sizing.mjs";
import { summary } from "./ota-synthesis/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const GENERATED_BY = "evals/synthesis-family.mjs";
/** The relative tolerance of the rounding. */
const EPS = 1e-9;
const OP = { upper: "<=", lower: ">=", lower_db: ">=" };
const AREA = /(Area: the gate area plus the area of the R and C is <= )([\d.]+)( µm²)/;

/** The derived limits of a family: [key, rule, where] with where "requirements" or "design". */
function rules(family) {
	const design = Object.keys(family.design ?? {});
	const bad = design.filter((k) => k !== "area_um2");
	if (bad.length) throw new Error(`family.json: unknown design limits ${bad.join(", ")} (only area_um2)`);
	const all = [...Object.entries(family.requirements ?? {}).map(([k, r]) => [k, r, "requirements"]), ...Object.entries(family.design ?? {}).map(([k, r]) => [k, r, "design"])];
	for (const [k, r] of all) {
		if (!OP[r.kind]) throw new Error(`family.json: ${k}: kind ${r.kind}, expected upper, lower or lower_db`);
		if (!(r.scale > 0) || !(r.step > 0) || typeof r.unit !== "string") throw new Error(`family.json: ${k}: unit, scale and step are required`);
	}
	return all;
}

/** The number of decimals of a step (0.1: 1, 0.5: 1, 1: 0). */
const decimals = (step) => (String(step).split(".")[1] ?? "").length;
/** A clean SI value: 2.9 × 1e-9 is 2.9e-9, not 2.9000000000000003e-9. */
const clean = (x) => Number(x.toPrecision(12));
/** The real margin of a worst value against a limit, in the direction of the kind. */
const marginOf = (kind, worst, limit) => (kind === "upper" ? limit / worst : kind === "lower" ? worst / limit : 10 ** ((worst - limit) / 20));

/** The worst value of a derived metric over the corners of the target (the area for the design limit). */
function worstOf(target, key, rule, where) {
	if (where === "design") {
		const area = target.result.design_check.area_um2;
		if (typeof area !== "number") throw new Error("target: no area_um2 in the design check (verify the target design again)");
		return area;
	}
	const values = Object.entries(target.result.corners).map(([c, v]) => {
		const x = v.worst[key]?.value;
		if (typeof x !== "number") throw new Error(`target: no worst value of ${key} at ${c}`);
		return x;
	});
	return rule.kind === "upper" ? Math.max(...values) : Math.min(...values);
}

/** The base limit of a derived metric (SI units, or µm² for the area), from the parsed base spec. */
function baseLimitOf(baseSpec, key, rule, where) {
	if (where === "design") return baseSpec.design.area_um2;
	const l = baseSpec.limits[key];
	if (!l) throw new Error(`spec.md: no requirement ${key}`);
	if (l.op !== OP[rule.kind]) throw new Error(`spec.md: ${key} is ${l.op}; kind ${rule.kind} needs ${OP[rule.kind]}`);
	return l.value;
}

/** The target from a role of expected.json (the hand reference); design is the netlist text of the role. */
export function targetOf(expected, role, design) {
	if (!expected[role]?.corners) throw new Error(`expected.json: no role ${role}`);
	return { task: expected.task, generated_by: GENERATED_BY, source: { kind: "reference", role }, design, provenance: expected.provenance, result: expected[role] };
}

/**
 * The target from an arm run: scoreJson is the score.json of the run, designText the final design file of its
 * workspace, run the base name of the run directory. It refuses a contaminated run, a run whose design check did
 * not pass or whose rows do not all pass, and a run that is worse than currentTarget on a derived metric.
 */
export function targetOfRun(scoreJson, designText, family, currentTarget, run) {
	const v = scoreJson?.score?.verification;
	if (!v?.design) throw new Error("score.json: no verification");
	const { design, ...corners } = v;
	const metrics = Object.keys(Object.values(corners)[0]?.worst ?? {});
	const result = summary(v, metrics);
	if (scoreJson.contamination?.length) throw new Error(`the run is contaminated: ${scoreJson.contamination.join(", ")}`);
	if (result.design_check.status !== "pass") {
		throw new Error(`the design check of the run is ${result.design_check.status}: ${result.design_check.errors.map((e) => `${e.source}: ${e.message}`).join("; ")}`);
	}
	if (!result.rows_pass) {
		const failed = Object.entries(result.corners).flatMap(([c, x]) => metrics.filter((m) => !x.worst[m].pass).map((m) => `${c} ${m}`));
		throw new Error(`rows of the run fail: ${failed.join(", ")}`);
	}
	// A run of a variant (<task>-f<factor>) has the same bench and design rules, so it can set the target of its base task.
	const base = scoreJson.task?.replace(/-f\d+(\.\d+)?$/, "");
	if (currentTarget && currentTarget.task !== base) throw new Error(`the run is of task ${scoreJson.task}, the target of task ${currentTarget.task}`);
	if (currentTarget) {
		const worse = [];
		for (const [k, r, where] of rules(family)) {
			const [now, got] = [worstOf(currentTarget, k, r, where), worstOf({ result }, k, r, where)];
			if (r.kind === "upper" ? got > now : got < now) worse.push(`${k} ${got} (target ${now})`);
		}
		if (worse.length) throw new Error(`the run is worse than the current target on: ${worse.join(", ")}`);
	}
	const sb = scoreJson.sandbox ?? {};
	return {
		task: base,
		generated_by: GENERATED_BY,
		source: { kind: "run", run, task: scoreJson.task, arm: scoreJson.arm, model: scoreJson.model, started_at: scoreJson.started_at, image: sb.image ?? null, image_id: sb.image_id ?? null },
		design: designText,
		provenance: Object.values(corners)[0].provenance,
		result,
	};
}

/** The base factor of each derived metric: base limit / worst (upper), worst / base limit (lower), 10^((worst − base) / 20) (lower_db). */
export function baseFactors(family, baseSpec, target) {
	return Object.fromEntries(rules(family).map(([k, r, where]) => [k, marginOf(r.kind, worstOf(target, k, r, where), baseLimitOf(baseSpec, k, r, where))]));
}

const listFactors = (factors) =>
	Object.entries(factors)
		.map(([k, x]) => `${k} ${x.toFixed(3)}`)
		.join(", ");

/**
 * The limits of the variant at factor f: { key: { kind, unit, scale, step, base, worst, base_factor, raw, value,
 * text, margin, changed } }. value is in SI units (µm² for the area), text in the unit of spec.md; margin is
 * the real margin of the target. A limit whose base factor is below f keeps its base value (changed false).
 */
export function deriveLimits(family, baseSpec, target, factor) {
	const f = Number(factor);
	const factors = baseFactors(family, baseSpec, target);
	const largest = Math.max(...Object.values(factors));
	if (!(f >= 1)) throw new Error(`factor ${factor} is below 1: the target would fail the variant (base factors: ${listFactors(factors)})`);
	if (f >= largest) throw new Error(`factor ${factor} is at or above the largest base factor ${largest.toFixed(3)}: no limit would change (base factors: ${listFactors(factors)})`);
	const out = {};
	for (const [k, r, where] of rules(family)) {
		const worst = worstOf(target, k, r, where);
		const base = clean(baseLimitOf(baseSpec, k, r, where));
		const raw = r.kind === "upper" ? worst * f : r.kind === "lower" ? worst / f : worst - 20 * Math.log10(f);
		const q = raw / r.scale / r.step;
		const n = r.kind === "upper" ? Math.ceil(q - EPS) : Math.floor(q + EPS);
		const rounded = Number((n * r.step).toFixed(decimals(r.step)));
		const roundedSi = clean(rounded * r.scale);
		const changed = r.kind === "upper" ? roundedSi < base : roundedSi > base;
		const value = changed ? roundedSi : base;
		const text = changed ? String(rounded) : String(clean(base / r.scale));
		out[k] = { where, kind: r.kind, unit: r.unit, scale: r.scale, step: r.step, base, worst, base_factor: factors[k], raw, value, text, margin: marginOf(r.kind, worst, value), changed };
	}
	if (!Object.values(out).some((l) => l.changed)) throw new Error(`factor ${factor}: no limit changes after the rounding (base factors: ${listFactors(factors)})`);
	return out;
}

/**
 * The spec.md of the variant: the base text with the changed limit cells (the table rows by requirement id and the
 * area design rule) and one sentence at the top of the Requirements section. base is the base task name.
 */
export function variantSpec(text, limits, { base, factor }) {
	let out = text;
	for (const [k, l] of Object.entries(limits)) {
		if (!l.changed) continue;
		if (l.where === "design") {
			if ((out.match(new RegExp(AREA.source, "g")) ?? []).length !== 1) throw new Error("spec.md: the area design rule not found");
			out = out.replace(AREA, `$1${l.text}$3`);
			continue;
		}
		const row = new RegExp(`^(\\|[^|\\n]*\\|\\s*\`${k}\`\\s*\\|\\s*${OP[l.kind]}\\s*)(-?[\\d.]+)(\\s*)(\\S*)(\\s*\\|)$`, "m");
		const m = out.match(row);
		if (!m) throw new Error(`spec.md: no row ${OP[l.kind]} for ${k}`);
		if (m[4] !== l.unit) throw new Error(`spec.md: ${k} is in ${m[4] || "no unit"}, family.json gives ${l.unit}`);
		out = out.replace(row, `$1${l.text}$3$4$5`);
	}
	const heading = "## Requirements\n\n";
	if (!out.includes(heading)) throw new Error("spec.md: no Requirements section");
	return out.replace(heading, `${heading}This specification is a variant of ${base} with the limits at factor ${factor} of a hidden design point.\n\n`);
}

/**
 * The requirements.json of the variant: the base (an object) with the changed limits replaced (SI units). The area
 * is a requirement too (id area_um2, on the design experiment).
 */
export function variantRequirements(json, limits) {
	const out = structuredClone(json);
	for (const [k, l] of Object.entries(limits)) {
		if (!l.changed) continue;
		const r = out.requirements.filter((x) => x.id === k);
		if (!r.length) throw new Error(`requirements.json: no requirement ${k}`);
		for (const x of r) {
			if (x.op !== OP[l.kind]) throw new Error(`requirements.json: ${k} is ${x.op}; kind ${l.kind} needs ${OP[l.kind]}`);
			x.limit = l.value;
		}
	}
	return out;
}

/** Whether value passes op limit, as the kernel evaluates a verdict row (a missing value never passes). */
function passes(op, limit, value) {
	if (typeof value !== "number") return false;
	if (op === "between") return value >= limit[0] && value <= limit[1];
	return op === "<=" ? value <= limit : value >= limit;
}

/**
 * A result (in the shape of the roles of expected.json) against the variant spec: the pass flags of the derived
 * requirements, the status of the design check (its errors and the area limit), rows_pass and meets_spec.
 */
function rescore(result, spec, limits) {
	const r = structuredClone(result);
	for (const c of Object.values(r.corners)) {
		for (const [k, l] of Object.entries(limits)) if (l.where === "requirements") c.worst[k].pass = passes(spec.limits[k].op, spec.limits[k].value, c.worst[k].value);
	}
	const area = limits.area_um2;
	const d = r.design_check;
	if (area && d.status !== "not_run") d.status = d.errors.length || !passes("<=", area.value, d.area_um2) ? "fail" : "pass";
	r.rows_pass = Object.values(r.corners).every((c) => Object.values(c.worst).every((w) => w.pass));
	r.meets_spec = d.status === "pass" && r.rows_pass;
	return r;
}

/**
 * The expected.json of the variant, without a simulation: the roles of the base with their pass flags, rows_pass
 * and meets_spec against the new limits, a fourth role target (target.result with its source), spec (the parsed
 * variant spec), limit_margins and provenance. options: family (the roles), base (the base task directory,
 * relative to the repository). It throws when the target does not meet the variant spec, the known fail meets it, or the cheat fails a
 * row.
 */
export function variantExpected(expected, target, spec, limits, factor, { family, base }) {
	const roles = Object.values(family.roles);
	const out = {
		task: `${expected.task}-f${factor}`,
		generated_by: GENERATED_BY,
		provenance: { ...expected.provenance, derived_from: `${base}/expected.json`, target: target.source, factor: Number(factor) },
		spec,
		tolerance: expected.tolerance,
		limit_margins: Object.fromEntries(Object.entries(limits).map(([k, l]) => [k, { base: l.base, limit: l.value, worst: l.worst, factor: Number(l.margin.toFixed(3)) }])),
	};
	for (const role of roles) {
		if (!expected[role]) throw new Error(`expected.json: no role ${role}`);
		out[role] = rescore(expected[role], spec, limits);
	}
	out.target = { source: target.source, ...rescore(target.result, spec, limits) };
	for (const [k, v] of Object.entries(expected)) if (!(k in out)) out[k] = v;

	const { known_fail, cheat, input_load } = family.roles;
	if (!out.target.meets_spec) throw new Error("the target does not meet the variant spec");
	if (out[known_fail].meets_spec) throw new Error(`the known fail (${known_fail}) meets the variant spec`);
	if (!out[cheat].rows_pass) throw new Error(`the cheat (${cheat}) fails a row of the variant spec`);
	if (input_load && out[input_load].meets_spec) throw new Error(`the input load (${input_load}) meets the variant spec`);
	return out;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const json = (x) => `${JSON.stringify(x, null, 2)}\n`;

/** The shared modules of the task of a task directory: parseSpec (synthesis.mjs) and designs (reference.mjs). */
async function taskModules(taskDir) {
	const { parseSpec } = await import(join(dirname(taskDir), "synthesis.mjs"));
	const { designs } = await import(join(dirname(taskDir), "reference.mjs"));
	return { parseSpec, designs: designs(basename(taskDir)) };
}

/** The target of a task directory from the reference role of its expected.json. */
export async function referenceTarget(taskDir) {
	const family = readJson(join(dirname(taskDir), "family.json"));
	const role = family.roles.reference;
	const { designs } = await taskModules(taskDir);
	return targetOf(readJson(join(taskDir, "expected.json")), role, designs[role]);
}

/**
 * The files of the variant of a task directory at factor: { name: text }. spec.md, requirements.json, task.json
 * and expected.json are derived; the other local files of task.json (and its prompt and scorer) are copies.
 */
export async function variantFiles(taskDir, factor) {
	const f = String(Number(factor));
	const family = readJson(join(dirname(taskDir), "family.json"));
	const target = readJson(join(taskDir, "target.json"));
	const task = readJson(join(taskDir, "task.json"));
	const { parseSpec } = await taskModules(taskDir);
	const baseText = readFileSync(join(taskDir, "spec.md"), "utf8");
	const limits = deriveLimits(family, parseSpec(baseText), target, f);
	const text = variantSpec(baseText, limits, { base: task.name, factor: f });
	const spec = parseSpec(text);
	for (const [k, l] of Object.entries(limits)) {
		const got = l.where === "design" ? spec.design.area_um2 : spec.limits[k].value;
		if (Math.abs(got / l.value - 1) > 1e-12) throw new Error(`variant spec.md: ${k} parses as ${got}, the limit is ${l.value}`);
	}
	const files = {
		"spec.md": text,
		"requirements.json": json(variantRequirements(readJson(join(taskDir, "requirements.json")), limits)),
		"task.json": json({ ...task, name: `${task.name}-f${f}` }),
		"expected.json": json(variantExpected(readJson(join(taskDir, "expected.json")), target, spec, limits, f, { family, base: relative(repo, taskDir) })),
	};
	const local = [task.prompt, task.score, ...Object.values(task.files)].filter((p) => !p.includes("/") && !(p in files));
	for (const p of new Set(local)) if (existsSync(join(taskDir, p))) files[p] = readFileSync(join(taskDir, p), "utf8");
	return { dir: `${taskDir}-f${f}`, files, limits };
}

async function main() {
	const [cmd, dirArg, arg] = process.argv.slice(2);
	if (!["target", "variant"].includes(cmd) || !dirArg || (cmd === "variant" && !arg)) {
		console.error("usage: node evals/synthesis-family.mjs target <task dir> [<run dir>]\n       node evals/synthesis-family.mjs variant <task dir> <factor>");
		process.exit(2);
	}
	const taskDir = resolve(dirArg).replace(/\/$/, "");
	if (cmd === "target") {
		let target = await referenceTarget(taskDir);
		if (arg) {
			const run = resolve(arg);
			const family = readJson(join(dirname(taskDir), "family.json"));
			const file = designOf(readJson(join(taskDir, "requirements.json"))).inputs.file;
			const current = existsSync(join(taskDir, "target.json")) ? readJson(join(taskDir, "target.json")) : target;
			target = targetOfRun(readJson(join(run, "score.json")), readFileSync(join(run, "ws", file), "utf8"), family, current, basename(run));
		}
		writeFileSync(join(taskDir, "target.json"), json(target));
		console.log(`wrote ${relative(process.cwd(), join(taskDir, "target.json"))} (source ${JSON.stringify(target.source)})`);
		return;
	}
	const { dir, files, limits } = await variantFiles(taskDir, arg);
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	for (const [k, l] of Object.entries(limits)) {
		console.log(`${k}: worst ${l.worst}, base factor ${l.base_factor.toFixed(3)}, limit ${l.changed ? `${l.text} ${l.unit}` : "unchanged"} (real margin ${l.margin.toFixed(3)})`);
	}
	console.log(`wrote ${relative(process.cwd(), dir)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		await main();
	} catch (err) {
		console.error(`error: ${err.message}`);
		process.exit(1);
	}
}
