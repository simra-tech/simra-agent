// A shared check of the OTA tasks with a verification bench (ota-sizing, ota-synthesis): verify.spice and
// requirements.json say the same as spec.md (the VCM range, the corners and the requirements with their limits).

import assert from "node:assert/strict";
import { validateRequirements } from "@simra-tech/kernel";
import { METRICS, sweep } from "../evals/ota-sizing/sizing.mjs";

/** spec: the result of parseConditions; bench: the text of verify.spice; req: requirements.json. */
export function assertBenchMatchesSpec(spec, bench, req) {
	assert.deepEqual(validateRequirements(req), []);
	// The bench sweeps the VCM range of the spec and prints one ROW line per point. The corner gives the model
	// library, VDD and the temperature, so the bench has no .lib line and only defaults for vdd and .temp.
	assert.match(bench, new RegExp(`^foreach vcm ${sweep(spec.range).join(" ")}$`, "m"));
	assert.match(bench, /^\s*echo ROW vcm=\$vcm idd_a=.* gain_db=.* ugf_hz=.* pm_deg=/m);
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
	assert.deepEqual(Object.keys(req.experiments.sweep.inputs.measurements), METRICS);
	for (const m of METRICS) {
		const r = req.requirements.find((x) => x.id === m);
		assert.deepEqual([r.measurement, r.unit, r.op, r.conditions], [m, req.experiments.sweep.inputs.measurements[m], spec.limits[m].op, Object.keys(spec.corners)]);
		assert.ok(Math.abs(r.limit / spec.limits[m].value - 1) < 1e-12, `${m}: limit ${r.limit}, spec ${spec.limits[m].value}`);
	}
}
