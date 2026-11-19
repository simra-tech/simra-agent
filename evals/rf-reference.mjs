// A flat reference design root for an RF task: the fit_to_spice records of the EM networks of the reference, and the
// design file as the fit outputs (copied unchanged) followed by the rest of the block. The task scripts reference.mjs
// use it; so does the scorer/agent consistency test.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runExperiment } from "@simra-tech/kernel";

/**
 * Make the reference root: the task files (task.json "files"), one fit record per network of <dir>/em/<name>.<ext>, and
 * <design> = the fit outputs + <dir>/<core>. em_passives_min of the netlist gate is set to 0 in the root (the EM data of
 * a reference comes from its design, not from an openEMS record). Returns the root.
 */
export async function buildFlatReference({ here, dir, root, networks, fitInputs, core, design, environment = "eda", ext = "s3p" }) {
	const r = resolve(root);
	rmSync(r, { recursive: true, force: true });
	mkdirSync(join(r, "em"), { recursive: true });
	const task = JSON.parse(readFileSync(join(here, "task.json"), "utf8"));
	for (const [to, from] of Object.entries(task.files ?? {})) if (existsSync(join(here, from))) cpSync(join(here, from), join(r, to));
	const libs = [];
	for (const name of networks) {
		cpSync(join(dir, "em", `${name}.${ext}`), join(r, "em", `${name}.${ext}`));
		const { result } = await runExperiment({ root: r, adapter: "touchstone", operation: "fit_to_spice", inputs: fitInputs(name), purpose: `reference: fit of ${name}`, environment });
		const sub = (result.outputs ?? []).find((o) => o.role === "subckt");
		if (result.status !== "completed" || !sub) throw new Error(`fit of ${name}: ${result.status} ${[...result.errors, ...result.diagnostics.map((d) => d.message)].join("; ")}`);
		libs.push(readFileSync(join(r, sub.path), "utf8").trimEnd());
	}
	writeFileSync(join(r, design), `${libs.join("\n\n")}\n\n${readFileSync(join(dir, core), "utf8")}`);
	const req = JSON.parse(readFileSync(join(r, "requirements.json"), "utf8"));
	if (req.gates?.netlist) req.gates.netlist.em_passives_min = 0;
	writeFileSync(join(r, "requirements.json"), `${JSON.stringify(req, null, 2)}\n`);
	return r;
}
