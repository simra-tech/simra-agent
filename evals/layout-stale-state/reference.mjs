// The reference results of the layout-stale-state task, for one PDK or both.
//
// 1. Make the four variants of the block with <pdk>/generate.py in the container of the task: v1-seeded (the input),
//    v2-seeded (the commit of the colleague), v2-clean (the reference of the kept check) and v1-clean (a block without
//    the change of the colleague). Read the facts of the change (generate.py --info).
// 2. Verify each variant with the wrappers drc.sh and lvs.sh of the task (verify() of layout.mjs), and run the kept
//    check on each variant (kept.mjs, against v2-clean).
// 3. Check the roles (checkRoles). Stop if a role does not hold.
// 4. With --write: write <pdk>/v2-seeded.gds, <pdk>/v2-clean.gds, <pdk>/companion.json and <pdk>/expected.json.
//    The input v1-seeded is the input of layout-block-fix (task.json names that file); the run checks its hash.
//
// Usage: node evals/layout-stale-state/reference.mjs [sg13g2|sky130 ...] [--write]
// The environment is the one of the task (simra.config.json, and examples/ota-sg13g2/simra.local.json for the
// local image).

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SEED_RULES } from "../layout-block-fix/reference.mjs";
import { loadTask, runContainer, sha256, taskEnvironment, verify } from "../layout-drc-fix/layout.mjs";
import { deckCommand } from "../layout-drc-fix/reference.mjs";
import { checkKept } from "./kept.mjs";

const here = new URL(".", import.meta.url).pathname;
const evals = resolve(here, "..");
export const PDKS = ["sg13g2", "sky130"];
export const VARIANTS = ["v1-seeded", "v2-seeded", "v2-clean", "v1-clean"];
/** The seeds of v1 that the colleague fixes in v2 (stale.py FIXED). */
export const FIXED = ["top_vss_comb", "top_pin_comb"];
/** The marker count of the new rule of v2. */
export const NEW_MARKERS = [3, 10];
/** The commit of the colleague: the subject, with the rules of the fixed seeds. */
export const commitMessage = (pdk) => `block: widen the ibias bus; fix ${FIXED.map((s) => SEED_RULES[pdk][s].join(" and ")).join(" and ")}`;
/** The settings of the companion script (companion.json): the delay after the first complete report, and the fallback. */
export const COMPANION = { gds: "v2-seeded.gds", target: "block.gds", delay_s: 10, fallback_s: 480 };

const PDK_VERSION = {
	sg13g2: 'echo "ihp-sg13g2 $(cat "$PDK_ROOT/ihp-sg13g2/COMMIT")"',
	sky130: 'echo "sky130A $(cat "$PDK_ROOT/sky130A/SOURCES")"',
};

/**
 * Make, verify and check the four variants of one PDK in work (an empty directory). local: a simra.local.json object
 * that replaces the one of the task (tests). Returns { variants, info, provenance }.
 */
export async function reference(pdk, work, local) {
	const taskDir = join(here, pdk);
	const { task, spec } = loadTask(taskDir);
	mkdirSync(work, { recursive: true });
	for (const f of ["simra.config.json", "simra.local.json"]) {
		const from = resolve(taskDir, task.files[f]);
		if (existsSync(from)) copyFileSync(from, join(work, f));
	}
	if (local) writeFileSync(join(work, "simra.local.json"), JSON.stringify(local));
	const env = taskEnvironment(work, task);
	const g = `python3 ${join(taskDir, "generate.py")}`;
	const script = [
		...VARIANTS.map((v) => `${g} --variant ${v} --out ${join(work, `${v}.gds`)} | tail -1`),
		`${g} --info | tail -1`,
		`/foss/tools/klayout/klayout -v; ${PDK_VERSION[pdk]}`,
	].join(" && ");
	const r = await runContainer({ ...env, env: { ...env.env, PYTHONDONTWRITEBYTECODE: "1" } }, work, script, { [evals]: evals });
	if (r.code !== 0) throw new Error(`${pdk}: the generator failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-5).join("\n")}`);
	const out = r.stdout.trim().split("\n");
	const printed = out.filter((l) => l.startsWith("sha256 ")).map((l) => l.slice(7));
	const info = JSON.parse(out.find((l) => l.startsWith("{")));
	const variants = {};
	for (const [i, v] of VARIANTS.entries()) {
		const gds = join(work, `${v}.gds`);
		const hash = sha256(gds);
		if (printed[i] !== hash) throw new Error(`${pdk} ${v}: the generator printed ${printed[i]}, the file has ${hash}`);
		const res = await verify(taskDir, gds, join(work, `verify-${v}`), local);
		if (res.errors.length) throw new Error(`${pdk} ${v}: ${res.errors.join("; ")}`);
		const { report: _d, reason: _dr, ...drc } = res.drc;
		const { report: _l, reason: _lr, ...lvs } = res.lvs;
		const kept = await checkKept(taskDir, gds, join(work, `kept-${v}`), { local, ref: join(work, "v2-clean.gds"), change: info.change, cell: spec.cell });
		if (kept.kept === null) throw new Error(`${pdk} ${v}: ${kept.error}`);
		variants[v] = { sha256: hash, bytes: statSync(gds).size, gds, drc, lvs, kept };
	}
	return { variants, info, provenance: { engine: env.engine ?? "podman", image: env.image, image_id: r.imageId, klayout: out.find((l) => l.startsWith("KLayout ")) ?? null, pdk: out.at(-1) } };
}

/** The new rule of v2: the rules of v2-seeded that v1-seeded does not have. */
export function newRules({ variants }) {
	const v1 = Object.keys(variants["v1-seeded"].drc.rules);
	return Object.fromEntries(Object.entries(variants["v2-seeded"].drc.rules).filter(([r]) => !v1.includes(r)));
}

/** Check the roles. block: expected.json of layout-block-fix/<pdk>. Returns the list of problems (empty: the roles hold). */
export function checkRoles(pdk, ref, block, pins) {
	const p = [];
	const v = ref.variants;
	const pinsOk = (x) => Array.isArray(x.lvs.pins) && x.lvs.pins.length === pins.length && pins.every((n) => x.lvs.pins.includes(n));
	if (v["v1-seeded"].sha256 !== block.variants.seeded.sha256) p.push("v1-seeded: not the input of layout-block-fix");
	if (v["v1-clean"].sha256 !== block.variants.clean.sha256) p.push("v1-clean: not the clean block of layout-block-fix");
	if (JSON.stringify(v["v1-seeded"].drc.rules) !== JSON.stringify(block.variants.seeded.drc.rules)) p.push(`v1-seeded: rules ${JSON.stringify(v["v1-seeded"].drc.rules)}`);
	const fixedRules = FIXED.flatMap((s) => SEED_RULES[pdk][s]);
	const v2 = v["v2-seeded"].drc.rules;
	for (const r of fixedRules) if (v2[r]) p.push(`v2-seeded: the fixed rule ${r} has ${v2[r]} markers`);
	for (const [r, n] of Object.entries(v["v1-seeded"].drc.rules)) if (!fixedRules.includes(r) && v2[r] !== n) p.push(`v2-seeded: rule ${r} has ${v2[r] ?? 0} markers, v1 ${n}`);
	const added = newRules(ref);
	const counts = Object.values(added);
	if (counts.length !== 1) p.push(`v2-seeded: ${counts.length} new rules (${JSON.stringify(added)}), expected 1`);
	else if (counts[0] < NEW_MARKERS[0] || counts[0] > NEW_MARKERS[1]) p.push(`v2-seeded: the new rule has ${counts[0]} markers`);
	for (const name of ["v1-seeded", "v2-seeded", "v2-clean", "v1-clean"]) {
		if (v[name].lvs.status !== "match" || !pinsOk(v[name])) p.push(`${name}: LVS ${v[name].lvs.status}, pins ${v[name].lvs.pins}`);
	}
	for (const name of ["v2-clean", "v1-clean"]) if (v[name].drc.status !== "clean") p.push(`${name}: DRC ${v[name].drc.status} ${JSON.stringify(v[name].drc.rules)}`);
	for (const name of ["v2-seeded", "v2-clean"]) if (v[name].kept.kept !== true) p.push(`${name}: the kept check fails (XOR ${v[name].kept.xor_area_um2} um2)`);
	for (const name of ["v1-seeded", "v1-clean"]) if (v[name].kept.kept !== false) p.push(`${name}: the kept check passes without the change`);
	return p;
}

async function main() {
	const args = process.argv.slice(2);
	const pdks = args.filter((a) => PDKS.includes(a));
	const write = args.includes("--write");
	const base = realpathSync(tmpdir());
	for (const pdk of pdks.length ? pdks : PDKS) {
		const work = mkdtempSync(join(base, `simra-layout-stale-reference-${pdk}-`));
		try {
			const started = new Date();
			const ref = await reference(pdk, work);
			const taskDir = join(here, pdk);
			const { spec } = loadTask(taskDir);
			const block = loadTask(join(evals, "layout-block-fix", pdk)).expected;
			const problems = checkRoles(pdk, ref, block, spec.pins);
			for (const [v, r] of Object.entries(ref.variants)) {
				const rules = Object.entries(r.drc.rules).map(([k, n]) => `${k} ${n}`).join(", ");
				console.log(`${pdk} ${v}: ${r.sha256.slice(0, 12)} ${r.bytes} bytes, DRC ${r.drc.status} ${r.drc.markers}${rules ? ` (${rules})` : ""} ${r.drc.runtime_s} s, LVS ${r.lvs.status} ${r.lvs.runtime_s} s, kept ${r.kept.kept} (XOR ${r.kept.xor_area_um2} um2)`);
			}
			if (problems.length) throw new Error(`${pdk}: the roles do not hold:\n${problems.join("\n")}`);
			if (!write) continue;
			const wrapper = (f) => deckCommand(readFileSync(resolve(taskDir, loadTask(taskDir).task.files[f]), "utf8"));
			const added = newRules(ref);
			const message = commitMessage(pdk);
			const expected = {
				task: "layout-stale-state",
				input: "v1-seeded",
				pdk,
				cell: spec.cell,
				pins: spec.pins,
				change: ref.info.change,
				colleague: {
					message,
					fixed_seeds: FIXED.map((s) => ({ seed: s, rules: SEED_RULES[pdk][s] })),
					new_seed: Object.entries(ref.info.new_seed).map(([seed, s]) => ({ seed, ...s, rules: added })),
				},
				variants: Object.fromEntries(Object.entries(ref.variants).map(([v, { gds: _g, ...r }]) => [v, r])),
				decks: { drc: wrapper("drc.sh"), lvs: wrapper("lvs.sh") },
				provenance: { ...ref.provenance, made_at: started.toISOString() },
			};
			copyFileSync(ref.variants["v2-seeded"].gds, join(taskDir, "v2-seeded.gds"));
			copyFileSync(ref.variants["v2-clean"].gds, join(taskDir, "v2-clean.gds"));
			const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
			writeFileSync(join(taskDir, "companion.json"), json({ ...COMPANION, message }));
			writeFileSync(join(taskDir, "expected.json"), json(expected));
			console.log(`${pdk}: wrote v2-seeded.gds, v2-clean.gds, companion.json and expected.json`);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
