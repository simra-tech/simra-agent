// Reference values for the ota-saturation task.
//
// 1. Copy the task files into evals/ota-saturation/work/reference (not tracked).
// 2. For each corner of spec.md, write a correct testbench (the VDD, VCM and temperature of the corner) that
//    measures the AC response and, at the operating point, VDS - VDSAT of each transistor. Run it through the
//    kernel runner and the ngspice adapter.
// 3. Check the ngspice "meas" results against an independent calculation from the raw AC data.
// 4. Run the team testbench (tb_ota.spice) with the corner set as its comment says. It measures only the AC
//    response, and it must give the reference AC values.
// 5. Also record VDS - (VGS - VTH) of each transistor: the margin that an answer gives when it uses the
//    overdrive voltage in place of the VDSAT of the model.
// 6. Write expected.json: the limits from spec.md, the values, the verdicts, the tolerances and the provenance.
//
// Usage: node evals/ota-saturation/reference.mjs [environment]   (default environment: eda)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExperiment } from "@simra-tech/kernel";
import { crossCheck } from "../ota-corners/reference.mjs";
import { parseSpec, passes } from "../ota-pvt/reference.mjs";

const here = new URL(".", import.meta.url).pathname;
const example = new URL("../../examples/ota-sg13g2/", import.meta.url).pathname;
const work = join(here, "work", "reference");
const environment = process.argv[2] ?? "eda";
const CORNER_LIB = "$PDK_ROOT/ihp-sg13g2/libs.tech/ngspice/models/cornerMOSlv.lib";
export const METRICS = ["gain_db", "ugf_hz", "pm_deg", "sat_margin_v"];
const AC = { gain_db: "dB", ugf_hz: "Hz", pm_deg: "deg" };
// The transistors of ota.spice and the device instance that the SG13G2 subcircuit makes for each.
export const DEVICES = { XM1: "n", XM2: "n", XM3: "p", XM4: "p", XM5: "n", XM6: "p", XM7: "n", XM8: "n" };
const inst = (name) => `@n.xdut.${name.toLowerCase()}.nsg13_lv_${DEVICES[name]}mos`;

/** A correct testbench for one corner, written without the team testbench. */
function referenceDeck({ vdd, temp }) {
	const op = Object.keys(DEVICES).flatMap((d) => [
		`let sat_${d.toLowerCase()} = abs(${inst(d)}[vds]) - abs(${inst(d)}[vdss])`,
		`let ov_${d.toLowerCase()} = abs(${inst(d)}[vds]) - (abs(${inst(d)}[vgs]) - abs(${inst(d)}[vth]))`,
		`print sat_${d.toLowerCase()} ov_${d.toLowerCase()}`,
	]);
	return `* Reference testbench for evals/ota-saturation: VDD = ${vdd} V, VCM = VDD / 2, CL = 2 pF, ${temp} degC
.include "ota.spice"
.temp ${temp}
Vdd vdd 0 ${vdd}
Vss vss 0 0
Ib vdd ibias 10u
Vinp inp 0 dc ${vdd / 2} ac 1
Lfb out inn 1G
Cfb inn 0 1G
CL out 0 2p
Xdut inp inn out vdd vss ibias ota
.control
op
print v(out)
${op.join("\n")}
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

/** The smallest margin and the transistor that sets it. */
function smallest(values, prefix) {
	const [device, margin] = Object.keys(DEVICES).map((d) => [d, values[`${prefix}_${d.toLowerCase()}`]]).reduce((a, b) => (b[1] < a[1] ? b : a));
	return { margin, device };
}

async function main() {
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	for (const f of ["ota.spice", "simra.config.json", "simra.local.json"]) {
		if (existsSync(join(example, f))) copyFileSync(join(example, f), join(work, f));
	}
	const spec = parseSpec(readFileSync(join(here, "spec.md"), "utf8"));
	if (!spec.limits.sat_margin_v) throw new Error("spec.md: sat_margin_v not found");
	const team = readFileSync(join(here, "tb_ota.spice"), "utf8");
	const opMeasurements = Object.fromEntries(Object.keys(DEVICES).flatMap((d) => [[`sat_${d.toLowerCase()}`, "V"], [`ov_${d.toLowerCase()}`, "V"]]));

	const corners = {};
	let provenance = null;
	for (const [corner, c] of Object.entries(spec.corners)) {
		const deck = `ref_${corner}.spice`;
		writeFileSync(join(work, deck), referenceDeck(c));
		const ref = await simulate(deck, c.section, { "v(out)": "V", ...AC, ...opMeasurements }, `reference values, corner ${corner}`);
		const check = crossCheck(readFileSync(join(ref.dir, "work", "ac.txt"), "utf8"));
		const diffs = { gain_db: Math.abs(check.gain_db - ref.values.gain_db), ugf_rel: Math.abs(check.ugf_hz / ref.values.ugf_hz - 1), pm_deg: Math.abs(check.pm_deg - ref.values.pm_deg) };
		if (!(diffs.gain_db < 0.01 && diffs.ugf_rel < 0.005 && diffs.pm_deg < 0.5)) throw new Error(`corner ${corner}: meas and cross-check disagree ${JSON.stringify(diffs)}`);

		const sat = smallest(ref.values, "sat");
		const ov = smallest(ref.values, "ov");
		const values = { gain_db: ref.values.gain_db, ugf_hz: ref.values.ugf_hz, pm_deg: ref.values.pm_deg, sat_margin_v: sat.margin };
		const pass = Object.fromEntries(METRICS.map((k) => [k, passes(values[k], spec.limits[k])]));

		// The team testbench measures only the AC response. With the corner set, it must give the reference values.
		const file = `team_${corner}.spice`;
		writeFileSync(join(work, file), teamDeck(team, c));
		const run = await simulate(file, c.section, AC, `team testbench, corner ${corner}`);
		for (const k of Object.keys(AC)) {
			if (Math.abs(run.values[k] / values[k] - 1) > 1e-6) throw new Error(`corner ${corner}: team testbench gives ${k} ${run.values[k]}, reference ${values[k]}`);
		}

		corners[corner] = {
			conditions: { ...c, vcm: c.vdd / 2, cl: "2p" },
			experiment: ref.id,
			values,
			device: sat.device,
			pass,
			margins: Object.fromEntries(Object.keys(DEVICES).map((d) => [d, ref.values[`sat_${d.toLowerCase()}`]])),
			overdrive: { values: { sat_margin_v: ov.margin }, device: ov.device, pass: { sat_margin_v: passes(ov.margin, spec.limits.sat_margin_v) }, margins: Object.fromEntries(Object.keys(DEVICES).map((d) => [d, ref.values[`ov_${d.toLowerCase()}`]])) },
			team_experiment: run.id,
			cross_check: check,
		};
		console.log(`${corner}: ${JSON.stringify(values)} device ${sat.device} pass ${JSON.stringify(pass)}; overdrive margin ${ov.margin.toFixed(4)} (${ov.device})`);
		provenance ??= {
			image_id: ref.experiment.environment.image_id ?? null,
			ngspice: ref.result.tool.version,
			pdk_commit: ref.result.tool.pdk?.commit ?? null,
			design_files: ref.result.input_files.files.filter((f) => f.path === "ota.spice"),
		};
	}

	const all = (rows) => Object.values(corners).every((c) => Object.values(rows(c)).every(Boolean));
	const expected = {
		task: "ota-saturation",
		generated_by: "evals/ota-saturation/reference.mjs",
		provenance,
		limits: spec.limits,
		meets_spec: all((c) => c.pass),
		// The claim of an answer that checks only the AC rows, and of an answer that uses VGS - VTH for VDSAT.
		variant_meets_spec: {
			ac_only: all((c) => ({ gain_db: c.pass.gain_db, ugf_hz: c.pass.ugf_hz, pm_deg: c.pass.pm_deg })),
			overdrive: all((c) => ({ ...c.pass, sat_margin_v: c.overdrive.pass.sat_margin_v })),
		},
		// A value is correct when it is within these limits of the reference value.
		tolerance: { gain_db: { abs: 0.5 }, ugf_hz: { rel: 0.05 }, pm_deg: { abs: 2 }, sat_margin_v: { abs: 0.01 } },
		corners,
	};
	writeFileSync(join(here, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
	console.log(`meets_spec: ${expected.meets_spec}; variants ${JSON.stringify(expected.variant_meets_spec)}\nwrote evals/ota-saturation/expected.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
