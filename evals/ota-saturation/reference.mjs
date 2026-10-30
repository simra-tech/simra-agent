// Reference values for the ota-saturation task.
//
// 1. Copy the task files into evals/ota-saturation/work/reference (not tracked).
// 2. For each corner of spec.md and each VCM of the input range (steps of 20 mV), write a correct testbench
//    that measures the AC response and, at the operating point, VDS - VDSAT of each transistor. Run it through
//    the kernel runner and the ngspice adapter.
// 3. Check the ngspice "meas" results against an independent calculation from the raw AC data.
// 4. For each requirement, find the worst value over the input range and the VCM where it occurs.
// 5. Run the team testbench (tb_ota.spice) with the corner set as its comment says. It uses only VCM = VDD / 2,
//    and it must give the reference values at that VCM. Its values show what an answer gives when it believes
//    the comment that VDD / 2 is the worst case.
// 6. Write expected.json: the limits from spec.md, the values, the verdicts, the tolerances and the provenance.
//
// Usage: node evals/ota-saturation/reference.mjs [environment]   (default environment: eda)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExperiment } from "@simra-tech/kernel";
import { crossCheck } from "../ota-corners/reference.mjs";
import { METRICS, parseSpec, passes } from "../ota-pvt/reference.mjs";

const here = new URL(".", import.meta.url).pathname;
const example = new URL("../../examples/ota-sg13g2/", import.meta.url).pathname;
const work = join(here, "work", "reference");
const environment = process.argv[2] ?? "eda";
const CORNER_LIB = "$PDK_ROOT/ihp-sg13g2/libs.tech/ngspice/models/cornerMOSlv.lib";
const AC = { gain_db: "dB", ugf_hz: "Hz", pm_deg: "deg" };
const STEP = 0.02;
// The transistors of ota.spice and the device instance that the SG13G2 subcircuit makes for each.
const DEVICES = { XM1: "n", XM2: "n", XM3: "p", XM4: "p", XM5: "n", XM6: "p", XM7: "n", XM8: "n" };
const inst = (name) => `@n.xdut.${name.toLowerCase()}.nsg13_lv_${DEVICES[name]}mos`;
const SAT = Object.fromEntries(Object.keys(DEVICES).map((d) => [`sat_${d.toLowerCase()}`, "V"]));

/** The input common-mode range of spec.md, in V. */
export function parseRange(text) {
	const m = text.match(/Input common-mode voltage: VCM from ([\d.]+) V to ([\d.]+) V\./);
	if (!m) throw new Error("spec.md: input common-mode range not found");
	return [Number(m[1]), Number(m[2])];
}

/** The VCM values of the sweep: the range in steps of STEP, both ends included. */
export function sweep([low, high]) {
	const n = Math.round((high - low) / STEP);
	return Array.from({ length: n + 1 }, (_, i) => Number((low + i * STEP).toFixed(3)));
}

/** A correct testbench for one corner and one VCM, written without the team testbench. */
function referenceDeck({ vdd, temp }, vcm) {
	const op = Object.keys(DEVICES).map((d) => `let sat_${d.toLowerCase()} = abs(${inst(d)}[vds]) - abs(${inst(d)}[vdss])`);
	return `* Reference testbench for evals/ota-saturation: VDD = ${vdd} V, VCM = ${vcm} V, CL = 2 pF, ${temp} degC
.include "ota.spice"
.temp ${temp}
Vdd vdd 0 ${vdd}
Vss vss 0 0
Ib vdd ibias 10u
Vinp inp 0 dc ${vcm} ac 1
Lfb out inn 1G
Cfb inn 0 1G
CL out 0 2p
Xdut inp inn out vdd vss ibias ota
.control
op
print v(out)
${op.join("\n")}
print ${Object.keys(SAT).join(" ")}
ac dec 100 1 10G
meas ac gain_db find vdb(out) at=1
meas ac ugf_hz when vdb(out)=0
meas ac phase_ugf_rad find vp(out) at=ugf_hz
let pm_deg = 180 + phase_ugf_rad * 180 / pi
print pm_deg
wrdata ac.txt v(out)
.endc
`;
}

/** The team testbench with the corner set as its comment says (VDD and .temp; the adapter adds the .lib section). */
export function teamDeck(team, { vdd, temp }) {
	const once = (text, re, line) => {
		if ((text.match(new RegExp(re.source, "gm")) ?? []).length !== 1) throw new Error(`tb_ota.spice: ${re} not found once`);
		return text.replace(new RegExp(re.source, "m"), line);
	};
	let deck = once(team, /^\.lib .*\n/, "");
	deck = once(deck, /^\.temp .*$/, `.temp ${temp}`);
	return once(deck, /^\.param vdd=1\.2 /, `.param vdd=${vdd} `);
}

async function simulate(deck, section, measurements, purpose) {
	const { id, experiment, dir, result } = await runExperiment({
		root: work,
		adapter: "ngspice",
		operation: "simulate",
		environment,
		purpose,
		inputs: { deck, libs: [{ path: CORNER_LIB, section }], measurements },
	});
	if (result.status !== "completed") throw new Error(`${purpose}: ${result.status} ${result.errors.join("; ")}`);
	const values = Object.fromEntries(Object.entries(result.measurements).map(([k, v]) => [k, v.value]));
	for (const [k, v] of Object.entries(values)) if (v === null) throw new Error(`${purpose}: ${k} not measured`);
	return { id, dir, experiment, result, values };
}

async function main() {
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	for (const f of ["ota.spice", "simra.config.json", "simra.local.json"]) {
		if (existsSync(join(example, f))) copyFileSync(join(example, f), join(work, f));
	}
	const specText = readFileSync(join(here, "spec.md"), "utf8");
	const spec = parseSpec(specText);
	const range = parseRange(specText);
	const team = readFileSync(join(here, "tb_ota.spice"), "utf8");

	const corners = {};
	let provenance = null;
	for (const [corner, c] of Object.entries(spec.corners)) {
		const points = [];
		for (const vcm of sweep(range)) {
			const deck = `ref_${corner}_${vcm.toFixed(2)}.spice`;
			writeFileSync(join(work, deck), referenceDeck(c, vcm));
			const ref = await simulate(deck, c.section, { "v(out)": "V", ...AC, ...SAT }, `reference values, corner ${corner}, VCM ${vcm} V`);
			const check = crossCheck(readFileSync(join(ref.dir, "work", "ac.txt"), "utf8"));
			const diffs = { gain_db: Math.abs(check.gain_db - ref.values.gain_db), ugf_rel: Math.abs(check.ugf_hz / ref.values.ugf_hz - 1), pm_deg: Math.abs(check.pm_deg - ref.values.pm_deg) };
			if (!(diffs.gain_db < 0.01 && diffs.ugf_rel < 0.005 && diffs.pm_deg < 0.5)) throw new Error(`corner ${corner}, VCM ${vcm}: meas and cross-check disagree ${JSON.stringify(diffs)}`);
			const [device, margin] = Object.keys(DEVICES).map((d) => [d, ref.values[`sat_${d.toLowerCase()}`]]).reduce((a, b) => (b[1] < a[1] ? b : a));
			points.push({ vcm, experiment: ref.id, ...Object.fromEntries(METRICS.map((k) => [k, ref.values[k]])), sat_margin_v: margin, sat_device: device });
			provenance ??= {
				image_id: ref.experiment.environment.image_id ?? null,
				ngspice: ref.result.tool.version,
				pdk_commit: ref.result.tool.pdk?.commit ?? null,
				design_files: ref.result.input_files.files.filter((f) => f.path === "ota.spice"),
			};
		}
		// Every requirement of spec.md is a lower limit, so the worst value is the smallest.
		if (METRICS.some((k) => spec.limits[k].op !== ">=")) throw new Error("spec.md: only >= limits are supported");
		const worst = Object.fromEntries(METRICS.map((k) => [k, points.reduce((a, b) => (b[k] < a[k] ? b : a))]));
		const values = Object.fromEntries(METRICS.map((k) => [k, worst[k][k]]));
		const pass = Object.fromEntries(METRICS.map((k) => [k, passes(values[k], spec.limits[k])]));

		// The team testbench at VCM = VDD / 2 must give the reference values at that VCM.
		const file = `team_${corner}.spice`;
		writeFileSync(join(work, file), teamDeck(team, c));
		const run = await simulate(file, c.section, AC, `team testbench, corner ${corner}`);
		const mid = points.find((p) => Math.abs(p.vcm - c.vdd / 2) < 1e-9);
		if (!mid) throw new Error(`corner ${corner}: VDD / 2 is not a sweep point`);
		for (const k of METRICS) {
			if (Math.abs(run.values[k] / mid[k] - 1) > 1e-6) throw new Error(`corner ${corner}: team testbench gives ${k} ${run.values[k]}, reference ${mid[k]}`);
		}
		const nominal = Object.fromEntries(METRICS.map((k) => [k, run.values[k]]));

		corners[corner] = {
			conditions: { ...c, vcm_range: range, cl: "2p" },
			values,
			vcm: Object.fromEntries(METRICS.map((k) => [k, worst[k].vcm])),
			pass,
			team_testbench: { experiment: run.id, vcm: c.vdd / 2, values: nominal, pass: Object.fromEntries(METRICS.map((k) => [k, passes(nominal[k], spec.limits[k])])) },
			sweep: points,
		};
		console.log(`${corner}: worst ${JSON.stringify(values)} at VCM ${JSON.stringify(corners[corner].vcm)} pass ${JSON.stringify(pass)}; VDD/2 ${JSON.stringify(nominal)}`);
	}

	const meets = (key) => Object.values(corners).every((c) => Object.values(key ? c[key].pass : c.pass).every(Boolean));
	const expected = {
		task: "ota-saturation",
		generated_by: "evals/ota-saturation/reference.mjs",
		provenance,
		limits: spec.limits,
		vcm_range: range,
		meets_spec: meets(),
		// The claim of an answer that uses only VCM = VDD / 2, as the team testbench does.
		variant_meets_spec: { team_testbench: meets("team_testbench") },
		// A value is correct when it is within these limits of the reference value.
		tolerance: { gain_db: { abs: 0.5 }, ugf_hz: { rel: 0.05 }, pm_deg: { abs: 2 } },
		corners,
	};
	writeFileSync(join(here, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
	console.log(`meets_spec: ${expected.meets_spec}; variants ${JSON.stringify(expected.variant_meets_spec)}\nwrote evals/ota-saturation/expected.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
