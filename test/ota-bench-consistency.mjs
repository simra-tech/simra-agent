// A shared check of the tasks with a verification bench (ota-sizing, ota-synthesis, comparator-synthesis):
// verify.spice and requirements.json say the same as spec.md (the VCM points, the corners and the requirements with
// their limits), and the area rule of the R and C in spec.md says the same as the technology pack.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { validateRequirements } from "@simra-tech/kernel";
import { METRICS, sweep } from "../evals/ota-sizing/sizing.mjs";

/** The variant directories of a base task directory name in taskRoot (evals/synthesis-family.mjs): <name>-f<factor>. */
export const variantDirs = (taskRoot, name) =>
	readdirSync(taskRoot, { withFileTypes: true })
		.filter((e) => e.isDirectory() && new RegExp(`^${name}-f\\d+(\\.\\d+)?$`).test(e.name))
		.map((e) => e.name)
		.sort();

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
	assert.deepEqual(req.requirements.filter((r) => r.conditions).map((r) => r.id), metrics);
	assert.deepEqual(Object.keys(spec.limits), metrics);
	for (const m of metrics) {
		const r = req.requirements.find((x) => x.id === m);
		assert.deepEqual([r.measurement, r.unit, r.op, r.conditions], [m, req.experiments.sweep.inputs.measurements[m], spec.limits[m].op, Object.keys(spec.corners)]);
		const same = (a, b) => (a === 0 ? b === 0 : Math.abs(b / a - 1) < 1e-12);
		const [got, want] = [[r.limit].flat(), [spec.limits[m].value].flat()];
		assert.ok(got.length === want.length && got.every((x, i) => same(x, want[i])), `${m}: limit ${r.limit}, spec ${spec.limits[m].value}`);
	}
}

/** The R and C facts of a PDK in a technology pack (ngspice.passives). */
export function passiveFacts(technology, pdk) {
	const pack = JSON.parse(readFileSync(new URL(`../technologies/${technology}/technology.json`, import.meta.url), "utf8"));
	const facts = pack.ngspice.passives?.[pdk];
	assert.ok(facts, `${technology}: no ngspice.passives facts for ${pdk}`);
	return facts;
}

/** The area in µm² of the resistors rc.r (Ω) and the capacitors rc.c (F): R × w_min² / R_sheet and C / density. */
export function passiveArea(technology, pdk, { r = [], c = [] }) {
	const { r: fr, c: fc } = passiveFacts(technology, pdk);
	const sum = (xs) => xs.reduce((a, b) => a + b, 0);
	return (sum(r) * fr.width_min_m ** 2) / fr.sheet_ohm * 1e12 + (sum(c) / fc.density_f_per_m2) * 1e12;
}

/** The area rule of spec.md gives the devices, the values and the examples of the pack facts. */
export function assertPassiveRule(spec, technology, pdk) {
	const text = spec.replace(/\s+/g, " ");
	const { r, c } = passiveFacts(technology, pdk);
	const num = (x) => String(Number(x.toPrecision(6)));
	assert.ok(text.includes(`A resistor R counts as the high-resistance poly resistor \`${r.device}\` of the PDK at its minimum width: R × (${num(r.width_min_m * 1e6)} µm)² / ${r.sheet_ohm} Ω (${r.sheet_ohm} Ω/sq).`), `${pdk}: the R rule`);
	assert.match(text, new RegExp(`A capacitor C counts as the \\w+ capacitor \`${c.device}\` of the PDK[^.]*: C / \\(${num(c.density_f_per_m2 * 1e3).replace(".", "\\.")} fF/µm²\\)\\.`), `${pdk}: the C rule`);
	const example = (re, want) => {
		const got = Number(text.match(re)?.[1]);
		assert.ok(Math.abs(got - want) <= 0.01 * want, `${pdk}: example ${got}, from the pack ${want}`);
	};
	example(/10 kΩ counts as ([\d.]+) µm²/, passiveArea(technology, pdk, { r: [1e4] }));
	example(/1 pF counts as ([\d.]+) µm²/, passiveArea(technology, pdk, { c: [1e-12] }));
}
