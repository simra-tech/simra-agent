// A shared check of the tasks with a verification bench (ota-sizing, ota-synthesis, comparator-synthesis):
// verify.spice and requirements.json say the same as spec.md (the VCM points, the corners and the requirements with
// their limits).

import assert from "node:assert/strict";
import { validateRequirements } from "@simra-tech/kernel";
import { METRICS, sweep } from "../evals/ota-sizing/sizing.mjs";

/**
 * spec: the result of parseConditions; bench: the text of verify.spice; req: requirements.json. The OTA tasks
 * sweep the range in steps; another task gives its VCM points, its requirement ids (metrics) and its ROW line.
 */
export function assertBenchMatchesSpec(spec, bench, req, { points = sweep(spec.range), metrics = METRICS, row = /^\s*echo ROW vcm=\$vcm idd_a=.* gain_db=.* ugf_hz=.* pm_deg=/m } = {}) {
	assert.deepEqual(validateRequirements(req), []);
	// The bench sweeps the VCM points of the spec and prints one ROW line per point. The corner gives the model
	// library, VDD and the temperature, so the bench has no .lib line and only defaults for vdd and .temp.
	assert.deepEqual([points[0], points.at(-1)], spec.range);
	assert.match(bench, new RegExp(`^\\s*foreach vcm ${points.join(" ")}$`, "m"));
	assert.match(bench, row);
	assert.doesNotMatch(bench, /^\.lib/im);
	assert.match(bench, new RegExp(`^\\.param vdd=${spec.corners.tt.vdd}$`, "m"));
	assert.match(bench, new RegExp(`^\\.temp ${spec.corners.tt.temp}$`, "m"));
	// Each corner of the spec is a condition: its library section, VDD and temperature.
	assert.deepEqual(Object.keys(req.conditions), Object.keys(spec.corners));
	for (const [c, k] of Object.entries(spec.corners)) {
		assert.deepEqual(req.conditions[c].inputs, { libs: [{ path: spec.lib, section: k.section }], params: { vdd: k.vdd }, temp_c: k.temp });
	}
	// One sweep experiment with the bench, and each requirement of the spec with its limit at every corner.
	assert.equal(req.experiments.sweep.inputs.deck, "verify.spice");
	assert.deepEqual(Object.keys(req.experiments.sweep.inputs.measurements), metrics);
	assert.deepEqual(req.requirements.map((r) => r.id), metrics);
	assert.deepEqual(Object.keys(spec.limits), metrics);
	for (const m of metrics) {
		const r = req.requirements.find((x) => x.id === m);
		assert.deepEqual([r.measurement, r.unit, r.op, r.conditions], [m, req.experiments.sweep.inputs.measurements[m], spec.limits[m].op, Object.keys(spec.corners)]);
		const same = (a, b) => (a === 0 ? b === 0 : Math.abs(b / a - 1) < 1e-12);
		const [got, want] = [[r.limit].flat(), [spec.limits[m].value].flat()];
		assert.ok(got.length === want.length && got.every((x, i) => same(x, want[i])), `${m}: limit ${r.limit}, spec ${spec.limits[m].value}`);
	}
}
