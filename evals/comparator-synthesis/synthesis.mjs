// Shared parts of the comparator-synthesis tasks (one task directory for each PDK).
//
// The agent gets a pin specification (spec.md), the transient bench verify.spice and requirements.json, and no
// netlist. It writes a continuous-time comparator in cmp.spice; the topology is free. The scorer is the
// scoreSynthesis() of ../ota-synthesis/synthesis.mjs, with the tolerance of this task: it runs the check of
// requirements.json on the final cmp.spice through the kernel (the verify() of ../ota-sizing/sizing.mjs). The
// check lints cmp.spice with the design experiment of requirements.json (the experiment with the operation
// check_design) and simulates it with the bench at each corner and at the 5 VCM points of the range.
//
// Score:
// - design (2): the design part of the verdict passes (the contract, the element rules and the limits).
// - requirements (24): for each corner and requirement, the verified worst value passes. Given only when the
//   design part passes.
// - claim (4): meets_spec is the same as the verification (the design part and all requirements).
// - values (24): for each row, the reported worst value is within the tolerance of the verified worst value.
//
// Diagnostics (no points): as in ../ota-synthesis/synthesis.mjs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpec as parseSynthesisSpec, scoreMain as synthesisMain, scoreSynthesis, verify } from "../ota-synthesis/synthesis.mjs";

export { verify };

/** The requirement ids, in the order of spec.md and requirements.json. */
export const METRICS = ["tpd_r_s", "tpd_f_s", "voh_rel", "vol_rel", "vos_v", "hyst_v", "idd_a", "iin_a"];

/**
 * The tolerance of a reported worst value (abs: in the unit of the metric; rel: a fraction; with both, either one
 * suffices). iin_a as in ota-synthesis.
 */
export const TOLERANCE = {
	tpd_r_s: { rel: 0.05 },
	tpd_f_s: { rel: 0.05 },
	voh_rel: { abs: 0.01 },
	vol_rel: { abs: 0.01 },
	vos_v: { abs: 1e-4 },
	hyst_v: { abs: 1e-4 },
	idd_a: { rel: 0.02 },
	iin_a: { abs: 2e-11, rel: 0.02 },
};

/** The conditions, corners, requirements, design rules and the VCM points of the bench, from spec.md. */
export function parseSpec(text) {
	const points = text.match(/The bench checks 5 points: ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+) and ([\d.]+) V\./);
	if (!points) throw new Error("spec.md: the VCM points of the bench not found");
	return { ...parseSynthesisSpec(text, METRICS), points: points.slice(1).map(Number) };
}

/** The task data: task.json and spec.md of a task directory. */
export function loadTask(taskDir) {
	const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
	const spec = parseSpec(readFileSync(join(taskDir, "spec.md"), "utf8"));
	return { task, spec };
}

/** Score a workspace of a comparator-synthesis task. The options are those of scoreSynthesis. */
export const scoreComparator = (ws, taskDir, options = {}) => scoreSynthesis(ws, taskDir, { tolerance: TOLERANCE, ...options });

/** The command line of the score.mjs of a task directory: node <task>/score.mjs <workspace>. */
export const scoreMain = (taskDir, argv) => synthesisMain(taskDir, argv, { tolerance: TOLERANCE });
