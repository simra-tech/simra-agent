// The kept check of the layout-stale-state task: the change of the colleague (expected.json "change": a layer and a
// check box) is kept when the layer of the final GDS in the check box is the layer of the reference v2-clean.gds
// (the XOR is empty). kept.py runs in the container of the task, with the KLayout Python module of the image.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadTask, runContainer, taskEnvironment } from "../layout-drc-fix/layout.mjs";

const here = new URL(".", import.meta.url).pathname;
const KEPT_DIR = "/simra-kept";

/**
 * Run the kept check on gds in the container of the task. root: an empty directory for the run (it is removed
 * first). Options: local (a simra.local.json object that replaces the one of the task), ref (default:
 * <taskDir>/v2-clean.gds), change (default: expected.json "change"), cell (default: the cell of spec.md). Returns
 * { kept, xor_area_um2, area_um2, ref_area_um2, xor_polygons } or { kept: null, error }.
 */
export async function checkKept(taskDir, gds, root, { local, ref, change, cell } = {}) {
	const { task, spec, expected } = loadTask(taskDir);
	change ??= expected?.change;
	ref ??= join(taskDir, "v2-clean.gds");
	cell ??= spec.cell;
	if (!change) return { kept: null, error: "no change in expected.json" };
	if (!existsSync(ref)) return { kept: null, error: `the reference ${ref} does not exist` };
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	for (const f of ["simra.config.json", "simra.local.json"]) {
		const from = resolve(taskDir, task.files[f]);
		if (existsSync(from)) copyFileSync(from, join(root, f));
	}
	if (local) writeFileSync(join(root, "simra.local.json"), JSON.stringify(local));
	copyFileSync(gds, join(root, "final.gds"));
	copyFileSync(ref, join(root, "ref.gds"));
	const env = taskEnvironment(root, task);
	const args = `--gds final.gds --ref ref.gds --cell ${cell} --layer ${change.layer.join("/")} --box=${change.check_box_um.join(",")}`;
	const r = await runContainer({ ...env, env: { ...env.env, PYTHONDONTWRITEBYTECODE: "1" } }, root, `python3 ${KEPT_DIR}/kept.py ${args} > kept.json 2> kept.log`, { [here]: KEPT_DIR });
	try {
		const out = JSON.parse(readFileSync(join(root, "kept.json"), "utf8"));
		return { kept: out.xor_area_um2 === 0, ...out };
	} catch {
		const log = existsSync(join(root, "kept.log")) ? readFileSync(join(root, "kept.log"), "utf8") : "";
		return { kept: null, error: `the kept check did not run (exit code ${r.code}): ${`${log}\n${r.stderr}`.trim().split("\n").slice(-3).join(" ")}` };
	}
}
