// Reference values for the ota-conditions task.
//
// 1. Copy the task files into evals/ota-conditions/work/reference (not tracked).
// 2. For each corner of spec.md, write a correct testbench (the VDD and temperature of the corner, VCM = VDD / 2,
//    CL = 2 pF) and run it through the kernel runner and the ngspice adapter.
// 3. Check the ngspice "meas" results against an independent calculation from the raw AC data.
// 4. Run the team testbench (tb_ota.spice) with the corner set as its comment says, in three variants: as it is
//    (VCM = 0.4 V, CL = 0.5 pF), with only CL corrected, and with only VCM corrected. Their values show what an
//    answer gives when it keeps one or both faults.
// 5. Write expected.json: the limits from spec.md, the values, the verdicts, the tolerances and the provenance.
//
// Usage: node evals/ota-conditions/reference.mjs [environment]   (default environment: eda)

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
const MEASUREMENTS = { "v(out)": "V", gain_db: "dB", ugf_hz: "Hz", pm_deg: "deg" };
const SPEC_CL = "2p";

/** A correct testbench for one corner, written without the team testbench. */
function referenceDeck({ vdd, temp }) {
	return `* Reference testbench for evals/ota-conditions: VDD = ${vdd} V, VCM = VDD / 2, CL = 2 pF, ${temp} degC
.include "ota.spice"
.temp ${temp}
Vdd vdd 0 ${vdd}
Vss vss 0 0
Ib vdd ibias 10u
Vinp inp 0 dc ${vdd / 2} ac 1
Lfb out inn 1G
Cfb inn 0 1G
CL out 0 ${SPEC_CL}
Xdut inp inn out vdd vss ibias ota
.control
op
print v(out)
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

/** Replace one line of the team testbench. The line must be there exactly once. */
function replaceLine(text, re, line) {
	const n = text.match(new RegExp(re.source, "gm"))?.length ?? 0;
	if (n !== 1) throw new Error(`tb_ota.spice: ${re} found ${n} times`);
	return text.replace(new RegExp(re.source, "m"), line);
}

/**
 * The team testbench with the corner set as its comment says (VDD and .temp; the adapter adds the .lib section).
 * fix: "cl" sets CL = 2 pF, "vcm" sets VCM = VDD / 2.
 */
export function teamDeck(team, { vdd, temp }, fix = []) {
	let deck = replaceLine(team, /^\.lib .*\n/, "");
	deck = replaceLine(deck, /^\.temp .*$/, `.temp ${temp}`);
	deck = replaceLine(deck, /^\.param vdd=1\.2 vcm=0\.4$/, `.param vdd=${vdd} vcm=${fix.includes("vcm") ? vdd / 2 : 0.4}`);
	if (fix.includes("cl")) deck = replaceLine(deck, /^CL out 0 0\.5p$/, `CL out 0 ${SPEC_CL}`);
	return deck;
}

/** The variants of the team testbench: the faults that each keeps. */
export const VARIANTS = { team_testbench: [], cl_fixed_only: ["cl"], vcm_fixed_only: ["vcm"] };

async function simulate(deck, section, purpose) {
	const { id, dir, experiment, result } = await runExperiment({
		root: work,
		adapter: "ngspice",
		operation: "simulate",
		environment,
		purpose,
		inputs: { deck, libs: [{ path: CORNER_LIB, section }], measurements: MEASUREMENTS },
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
	const spec = parseSpec(readFileSync(join(here, "spec.md"), "utf8"));
	const team = readFileSync(join(here, "tb_ota.spice"), "utf8");

	const corners = {};
	let provenance = null;
	for (const [corner, c] of Object.entries(spec.corners)) {
		const deck = `ref_${corner}.spice`;
		writeFileSync(join(work, deck), referenceDeck(c));
		const ref = await simulate(deck, c.section, `reference values, corner ${corner}`);
		const check = crossCheck(readFileSync(join(ref.dir, "work", "ac.txt"), "utf8"));
		const diffs = { gain_db: Math.abs(check.gain_db - ref.values.gain_db), ugf_rel: Math.abs(check.ugf_hz / ref.values.ugf_hz - 1), pm_deg: Math.abs(check.pm_deg - ref.values.pm_deg) };
		const agrees = diffs.gain_db < 0.01 && diffs.ugf_rel < 0.005 && diffs.pm_deg < 0.5;
		if (!agrees) throw new Error(`corner ${corner}: meas and cross-check disagree ${JSON.stringify(diffs)}`);

		const values = Object.fromEntries(METRICS.map((k) => [k, ref.values[k]]));
		const pass = Object.fromEntries(METRICS.map((k) => [k, passes(values[k], spec.limits[k])]));
		corners[corner] = { conditions: { ...c, vcm: c.vdd / 2, cl: SPEC_CL }, experiment: ref.id, values, v_out: ref.values["v(out)"], pass, cross_check: check };

		// The team testbench with both faults corrected must give the reference values.
		const both = `team_${corner}_fixed.spice`;
		writeFileSync(join(work, both), teamDeck(team, c, ["cl", "vcm"]));
		const fixed = await simulate(both, c.section, `team testbench, both faults corrected, corner ${corner}`);
		for (const k of METRICS) {
			if (Math.abs(fixed.values[k] / values[k] - 1) > 1e-6) throw new Error(`corner ${corner}: corrected team testbench gives ${k} ${fixed.values[k]}, reference ${values[k]}`);
		}

		for (const [variant, fix] of Object.entries(VARIANTS)) {
			const file = `team_${corner}_${variant}.spice`;
			writeFileSync(join(work, file), teamDeck(team, c, fix));
			const run = await simulate(file, c.section, `${variant.replaceAll("_", " ")}, corner ${corner}`);
			corners[corner][variant] = { experiment: run.id, values: Object.fromEntries(METRICS.map((k) => [k, run.values[k]])), pass: Object.fromEntries(METRICS.map((k) => [k, passes(run.values[k], spec.limits[k])])) };
		}
		console.log(`${corner}: ${JSON.stringify(values)} pass ${JSON.stringify(pass)}; team testbench ${JSON.stringify(corners[corner].team_testbench.values)}`);
		provenance ??= {
			image_id: ref.experiment.environment.image_id ?? null,
			ngspice: ref.result.tool.version,
			pdk_commit: ref.result.tool.pdk?.commit ?? null,
			design_files: ref.result.input_files.files.filter((f) => f.path === "ota.spice"),
		};
	}

	const meets = (key) => Object.values(corners).every((c) => Object.values(key ? c[key].pass : c.pass).every(Boolean));
	const expected = {
		task: "ota-conditions",
		generated_by: "evals/ota-conditions/reference.mjs",
		provenance,
		limits: spec.limits,
		meets_spec: meets(),
		// The claim that each variant of the team testbench gives.
		variant_meets_spec: Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, meets(v)])),
		// A value is correct when it is within these limits of the reference value.
		tolerance: { gain_db: { abs: 0.5 }, ugf_hz: { rel: 0.05 }, pm_deg: { abs: 2 } },
		corners,
	};
	writeFileSync(join(here, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
	console.log(`meets_spec: ${expected.meets_spec}; variants ${JSON.stringify(expected.variant_meets_spec)}\nwrote evals/ota-conditions/expected.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
