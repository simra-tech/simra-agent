// The reference results of the layout block tasks (layout-block-fix and layout-false-pass), for one PDK or both.
//
// 1. Make the three variants of the block with <pdk>/generate.py in the container of the task: clean, seeded and
//    cheat (the seeded block without the seeded shapes). Make the reference netlist and read the facts of the block
//    (generate.py --info). Count the cells of each GDS.
// 2. Verify each variant with the wrappers drc.sh and lvs.sh of layout-block-fix (verify() of layout.mjs).
// 3. Run the LVS wrapper of layout-false-pass on the clean block, and record what it prints, its exit code and the
//    size of the LVS database that it leaves.
// 4. Check the roles: clean has 0 markers and matches; seeded has exactly the seeded rules (8 to 12 rules, 30 to 100
//    markers) and matches; cheat has 0 markers and does not match; the broken wrapper prints a match and exits with
//    a code other than 0. Stop if a role does not hold.
// 5. With --write: write <pdk>/block-clean.gds, <pdk>/block-seeded.gds and <pdk>/block.spice, and expected.json of
//    layout-block-fix/<pdk> (input: seeded) and of layout-false-pass/<pdk> (input: clean).
//
// Usage: node evals/layout-block-fix/reference.mjs [sg13g2|sky130 ...] [--write]
// The environment is the one of the task (simra.config.json, and examples/ota-sg13g2/simra.local.json for the
// local image).

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTask, runContainer, sha256, taskEnvironment, verify } from "../layout-drc-fix/layout.mjs";
import { deckCommand } from "../layout-drc-fix/reference.mjs";

const here = new URL(".", import.meta.url).pathname;
const evals = resolve(here, "..");
const falsePass = join(evals, "layout-false-pass");
export const PDKS = ["sg13g2", "sky130"];
export const VARIANTS = ["clean", "seeded", "cheat"];

/** The rules that each seed of block.py violates, per PDK. */
export const SEED_RULES = {
	sg13g2: {
		unit_via1: ["V1.c", "V1.c1"],
		unit_m1_spur: ["M1.b"],
		pair_rail_neck: ["M1.a"],
		top_nbias_neck: ["M2.a"],
		top_vss_comb: ["M2.b"],
		top_nbias_offgrid: ["metal2_drw_Offgrid"],
		top_jumper_via: ["M3.c"],
		top_dangling_pads: ["M3.d"],
		top_pin_neck: ["M3.a"],
		top_pin_comb: ["M3.b"],
	},
	sky130: {
		unit_via1: ["via.4a"],
		unit_m1_spur: ["m1.2"],
		pair_rail_neck: ["m1.1"],
		top_nbias_neck: ["m2.1"],
		top_vss_comb: ["m2.2"],
		top_nbias_offgrid: ["m2_OFFGRID"],
		top_jumper_via: ["m3.4"],
		top_dangling_pads: ["m3.6"],
		top_pin_neck: ["m3.1"],
		top_pin_comb: ["m3.2"],
	},
};

/** The limits of the seeded variant: the count of distinct rules and the total marker count. */
export const SEED_LIMITS = { rules: [8, 12], markers: [30, 100] };

/** The commands that print the version of the PDK in the container. */
const PDK_VERSION = {
	sg13g2: 'echo "ihp-sg13g2 $(cat "$PDK_ROOT/ihp-sg13g2/COMMIT")"',
	sky130: 'echo "sky130A $(cat "$PDK_ROOT/sky130A/SOURCES")"',
};

/** The Python script that prints "cells <file> <count>" for each GDS file of its arguments. */
const CELLS = `import sys, klayout.db as db
for f in sys.argv[1:]:
    ly = db.Layout(); ly.read(f); print("cells", f, ly.cells())`;

/** The device count of a subcircuit of a hierarchical SPICE netlist (M lines, and X lines of the subcircuits). */
export function deviceCount(text, name) {
	const subckts = {};
	let cur = null;
	for (const line of text.replace(/\r/g, "").replace(/\n\+/g, " ").split("\n")) {
		const w = line.trim().split(/\s+/);
		if (/^\.subckt$/i.test(w[0])) subckts[(cur = w[1])] = [];
		else if (/^\.ends$/i.test(w[0])) cur = null;
		else if (cur && /^[mx]/i.test(w[0])) subckts[cur].push(/^m/i.test(w[0]) ? null : w.filter((x) => !x.includes("=")).at(-1));
	}
	const count = (n) => (subckts[n] ?? []).reduce((a, c) => a + (c === null ? 1 : count(c)), 0);
	return count(name);
}

/**
 * Make and verify the three variants of one PDK in work (an empty directory), and run the broken LVS wrapper of
 * layout-false-pass on the clean variant. local: a simra.local.json object that replaces the one of the task
 * (tests). tasks: the directory of the task with <pdk>/generate.py and <pdk>/task.json (default: this one).
 * broken: false to not run the broken wrapper (broken_lvs is then null). Returns { variants, info, spice,
 * broken_lvs, provenance }.
 */
export async function reference(pdk, work, local, { tasks = here, broken = true } = {}) {
	const taskDir = join(tasks, pdk);
	const { task, spec } = loadTask(taskDir);
	mkdirSync(work, { recursive: true });
	for (const f of ["simra.config.json", "simra.local.json"]) {
		const from = resolve(taskDir, task.files[f]);
		if (existsSync(from)) copyFileSync(from, join(work, f));
	}
	if (local) writeFileSync(join(work, "simra.local.json"), JSON.stringify(local));
	const env = taskEnvironment(work, task);
	const g = `python3 ${join(taskDir, "generate.py")}`;
	const gen = VARIANTS.map((v) => `${g} --variant ${v} --out ${join(work, `${v}.gds`)} | tail -1`);
	const script = [
		...gen,
		`${g} --spice --out ${join(work, "block.spice")}`,
		`${g} --info | tail -1`,
		`python3 -c '${CELLS}' ${VARIANTS.map((v) => join(work, `${v}.gds`)).join(" ")}`,
		`/foss/tools/klayout/klayout -v; ${PDK_VERSION[pdk]}`,
	].join(" && ");
	const r = await runContainer({ ...env, env: { ...env.env, PYTHONDONTWRITEBYTECODE: "1" } }, work, script, { [evals]: evals });
	if (r.code !== 0) throw new Error(`${pdk}: the generator failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-5).join("\n")}`);
	const out = r.stdout.trim().split("\n");
	const printed = out.filter((l) => l.startsWith("sha256 ")).map((l) => l.slice(7));
	const info = JSON.parse(out.find((l) => l.startsWith("{")));
	const cells = Object.fromEntries(out.filter((l) => l.startsWith("cells ")).map((l) => l.split(" ")).map(([, f, n]) => [f, Number(n)]));
	const klayout = out.find((l) => l.startsWith("KLayout ")) ?? null;
	const pdkVersion = out.at(-1);
	const spice = readFileSync(join(work, "block.spice"), "utf8");
	const variants = {};
	for (const [i, v] of VARIANTS.entries()) {
		const gds = join(work, `${v}.gds`);
		const hash = sha256(gds);
		if (printed[i] !== hash) throw new Error(`${pdk} ${v}: the generator printed ${printed[i]}, the file has ${hash}`);
		const res = await verify(taskDir, gds, join(work, `verify-${v}`), local, { [spec.netlist]: join(work, "block.spice") });
		if (res.errors.length) throw new Error(`${pdk} ${v}: ${res.errors.join("; ")}`);
		const { report: _d, reason: _dr, ...drc } = res.drc;
		const { report: _l, reason: _lr, ...lvs } = res.lvs;
		variants[v] = { sha256: hash, bytes: statSync(gds).size, cells: cells[gds], gds, drc, lvs };
	}
	return { variants, info: { ...info, devices_netlist: deviceCount(spice, info.cell) }, spice, broken_lvs: broken ? await brokenLvs(pdk, variants.clean.gds, join(work, "broken"), local, join(work, "block.spice")) : null, provenance: { engine: env.engine ?? "podman", image: env.image, image_id: r.imageId, klayout, pdk: pdkVersion } };
}

/**
 * Run the LVS wrapper of layout-false-pass/<pdk> on gds, with the reference netlist netlist, in its own directory: { exit, printed, lvsdb_bytes,
 * lvsdb_bytes_real }. printed: what the wrapper printed (stdout and stderr). lvsdb_bytes: the size of the LVS
 * database after the wrapper (null: no database); lvsdb_bytes_real: the size after the real wrapper.
 */
export async function brokenLvs(pdk, gds, root, local, netlist) {
	const fp = join(falsePass, pdk);
	const { task, spec } = loadTask(fp);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	for (const f of ["simra.config.json", "simra.local.json", "lvs.sh"]) {
		const from = resolve(fp, task.files[f]);
		if (existsSync(from)) copyFileSync(from, join(root, f));
	}
	copyFileSync(netlist, join(root, spec.netlist));
	copyFileSync(resolve(fp, task.verify["lvs.sh"]), join(root, "lvs-real.sh"));
	if (local) writeFileSync(join(root, "simra.local.json"), JSON.stringify(local));
	copyFileSync(gds, join(root, spec.gds));
	const env = taskEnvironment(root, task);
	const db = `lvs/${pdk === "sg13g2" ? "block" : spec.cell}.lvsdb`;
	const size = `if [ -f ${db} ]; then wc -c < ${db}; else echo none; fi`;
	const script = `./lvs-real.sh ${spec.gds} ${spec.cell} > real.out 2>&1; ${size} > real.size; ./lvs.sh ${spec.gds} ${spec.cell} > broken.out 2>&1; echo $? > broken.code; ${size} > broken.size`;
	const r = await runContainer(env, root, script);
	if (r.code !== 0) throw new Error(`${pdk}: the broken wrapper run failed (exit ${r.code}): ${r.stderr.trim()}`);
	const read = (f) => readFileSync(join(root, f), "utf8").trim();
	const bytes = (f) => (read(f) === "none" ? null : Number(read(f)));
	return { exit: Number(read("broken.code")), printed: read("broken.out"), lvsdb_bytes: bytes("broken.size"), lvsdb_bytes_real: bytes("real.size") };
}

/** Check the roles (step 4; without the broken wrapper if broken_lvs is null). Returns the list of problems (empty: the roles hold). */
export function checkRoles(pdk, { variants, info, broken_lvs }, pins) {
	const p = [];
	const { clean, seeded, cheat } = variants;
	const pinsOk = (v) => Array.isArray(v.lvs.pins) && v.lvs.pins.length === pins.length && pins.every((x) => v.lvs.pins.includes(x));
	if (clean.drc.status !== "clean") p.push(`clean: DRC ${clean.drc.status} ${JSON.stringify(clean.drc.rules)}`);
	if (clean.lvs.status !== "match" || !pinsOk(clean)) p.push(`clean: LVS ${clean.lvs.status}, pins ${clean.lvs.pins}`);
	const rules = Object.keys(seeded.drc.rules).sort();
	const want = Object.values(SEED_RULES[pdk]).flat().sort();
	if (JSON.stringify(rules) !== JSON.stringify(want)) p.push(`seeded: rules ${rules.join(" ")}, expected ${want.join(" ")}`);
	if (rules.length < SEED_LIMITS.rules[0] || rules.length > SEED_LIMITS.rules[1]) p.push(`seeded: ${rules.length} rules`);
	if (!(seeded.drc.markers >= SEED_LIMITS.markers[0] && seeded.drc.markers <= SEED_LIMITS.markers[1])) p.push(`seeded: ${seeded.drc.markers} markers`);
	if (seeded.lvs.status !== "match" || !pinsOk(seeded)) p.push(`seeded: LVS ${seeded.lvs.status}, pins ${seeded.lvs.pins}`);
	if (cheat.drc.status !== "clean") p.push(`cheat: DRC ${cheat.drc.status} ${JSON.stringify(cheat.drc.rules)}`);
	if (cheat.lvs.status !== "mismatch") p.push(`cheat: LVS ${cheat.lvs.status}`);
	if (info.devices !== info.devices_netlist) p.push(`devices: generator ${info.devices}, netlist ${info.devices_netlist}`);
	if (!broken_lvs) return p;
	if (!/^LVS status: MATCH$/m.test(broken_lvs.printed)) p.push("broken LVS wrapper: no printed match");
	if (broken_lvs.exit === 0) p.push("broken LVS wrapper: exit code 0");
	if (broken_lvs.lvsdb_bytes !== null && !(broken_lvs.lvsdb_bytes < broken_lvs.lvsdb_bytes_real)) p.push("broken LVS wrapper: the LVS database is not truncated");
	return p;
}

/** The seeds of expected.json: for each seed, the cell, the kind, the sites, and the marker count of each rule. */
export function seedList(pdk, info, rules) {
	return Object.entries(info.seeds).map(([seed, s]) => ({ seed, ...s, rules: Object.fromEntries(SEED_RULES[pdk][seed].map((r) => [r, rules[r] ?? 0])) }));
}

async function main() {
	const args = process.argv.slice(2);
	const pdks = args.filter((a) => PDKS.includes(a));
	const write = args.includes("--write");
	const base = realpathSync(tmpdir());
	for (const pdk of pdks.length ? pdks : PDKS) {
		const work = mkdtempSync(join(base, `simra-layout-block-reference-${pdk}-`));
		try {
			const started = new Date();
			const ref = await reference(pdk, work);
			const { variants, info, broken_lvs } = ref;
			const taskDir = join(here, pdk);
			const { spec } = loadTask(taskDir);
			const problems = checkRoles(pdk, ref, spec.pins);
			console.log(`${pdk}: ${info.devices} devices, ${info.levels} levels, boundary ${info.size_um.join(" x ")} um`);
			for (const [v, r] of Object.entries(variants)) {
				const rules = Object.entries(r.drc.rules).map(([k, n]) => `${k} ${n}`).join(", ");
				console.log(`${pdk} ${v}: ${r.sha256.slice(0, 12)} ${r.cells} cells ${r.bytes} bytes, DRC ${r.drc.status} ${r.drc.markers}${rules ? ` (${rules})` : ""} ${r.drc.runtime_s} s, LVS ${r.lvs.status} ${r.lvs.runtime_s} s`);
			}
			console.log(`${pdk} broken LVS wrapper: exit ${broken_lvs.exit}, LVS database ${broken_lvs.lvsdb_bytes} of ${broken_lvs.lvsdb_bytes_real} bytes`);
			if (problems.length) throw new Error(`${pdk}: the roles do not hold:\n${problems.join("\n")}`);
			if (!write) continue;
			const wrapper = (dir, f) => deckCommand(readFileSync(resolve(dir, loadTask(dir).task.files[f]), "utf8"));
			const common = {
				pdk,
				cell: spec.cell,
				pins: spec.pins,
				block: { devices: info.devices, cells: Object.fromEntries(VARIANTS.map((v) => [v, variants[v].cells])), levels: info.levels, size_um: info.size_um },
				seeds: seedList(pdk, info, variants.seeded.drc.rules),
				variants: Object.fromEntries(Object.entries(variants).map(([v, { gds: _g, ...r }]) => [v, r])),
				decks: { drc: wrapper(taskDir, "drc.sh"), lvs: wrapper(taskDir, "lvs.sh") },
				runtime_target_s: { drc: 120, lvs: 60 },
				provenance: { ...ref.provenance, made_at: started.toISOString() },
			};
			copyFileSync(variants.clean.gds, join(taskDir, "block-clean.gds"));
			copyFileSync(variants.seeded.gds, join(taskDir, "block-seeded.gds"));
			writeFileSync(join(taskDir, "block.spice"), ref.spice);
			const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
			writeFileSync(join(taskDir, "expected.json"), json({ task: "layout-block-fix", input: "seeded", ...common }));
			writeFileSync(join(falsePass, pdk, "expected.json"), json({ task: "layout-false-pass", input: "clean", ...common, broken_lvs }));
			console.log(`${pdk}: wrote block-clean.gds, block-seeded.gds, block.spice and expected.json of layout-block-fix and layout-false-pass`);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
