// The reference results of the layout-long-job task (the flat block), for one PDK or both.
//
// 1. Make the three variants of the flat block (clean, seeded and cheat) and the flat reference netlist with
//    <pdk>/generate.py, and verify each variant with the wrappers drc.sh and lvs.sh of layout-block-fix
//    (reference() of ../layout-block-fix/reference.mjs, with this task directory).
// 2. Check the roles (checkRoles() of layout-block-fix): clean has 0 markers and matches; seeded has exactly the
//    seeded rules (8 to 12 rules, 30 to 100 markers) and matches; cheat has 0 markers and does not match.
// 3. Run the klayout adapter (the kernel runner, as the run_experiment tool runs it) on the seeded block: drc with
//    the default rule set of the technology pack, and lvs. Check that the adapter gives the marker count, the count
//    of each rule and the LVS status of the wrappers.
// 4. Record the 1-min load average of the host at the start and at the end. Runtimes are valid only on an idle host
//    (load under IDLE_LOAD for the whole run).
// 5. With --write: write <pdk>/block.spice, <pdk>/flat-seeded.gds (not committed), <pdk>/expected.json and the
//    SHA-256 of flat-seeded.gds in <pdk>/task.json ("generated"). --write stops if the host was not idle; with
//    --loaded it writes, and expected.json marks the runtimes as measured under load.
//
// Usage:
//   node evals/layout-long-job/reference.mjs [sg13g2|sky130 ...] [--write [--loaded]]
//   node evals/layout-long-job/reference.mjs <sg13g2|sky130> --gds
//     (make only <pdk>/flat-seeded.gds in the container and check its SHA-256 with task.json; some seconds)

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runExperiment } from "@simra-tech/kernel";
import { checkRoles, PDKS, reference, seedList, VARIANTS } from "../layout-block-fix/reference.mjs";
import { loadTask, runContainer, sha256, taskEnvironment } from "../layout-drc-fix/layout.mjs";
import { deckCommand } from "../layout-drc-fix/reference.mjs";

const here = new URL(".", import.meta.url).pathname;
const evals = resolve(here, "..");

/** The host is idle when the 1-min load average is under this value. */
export const IDLE_LOAD = 10;

/**
 * The runtime target of the wrappers in the container, on an idle host (s): the longer deck takes at least
 * long_deck_min_s, and one eval run (two DRC runs and one LVS run) takes at most eval_deck_max_s of deck time.
 */
export const RUNTIME_TARGET_S = { long_deck_min_s: 180, eval_deck_max_s: 720 };

/** The generated GDS of the task (the seeded flat block), relative to <pdk>/. */
export const GENERATED = "flat-seeded.gds";

const load1 = () => Math.round(loadavg()[0] * 100) / 100;
const values = (result) => Object.fromEntries(Object.entries(result.measurements).map(([k, m]) => [k, m.value]));

/**
 * The runtime record of the wrappers: for each deck, the shortest and the longest runtime of runs; long_deck_s: the
 * longer deck (its shortest run); eval_deck_s: 2 x the longest DRC run + the longest LVS run; in_target: both in
 * the target. margin (tests): the factor by which a runtime may miss the target.
 */
export function runtimeRecord(runs, target = RUNTIME_TARGET_S, margin = 1) {
	const span = (c) => ({ min: Math.min(...runs.map((r) => r[c])), max: Math.max(...runs.map((r) => r[c])) });
	const drc = span("drc");
	const lvs = span("lvs");
	const long_deck_s = Math.max(drc.min, lvs.min);
	const eval_deck_s = Math.round((2 * drc.max + lvs.max) * 1000) / 1000;
	return { drc, lvs, long_deck_s, eval_deck_s, in_target: long_deck_s >= target.long_deck_min_s / margin && eval_deck_s <= target.eval_deck_max_s * margin };
}

/**
 * A design root in work/<name> with gds as block.gds, the reference netlist and the configuration of the task. local:
 * a simra.local.json object that replaces the one of the task (tests).
 */
export function designRoot(taskDir, work, name, gds, netlist, local) {
	const { task, spec } = loadTask(taskDir);
	const root = join(work, name);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	copyFileSync(gds, join(root, spec.gds));
	copyFileSync(netlist, join(root, spec.netlist));
	copyFileSync(resolve(taskDir, task.files["simra.config.json"]), join(root, "simra.config.json"));
	const localFile = resolve(taskDir, task.files["simra.local.json"] ?? "-");
	if (local) writeFileSync(join(root, "simra.local.json"), JSON.stringify(local));
	else
		try {
			copyFileSync(localFile, join(root, "simra.local.json"));
		} catch {}
	return root;
}

/**
 * Run the klayout adapter on gds in the design root: drc (default rule set) and lvs. Returns { drc: { status,
 * markers, rules, runtime_s, command }, lvs: { status, match, runtime_s, command } }. command: the deck command line,
 * with the design root as ".".
 */
export async function adapterRun(root, spec) {
	const cmd = (result) => (result.commands ?? []).map((c) => c.argv.map((a) => a.split(root).join(".")).join(" ")).join("; ") || null;
	const run = (operation, inputs) => runExperiment({ root, adapter: "klayout", operation, environment: "eda", inputs, purpose: "layout-long-job reference" });
	const d = await run("drc", { gds: spec.gds, cell: spec.cell });
	const dv = values(d.result);
	let rules = null;
	try {
		const table = JSON.parse(readFileSync(join(root, "simra/experiments", d.id, "work/drc.json"), "utf8"));
		rules = Object.fromEntries(table.rules.map((r) => [r.rule, r.count]));
	} catch {}
	const l = await run("lvs", { gds: spec.gds, cell: spec.cell, netlist: spec.netlist, pins: spec.pins });
	const lv = values(l.result);
	const lvsStatus = l.result.status !== "completed" ? "not_run" : lv.match === 1 ? "match" : "mismatch";
	return {
		drc: { status: d.result.status !== "completed" ? "not_run" : dv.markers === 0 ? "clean" : "violations", markers: dv.markers ?? null, rules, runtime_s: dv.runtime_s ?? null, command: cmd(d.result) },
		lvs: { status: lvsStatus, match: lv.match ?? null, runtime_s: lv.runtime_s ?? null, command: cmd(l.result) },
	};
}

/** The problems of the adapter results against the wrapper results of the same block (empty: they agree). */
export function checkAdapter(adapter, wrapper) {
	const p = [];
	if (adapter.drc.markers !== wrapper.drc.markers) p.push(`adapter drc: ${adapter.drc.markers} markers, the wrapper ${wrapper.drc.markers}`);
	if (JSON.stringify(Object.entries(adapter.drc.rules ?? {}).sort()) !== JSON.stringify(Object.entries(wrapper.drc.rules).sort()))
		p.push(`adapter drc: rules ${JSON.stringify(adapter.drc.rules)}, the wrapper ${JSON.stringify(wrapper.drc.rules)}`);
	if (adapter.drc.status !== wrapper.drc.status) p.push(`adapter drc: ${adapter.drc.status}, the wrapper ${wrapper.drc.status}`);
	if (adapter.lvs.status !== wrapper.lvs.status) p.push(`adapter lvs: ${adapter.lvs.status}, the wrapper ${wrapper.lvs.status}`);
	return p;
}

/** Make <pdk>/flat-seeded.gds in the container (--gds). Returns its SHA-256. */
export async function makeGds(pdk, local) {
	const taskDir = join(here, pdk);
	const { task } = loadTask(taskDir);
	const work = mkdtempSync(join(realpathSync(tmpdir()), `simra-layout-long-job-gds-${pdk}-`));
	try {
		copyFileSync(resolve(taskDir, task.files["simra.config.json"]), join(work, "simra.config.json"));
		if (local) writeFileSync(join(work, "simra.local.json"), JSON.stringify(local));
		else
			try {
				copyFileSync(resolve(taskDir, task.files["simra.local.json"] ?? "-"), join(work, "simra.local.json"));
			} catch {}
		const env = taskEnvironment(work, task);
		const script = `python3 ${join(taskDir, "generate.py")} --variant seeded --out ${join(work, GENERATED)} | tail -1`;
		const r = await runContainer({ ...env, env: { ...env.env, PYTHONDONTWRITEBYTECODE: "1" } }, work, script, { [evals]: evals });
		if (r.code !== 0) throw new Error(`${pdk}: the generator failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-5).join("\n")}`);
		copyFileSync(join(work, GENERATED), join(taskDir, GENERATED));
		return sha256(join(taskDir, GENERATED));
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function main() {
	const args = process.argv.slice(2);
	const pdks = args.filter((a) => PDKS.includes(a));
	if (args.includes("--gds")) {
		for (const pdk of pdks) {
			const { task } = loadTask(join(here, pdk));
			const hash = await makeGds(pdk);
			const want = task.generated?.[GENERATED]?.sha256;
			console.log(`${pdk}: ${join(pdk, GENERATED)} ${hash}`);
			if (hash !== want) throw new Error(`${pdk}: ${GENERATED} has SHA-256 ${hash}, task.json gives ${want}`);
		}
		return;
	}
	const write = args.includes("--write");
	// --loaded: write expected.json also if the host was not idle, with the runtimes marked as measured under load.
	const loaded = args.includes("--loaded");
	const base = realpathSync(tmpdir());
	for (const pdk of pdks.length ? pdks : PDKS) {
		const work = mkdtempSync(join(base, `simra-layout-long-job-reference-${pdk}-`));
		try {
			const started = new Date();
			const loadStart = load1();
			const taskDir = join(here, pdk);
			const ref = await reference(pdk, work, undefined, { tasks: here, broken: false });
			const { variants, info } = ref;
			const { task, spec } = loadTask(taskDir);
			const problems = checkRoles(pdk, ref, spec.pins);
			const adapter = await adapterRun(designRoot(taskDir, work, "adapter", variants.seeded.gds, join(work, "block.spice")), spec);
			problems.push(...checkAdapter(adapter, variants.seeded));
			const loadEnd = load1();
			console.log(`${pdk}: ${info.devices} devices, ${info.levels} level, boundary ${info.size_um.join(" x ")} um; host load ${loadStart} to ${loadEnd}`);
			for (const [v, r] of Object.entries(variants)) {
				const rules = Object.entries(r.drc.rules).map(([k, n]) => `${k} ${n}`).join(", ");
				console.log(`${pdk} ${v}: ${r.sha256.slice(0, 12)} ${r.cells} cells ${r.bytes} bytes, DRC ${r.drc.status} ${r.drc.markers}${rules ? ` (${rules})` : ""} ${r.drc.runtime_s} s, LVS ${r.lvs.status} ${r.lvs.runtime_s} s`);
			}
			console.log(`${pdk} adapter (seeded): DRC ${adapter.drc.status} ${adapter.drc.markers} ${adapter.drc.runtime_s} s, LVS ${adapter.lvs.status} ${adapter.lvs.runtime_s} s`);
			if (problems.length) throw new Error(`${pdk}: the roles do not hold:\n${problems.join("\n")}`);
			if (!write) continue;
			const idle = Math.max(loadStart, loadEnd) < IDLE_LOAD;
			if (!idle && !loaded) throw new Error(`${pdk}: the host load was ${loadStart} to ${loadEnd} (not under ${IDLE_LOAD}): the runtimes are not valid, expected.json not written (--loaded writes it with the runtimes marked)`);
			const wrapper = (f) => deckCommand(readFileSync(resolve(taskDir, task.files[f]), "utf8"));
			const runtimes = runtimeRecord(VARIANTS.map((v) => ({ drc: variants[v].drc.runtime_s, lvs: variants[v].lvs.runtime_s })));
			const peak = Math.max(loadStart, loadEnd);
			const measured = idle ? `measured on an idle host (load average ${peak})` : `measured under load (load average ${peak})`;
			const expected = {
				task: "layout-long-job",
				input: "seeded",
				pdk,
				cell: spec.cell,
				pins: spec.pins,
				block: { devices: info.devices, scale: info.scale, cells: Object.fromEntries(VARIANTS.map((v) => [v, variants[v].cells])), levels: info.levels, size_um: info.size_um },
				seeds: seedList(pdk, info, variants.seeded.drc.rules),
				variants: Object.fromEntries(Object.entries(variants).map(([v, { gds: _g, ...r }]) => [v, r])),
				decks: { drc: wrapper("drc.sh"), lvs: wrapper("lvs.sh") },
				runtime_target_s: RUNTIME_TARGET_S,
				runtimes: { ...runtimes, measured },
				adapter: { input: "seeded", ...adapter, measured },
				host_load_1min: { start: loadStart, end: loadEnd, idle_below: IDLE_LOAD, idle },
				provenance: { ...ref.provenance, made_at: started.toISOString() },
			};
			copyFileSync(variants.seeded.gds, join(taskDir, GENERATED));
			writeFileSync(join(taskDir, "block.spice"), ref.spice);
			writeFileSync(join(taskDir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
			task.generated = { [GENERATED]: { sha256: variants.seeded.sha256, command: `node evals/layout-long-job/reference.mjs ${pdk} --gds` } };
			writeFileSync(join(taskDir, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
			console.log(`${pdk}: wrote ${GENERATED}, block.spice, expected.json and the hash in task.json`);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
