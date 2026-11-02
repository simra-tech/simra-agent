// Shared parts of the layout tasks: layout-drc-fix (fix the seeded DRC violations of a cell) and layout-clean
// (verify a clean cell, with no false alarm and no needless edit). One task directory for each PDK.
//
// The scorer does not trust the answer. It runs the stock DRC and LVS decks again on the final cell.gds of the
// workspace, in the container of the task, with the wrappers drc.sh and lvs.sh and the reference netlist of the task
// directory (not the copies in the workspace). The verification goes to verify/ next to the workspace.
//
// Score:
// - drc (4): the DRC of the final cell.gds ran and reports 0 markers.
// - lvs (4): the LVS of the final cell.gds ran, the netlists match, and the pins of the layout are the pins of
//   spec.md.
// - claim (4): drc_clean and lvs_match of answer.json agree with the verification, the answer has a check row for
//   DRC and for LVS, a claim of true has its check row with ran: true, and each row with ran: true names a report
//   file that is in the workspace.
// - fixed (3): layout-drc-fix: the rules of `fixed` are the seeded rules (expected.json). layout-clean: the final
//   cell.gds has the hash of the input, and `fixed` is an empty list.
//
// Diagnostics (no points): the marker count of each rule, the LVS status text and the pins, the hash of the final
// cell.gds, the check rows with ran: false (not_run), the deck runtimes of the verification, the run metrics from
// transcript.jsonl next to the workspace (tool_calls, inline_python_calls, result_bytes) and errors.
//
// A deck result is "not_run" when the deck did not complete: no report, a report that does not parse, or an exit
// code that does not agree with the printed result (for example a deck that prints a match and then crashes).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { loadConfig } from "@simra-tech/kernel";
import { containerImageId, containerUser } from "../../packages/kernel/src/environments.ts";

export const MAX = { drc: 4, lvs: 4, claim: 4, fixed: 3 };

/** The cell, the files and the pins of spec.md. */
export function parseSpec(text) {
	const cell = text.match(/The cell is the top cell `(\w+)` in `([\w.]+)`, with the pins `([\w ]+)`, in this order\./);
	const net = text.match(/The reference netlist is the subcircuit `(\w+)` in `([\w.]+)`\./);
	if (!cell || !net) throw new Error("spec.md: the cell, the pins or the reference netlist not found");
	return { cell: cell[1], gds: cell[2], pins: cell[3].split(" "), subckt: net[1], netlist: net[2] };
}

/** The pins of a subcircuit in a SPICE netlist (with + continuation lines), or null. */
export function subcktPins(text, name) {
	const joined = text.replace(/\r/g, "").replace(/\n\+/g, " ");
	const m = joined.match(new RegExp(`^\\s*\\.subckt\\s+${name}\\b([^\\n]*)$`, "im"));
	return m ? m[1].trim().split(/\s+/).filter((p) => p && !p.includes("=")) : null;
}

/** A rule name of a marker database: without the quotes that some decks put around it. */
export const ruleName = (s) => String(s).trim().replace(/^['"]|['"]$/g, "");

const unxml = (s) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The markers of a KLayout marker database (.lyrdb): { markers, rules: { rule: count } }, or null if it does not parse. */
export function parseLyrdb(text) {
	if (typeof text !== "string" || !/<report-database>/.test(text) || !/<\/report-database>\s*$/.test(text)) return null;
	const items = text.match(/<items>([\s\S]*?)<\/items>|<items\s*\/>/);
	if (!items) return null;
	const rules = {};
	let markers = 0;
	for (const item of (items[1] ?? "").matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const cat = item[1].match(/<category>([\s\S]*?)<\/category>/);
		if (!cat) return null;
		const rule = ruleName(unxml(cat[1]));
		const mult = Number(item[1].match(/<multiplicity>(\d+)<\/multiplicity>/)?.[1] ?? 1);
		rules[rule] = (rules[rule] ?? 0) + mult;
		markers += mult;
	}
	return { markers, rules };
}

/**
 * The DRC result of one deck run. exit: the exit code of the deck. text: what the deck and the wrapper printed.
 * report: the text of the marker database, or null. A deck exits with 0, or with 1 when it found violations (IHP);
 * other codes, a code 1 without markers, or a printed pass that the report does not support give "not_run".
 */
export function drcResult({ exit, text = "", report }) {
	const db = report == null ? null : parseLyrdb(report);
	const notRun = (reason) => ({ status: "not_run", markers: null, rules: {}, exit, reason });
	if (report == null) return notRun("no marker database");
	if (!db) return notRun("the marker database does not parse");
	const passPrinted = /DRC Check Passed|No DRC violations detected/.test(text);
	if (exit !== 0 && !(exit === 1 && db.markers > 0)) return notRun(`the deck exited with code ${exit}${passPrinted ? " after it printed a pass" : ""}`);
	if (passPrinted && db.markers > 0) return notRun("the deck printed a pass, but the marker database has markers");
	return { status: db.markers === 0 ? "clean" : "violations", markers: db.markers, rules: db.rules, exit, reason: null };
}

/**
 * The LVS result of one deck run. text: what the deck and the wrapper printed. report: true if the LVS database
 * exists. A match needs the printed match, exit code 0 and the database; a mismatch needs the printed mismatch,
 * exit code 0 or 1 and the database. Else "not_run" (for example a match printed before a crash).
 */
export function lvsResult({ exit, text = "", report }) {
	const match = /Congratulations! Netlists match/.test(text);
	const mismatch = /Netlists don't match/.test(text);
	const notRun = (reason) => ({ status: "not_run", exit, reason });
	if (!report) return notRun("no LVS database");
	if (mismatch) return [0, 1].includes(exit) ? { status: "mismatch", exit, reason: null } : notRun(`the deck printed a mismatch and exited with code ${exit}`);
	if (match) return exit === 0 ? { status: "match", exit, reason: null } : notRun(`the deck printed a match and exited with code ${exit}`);
	return notRun("the deck printed no LVS result");
}

/**
 * Run metrics of an agent transcript (the event stream of pi, OpenCode or Codex CLI): tool_calls, inline_python_calls
 * (shell commands that run Python code from the command line: python -c, or a script on standard input) and
 * result_bytes (the UTF-8 bytes of the tool results).
 */
export function transcriptMetrics(text) {
	const inline = /\bpython[\d.]*(?:\s+-[A-Za-z]+)*\s+(?:-[A-Za-z]*c\b|-\s*<<|<<|-\s*$)/m;
	const bytes = (s) => (typeof s === "string" ? Buffer.byteLength(s, "utf8") : 0);
	const out = { format: null, tool_calls: 0, inline_python_calls: 0, result_bytes: 0 };
	const command = (c) => {
		out.tool_calls += 1;
		if (typeof c === "string" && inline.test(c)) out.inline_python_calls += 1;
	};
	for (const line of text.split("\n")) {
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e?.type === "tool_execution_start") {
			// pi: the arguments at the start of the call, the result at the end.
			out.format = "pi";
			command(e.args?.command);
		} else if (e?.type === "tool_execution_end") {
			for (const c of e.result?.content ?? []) out.result_bytes += bytes(c?.text);
		} else if (e?.type === "item.completed" && e.item && !["agent_message", "reasoning"].includes(e.item.type)) {
			out.format = "codex";
			command(e.item.command);
			out.result_bytes += bytes(e.item.aggregated_output);
		} else if (e?.type === "tool_use" && e.part?.type === "tool") {
			out.format = "opencode";
			command(e.part.state?.input?.command);
			out.result_bytes += bytes(e.part.state?.output ?? e.part.state?.error);
		}
	}
	return out;
}

export const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The task data: task.json, spec.md and expected.json of a task directory. */
export function loadTask(taskDir) {
	const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
	const spec = parseSpec(readFileSync(resolve(taskDir, task.files["spec.md"]), "utf8"));
	const expectedPath = join(taskDir, "expected.json");
	const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) : null;
	return { task, spec, expected };
}

/** The container environment of the task, from simra.config.json and simra.local.json in root. */
export function taskEnvironment(root, task) {
	const env = loadConfig(root).environments[task.environment];
	if (!env || env.kind !== "container") throw new Error(`environment "${task.environment}" must be a container environment`);
	return env;
}

/** Run a shell script in the container of env, with root mounted at its own path, in root. */
export function runContainer(env, root, script, mounts = {}) {
	const engine = env.engine ?? "podman";
	const imageId = containerImageId(engine, env.image);
	if (env.image_id && env.image_id !== imageId) throw new Error(`image ${env.image} is ${imageId}, expected ${env.image_id}`);
	const pin = env.cpus ? ["taskset", "-c", env.cpus] : [];
	const args = [
		"run",
		"--rm",
		"--network",
		"none",
		"--pull",
		"never",
		"-u",
		containerUser(engine),
		...Object.entries(env.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
		"-v",
		`${root}:${root}`,
		...Object.entries(mounts).flatMap(([from, to]) => ["-v", `${from}:${to}:ro`]),
		"-w",
		root,
		imageId,
		...pin,
		"sh",
		"-c",
		script,
	];
	return new Promise((res) => {
		const child = spawn(engine, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (err) => res({ code: null, stdout, stderr: `${stderr}${err.message}`, engine, imageId }));
		child.on("close", (code) => res({ code, stdout, stderr, engine, imageId }));
	});
}

/** The script that runs the two wrappers on gds and records the exit code and the start and end time of each. */
const checksScript = (gds, cell) =>
	`for c in drc lvs; do s=$(date +%s.%N); ./$c.sh ${gds} ${cell} > $c.out 2>&1; code=$?; e=$(date +%s.%N); echo "$c $code $s $e" >> status.txt; done`;

/** A file that the wrapper output names after "<label>: ", relative to dir, or null. */
function named(dir, out, label) {
	const m = out.match(new RegExp(`^${label}: (\\S+)$`, "m"));
	return m && m[1] !== "none" && existsSync(join(dir, m[1])) ? join(dir, m[1]) : null;
}

/** Read the results of the checks in dir (see checksScript) and the pins of the extracted netlist. */
export function readChecks(dir, subckt) {
	const status = existsSync(join(dir, "status.txt")) ? readFileSync(join(dir, "status.txt"), "utf8") : "";
	const run = Object.fromEntries(
		status
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split(" "))
			.map(([c, code, s, e]) => [c, { exit: Number(code), runtime_s: Math.round((Number(e) - Number(s)) * 1000) / 1000 }]),
	);
	const text = (f) => (f && existsSync(f) ? readFileSync(f, "utf8") : "");
	const drcOut = text(join(dir, "drc.out"));
	const drcReport = named(dir, drcOut, "DRC report");
	const drc = run.drc
		? drcResult({ exit: run.drc.exit, text: `${drcOut}\n${text(named(dir, drcOut, "DRC log"))}`, report: drcReport ? text(drcReport) : null })
		: { status: "not_run", markers: null, rules: {}, exit: null, reason: "the DRC wrapper did not run" };
	const lvsOut = text(join(dir, "lvs.out"));
	const lvs = run.lvs
		? lvsResult({ exit: run.lvs.exit, text: `${lvsOut}\n${text(named(dir, lvsOut, "LVS log"))}`, report: named(dir, lvsOut, "LVS report") !== null })
		: { status: "not_run", exit: null, reason: "the LVS wrapper did not run" };
	const extracted = named(dir, lvsOut, "LVS extracted netlist");
	lvs.pins = extracted ? subcktPins(text(extracted), subckt) : null;
	drc.runtime_s = run.drc?.runtime_s ?? null;
	lvs.runtime_s = run.lvs?.runtime_s ?? null;
	return {
		drc: { ...drc, report: drcReport ? relative(dir, drcReport) : null },
		lvs: { ...lvs, report: named(dir, lvsOut, "LVS report") ? relative(dir, named(dir, lvsOut, "LVS report")) : null, status_text: lvsOut.match(/^LVS status: (.*)$/m)?.[1] ?? null },
	};
}

/**
 * Verify a GDS file with the task's wrappers in the task's container. root: an empty directory for the run (it is
 * removed first). local: a simra.local.json object that replaces the one of the task (tests). Returns
 * { gds_sha256, drc, lvs, image_id, errors }.
 */
export async function verify(taskDir, gdsPath, root, local) {
	const { task, spec } = loadTask(taskDir);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	for (const f of ["simra.config.json", "simra.local.json", "drc.sh", "lvs.sh", spec.netlist]) {
		const from = resolve(taskDir, task.files[f]);
		if (existsSync(from)) copyFileSync(from, join(root, f));
	}
	if (local) writeFileSync(join(root, "simra.local.json"), JSON.stringify(local));
	copyFileSync(gdsPath, join(root, spec.gds));
	const env = taskEnvironment(root, task);
	const r = await runContainer(env, root, checksScript(spec.gds, spec.cell));
	const out = { gds_sha256: sha256(join(root, spec.gds)), image_id: r.imageId, ...readChecks(root, spec.subckt), errors: [] };
	if (r.code !== 0) out.errors.push(`verification container exited with code ${r.code}: ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
	return out;
}

/** A path of the answer, relative to the workspace (an absolute path under inside, the workspace in the sandbox). */
function inWorkspace(ws, p, inside) {
	if (typeof p !== "string" || !p) return null;
	let rel = p;
	if (isAbsolute(p)) {
		if (inside && (p === inside || p.startsWith(`${inside}/`))) rel = relative(inside, p);
		else if (p.startsWith(`${ws}/`)) rel = relative(ws, p);
		else return null;
	}
	rel = normalize(rel);
	if (rel.startsWith("..") || isAbsolute(rel)) return null;
	const full = join(ws, rel);
	return existsSync(full) && statSync(full).isFile() ? full : null;
}

const sameSet = (a, b) => a.length === b.length && new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));
const kindOf = (row) => (/drc/i.test(String(row?.check ?? "")) ? "drc" : /lvs/i.test(String(row?.check ?? "")) ? "lvs" : null);

/**
 * Score a workspace of a layout task. mode: "drc-fix" or "clean". The verification goes to verifyRoot (default:
 * verify/ next to ws). A test can give its own verifier, with the arguments of verify. inside: the path of the
 * workspace in the sandbox (/work), for absolute report paths in the answer. transcript: the agent transcript
 * (default: transcript.jsonl next to ws).
 */
export async function scoreLayout(ws, taskDir, { mode, verifyRoot = join(dirname(ws), "verify"), verifier = verify, inside = "/work", transcript = join(dirname(ws), "transcript.jsonl") } = {}) {
	if (!["drc-fix", "clean"].includes(mode)) throw new Error(`unknown mode ${mode}`);
	const { spec, expected } = loadTask(taskDir);
	const report = {
		workspace: ws,
		drc: 0,
		lvs: 0,
		claim: 0,
		fixed: 0,
		max: { ...MAX },
		drc_status: "not_run",
		drc_markers: null,
		drc_rules: {},
		lvs_status: "not_run",
		lvs_status_text: null,
		lvs_pins: null,
		pins_ok: false,
		gds_sha256: null,
		input_sha256: expected?.variants?.[expected.input]?.sha256 ?? null,
		hash_unchanged: null,
		drc_clean: null,
		lvs_match: null,
		not_run: [],
		stale_reports: [],
		fixed_rules: [],
		runtime_s: { drc: null, lvs: null },
		metrics: null,
		verification: null,
		errors: [],
	};
	if (!expected) report.errors.push("expected.json not found in the task directory");

	// The verification of the final GDS.
	const gds = join(ws, spec.gds);
	let verified = { drc: false, lvs: false };
	if (!existsSync(gds)) report.errors.push(`${spec.gds} not found`);
	else {
		const v = await verifier(taskDir, gds, verifyRoot);
		report.verification = v;
		report.gds_sha256 = v.gds_sha256;
		report.hash_unchanged = report.input_sha256 ? v.gds_sha256 === report.input_sha256 : null;
		report.drc_status = v.drc.status;
		report.drc_markers = v.drc.markers;
		report.drc_rules = v.drc.rules;
		report.lvs_status = v.lvs.status;
		report.lvs_status_text = v.lvs.status_text ?? null;
		report.lvs_pins = v.lvs.pins;
		report.pins_ok = Array.isArray(v.lvs.pins) && sameSet(v.lvs.pins, spec.pins);
		report.runtime_s = { drc: v.drc.runtime_s ?? null, lvs: v.lvs.runtime_s ?? null };
		report.errors.push(...(v.errors ?? []));
		if (v.drc.status === "not_run") report.errors.push(`DRC not run: ${v.drc.reason}`);
		if (v.lvs.status === "not_run") report.errors.push(`LVS not run: ${v.lvs.reason}`);
		verified = { drc: v.drc.status === "clean", lvs: v.lvs.status === "match" && report.pins_ok };
		if (verified.drc) report.drc = MAX.drc;
		if (verified.lvs) report.lvs = MAX.lvs;
	}

	// The answer.
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
	report.drc_clean = typeof answer?.drc_clean === "boolean" ? answer.drc_clean : null;
	report.lvs_match = typeof answer?.lvs_match === "boolean" ? answer.lvs_match : null;
	const rows = Array.isArray(answer?.checks) ? answer.checks : [];
	const gdsTime = existsSync(gds) ? statSync(gds).mtimeMs : null;
	let rowsOk = ["drc", "lvs"].every((k) => rows.some((r) => kindOf(r) === k));
	if (!rowsOk) report.errors.push("answer.json: checks needs a row for drc and a row for lvs");
	for (const r of rows) {
		if (r?.ran !== true) {
			report.not_run.push({ check: r?.check ?? null, note: r?.note ?? null });
			continue;
		}
		const file = inWorkspace(ws, r.report, inside);
		if (!file) {
			rowsOk = false;
			report.errors.push(`answer.json: the report of check ${r.check} (${r.report}) is not a file in the workspace`);
		} else if (gdsTime !== null && statSync(file).mtimeMs < gdsTime) report.stale_reports.push(relative(ws, file));
	}
	const ranRow = (k) => rows.some((r) => kindOf(r) === k && r.ran === true);
	const backed = (report.drc_clean !== true || ranRow("drc")) && (report.lvs_match !== true || ranRow("lvs"));
	if (!backed) report.errors.push("answer.json: a claim of true has no check row with ran: true");
	if (report.drc_clean === verified.drc && report.lvs_match === verified.lvs && rowsOk && backed) report.claim = MAX.claim;

	// The fixed rules.
	const fixed = Array.isArray(answer?.fixed) ? answer.fixed : null;
	report.fixed_rules = (fixed ?? []).map((f) => ruleName(typeof f === "string" ? f : (f?.rule ?? "")));
	if (mode === "drc-fix") {
		const seeded = Object.keys(expected?.variants?.seeded?.drc?.rules ?? {});
		const norm = (a) => [...new Set(a.map((x) => x.toLowerCase()))];
		if (seeded.length && fixed && sameSet(norm(report.fixed_rules), norm(seeded))) report.fixed = MAX.fixed;
	} else if (report.hash_unchanged === true && fixed && fixed.length === 0) report.fixed = MAX.fixed;

	// The run metrics.
	report.metrics = existsSync(transcript) ? transcriptMetrics(readFileSync(transcript, "utf8")) : "not_run (no transcript.jsonl next to the workspace)";
	return report;
}

/** The command line of the score.mjs of a task directory: node <task>/score.mjs <workspace>. */
export async function scoreMain(taskDir, mode, argv) {
	if (!argv[2]) {
		console.error(`usage: node ${relative(process.cwd(), join(taskDir, "score.mjs"))} <workspace>`);
		process.exit(2);
	}
	console.log(JSON.stringify(await scoreLayout(resolve(argv[2]), taskDir, { mode }), null, 2));
}
