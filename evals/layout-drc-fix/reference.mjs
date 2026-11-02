// The reference results of the layout tasks, for one PDK or both.
//
// 1. Make the three variants of the cell with <pdk>/generate.py in the container of the task: clean, seeded and
//    cheat (the seeded cell without the seeded shapes).
// 2. Verify each variant with the wrappers drc.sh and lvs.sh of the task (verify() of layout.mjs).
// 3. Check the roles: clean has 0 markers and matches; seeded has exactly the seeded rules (at least 3 distinct
//    rules) and matches; cheat has 0 markers and does not match. Stop if a role does not hold.
// 4. With --write: copy the clean and the seeded GDS to <pdk>/cell-clean.gds and <pdk>/cell-seeded.gds, and write
//    expected.json of layout-drc-fix/<pdk> (input: seeded) and of layout-clean/<pdk> (input: clean).
//
// Usage: node evals/layout-drc-fix/reference.mjs [sg13g2|sky130 ...] [--write]
// The environment is the one of the task (simra.config.json, and examples/ota-sg13g2/simra.local.json for the
// local image).

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTask, runContainer, sha256, taskEnvironment, verify } from "./layout.mjs";

const here = new URL(".", import.meta.url).pathname;
export const PDKS = ["sg13g2", "sky130"];
export const VARIANTS = ["clean", "seeded", "cheat"];

/** The rule that each seed of cell.py violates, per PDK. */
export const SEED_RULES = {
	sg13g2: { width: "M1.a", spacing: "M2.b", enclosure: "V1.c", offgrid: "metal1_drw_Offgrid" },
	sky130: { width: "m1.1", spacing: "m2.2", enclosure: "via.4a", offgrid: "m1_OFFGRID" },
};

/** The commands that print the version of the PDK in the container. */
const PDK_VERSION = {
	sg13g2: 'echo "ihp-sg13g2 $(cat "$PDK_ROOT/ihp-sg13g2/COMMIT")"',
	sky130: 'echo "sky130A $(cat "$PDK_ROOT/sky130A/SOURCES")"',
};

/** The deck command lines of a wrapper: the line that calls the deck, with its continuation lines. */
export function deckCommand(wrapper) {
	const lines = wrapper.split("\n");
	const i = lines.findIndex((l) => /^(python3 "\$deck"|klayout -b -r "\$deck")/.test(l));
	if (i < 0) return null;
	let j = i;
	while (lines[j].endsWith("\\")) j++;
	return lines
		.slice(i, j + 1)
		.map((l) => l.replace(/\\$/, "").trim())
		.join(" ");
}

/**
 * Make and verify the three variants of one PDK in work (an empty directory). local: a simra.local.json object that
 * replaces the one of the task (tests). Returns { variants: { <variant>: { sha256, gds, drc, lvs } }, provenance }.
 */
export async function reference(pdk, work, local) {
	const taskDir = join(here, pdk);
	const { task } = loadTask(taskDir);
	mkdirSync(work, { recursive: true });
	for (const f of ["simra.config.json", "simra.local.json"]) {
		const from = resolve(taskDir, task.files[f]);
		if (existsSync(from)) copyFileSync(from, join(work, f));
	}
	if (local) writeFileSync(join(work, "simra.local.json"), JSON.stringify(local));
	const env = taskEnvironment(work, task);
	const gen = VARIANTS.map((v) => `python3 ${join(here, pdk, "generate.py")} --variant ${v} --out ${join(work, `${v}.gds`)} | tail -1`).join(" && ");
	const versions = `/foss/tools/klayout/klayout -v; ${PDK_VERSION[pdk]}`;
	const r = await runContainer({ ...env, env: { ...env.env, PYTHONDONTWRITEBYTECODE: "1" } }, work, `${gen} && ${versions}`, { [here]: here });
	if (r.code !== 0) throw new Error(`${pdk}: the generator failed (exit ${r.code}): ${r.stderr.trim().split("\n").slice(-5).join("\n")}`);
	const out = r.stdout.trim().split("\n");
	const printed = out.filter((l) => l.startsWith("sha256 ")).map((l) => l.slice(7));
	const klayout = out.find((l) => l.startsWith("KLayout ")) ?? null;
	const pdkVersion = out.at(-1);
	const variants = {};
	for (const [i, v] of VARIANTS.entries()) {
		const gds = join(work, `${v}.gds`);
		const hash = sha256(gds);
		if (printed[i] !== hash) throw new Error(`${pdk} ${v}: the generator printed ${printed[i]}, the file has ${hash}`);
		const res = await verify(taskDir, gds, join(work, `verify-${v}`), local);
		if (res.errors.length) throw new Error(`${pdk} ${v}: ${res.errors.join("; ")}`);
		const { report: _d, reason: _dr, ...drc } = res.drc;
		const { report: _l, reason: _lr, ...lvs } = res.lvs;
		variants[v] = { sha256: hash, gds, drc, lvs };
	}
	const engine = env.engine ?? "podman";
	return { variants, provenance: { engine, image: env.image, image_id: r.imageId, klayout, pdk: pdkVersion } };
}

/** Check the roles of the three variants (step 3). Returns the list of problems (empty: the roles hold). */
export function checkRoles(pdk, variants, pins) {
	const p = [];
	const { clean, seeded, cheat } = variants;
	const pinsOk = (v) => Array.isArray(v.lvs.pins) && v.lvs.pins.length === pins.length && pins.every((x) => v.lvs.pins.includes(x));
	if (clean.drc.status !== "clean") p.push(`clean: DRC ${clean.drc.status} ${JSON.stringify(clean.drc.rules)}`);
	if (clean.lvs.status !== "match" || !pinsOk(clean)) p.push(`clean: LVS ${clean.lvs.status}, pins ${clean.lvs.pins}`);
	const rules = Object.keys(seeded.drc.rules).sort();
	const want = Object.values(SEED_RULES[pdk]).sort();
	if (JSON.stringify(rules) !== JSON.stringify(want)) p.push(`seeded: rules ${rules.join(" ")}, expected ${want.join(" ")}`);
	if (new Set(rules).size < 3) p.push("seeded: fewer than 3 distinct rules");
	if (seeded.lvs.status !== "match" || !pinsOk(seeded)) p.push(`seeded: LVS ${seeded.lvs.status}, pins ${seeded.lvs.pins}`);
	if (cheat.drc.status !== "clean") p.push(`cheat: DRC ${cheat.drc.status} ${JSON.stringify(cheat.drc.rules)}`);
	if (cheat.lvs.status !== "mismatch") p.push(`cheat: LVS ${cheat.lvs.status}`);
	return p;
}

async function main() {
	const args = process.argv.slice(2);
	const pdks = args.filter((a) => PDKS.includes(a));
	const write = args.includes("--write");
	const base = realpathSync(tmpdir());
	for (const pdk of pdks.length ? pdks : PDKS) {
		const work = mkdtempSync(join(base, `simra-layout-reference-${pdk}-`));
		try {
			const started = new Date();
			const { variants, provenance } = await reference(pdk, work);
			const taskDir = join(here, pdk);
			const { spec } = loadTask(taskDir);
			const problems = checkRoles(pdk, variants, spec.pins);
			for (const [v, r] of Object.entries(variants)) {
				const rules = Object.entries(r.drc.rules).map(([k, n]) => `${k} ${n}`).join(", ");
				console.log(`${pdk} ${v}: ${r.sha256.slice(0, 12)} DRC ${r.drc.status} ${r.drc.markers}${rules ? ` (${rules})` : ""} ${r.drc.runtime_s} s, LVS ${r.lvs.status} ${r.lvs.runtime_s} s`);
			}
			if (problems.length) throw new Error(`${pdk}: the roles do not hold:\n${problems.join("\n")}`);
			if (!write) continue;
			const wrapper = (f) => deckCommand(readFileSync(join(taskDir, f), "utf8"));
			const common = {
				pdk,
				cell: spec.cell,
				pins: spec.pins,
				seeds: SEED_RULES[pdk],
				variants: Object.fromEntries(Object.entries(variants).map(([v, { gds: _g, ...r }]) => [v, r])),
				decks: { drc: wrapper("drc.sh"), lvs: wrapper("lvs.sh") },
				provenance: { ...provenance, made_at: started.toISOString() },
			};
			copyFileSync(variants.clean.gds, join(taskDir, "cell-clean.gds"));
			copyFileSync(variants.seeded.gds, join(taskDir, "cell-seeded.gds"));
			const json = (task, input) => `${JSON.stringify({ task, input, ...common }, null, 2)}\n`;
			writeFileSync(join(taskDir, "expected.json"), json("layout-drc-fix", "seeded"));
			writeFileSync(join(here, "../layout-clean", pdk, "expected.json"), json("layout-clean", "clean"));
			console.log(`${pdk}: wrote cell-clean.gds, cell-seeded.gds and expected.json of layout-drc-fix and layout-clean`);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
