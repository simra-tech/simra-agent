// Reference values for the ota-pvt task.
//
// 1. Copy the task files into evals/ota-pvt/work/reference (not tracked).
// 2. For each corner of spec.md, write a correct testbench (the VDD, VCM and temperature of the corner) and
//    run it through the kernel runner and the ngspice adapter.
// 3. Check the ngspice "meas" results against an independent calculation from the raw AC data.
// 4. Run the team testbench (tb_ota.spice) as it is, with only the model section changed. Its values show
//    what an answer gives when it does not apply the spec conditions or does not check the phase unit.
// 5. Write expected.json: the limits from spec.md, the values, the verdicts, the tolerances and the provenance.
//
// Usage: node evals/ota-pvt/reference.mjs [environment]   (default environment: eda)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExperiment } from "@simra-tech/kernel";
import { crossCheck } from "../ota-corners/reference.mjs";

const here = new URL(".", import.meta.url).pathname;
const example = new URL("../../examples/ota-sg13g2/", import.meta.url).pathname;
const work = join(here, "work", "reference");
const environment = process.argv[2] ?? "eda";
const CORNER_LIB = "$PDK_ROOT/ihp-sg13g2/libs.tech/ngspice/models/cornerMOSlv.lib";
const MEASUREMENTS = { "v(out)": "V", gain_db: "dB", ugf_hz: "Hz", pm_deg: "deg" };
export const METRICS = ["gain_db", "ugf_hz", "pm_deg"];
const UNIT_SCALE = { dB: 1, Hz: 1, kHz: 1e3, MHz: 1e6, GHz: 1e9, "°": 1, deg: 1 };

/** Corners and limits from spec.md. */
export function parseSpec(text) {
	const corners = {};
	for (const m of text.matchAll(/^\|\s*(\w+)\s*\|\s*`(mos_\w+)`\s*\|\s*([\d.]+)\s*V\s*\|\s*(-?[\d.]+)\s*°C\s*\|$/gm)) {
		corners[m[1]] = { section: m[2], vdd: Number(m[3]), temp: Number(m[4]) };
	}
	const limits = {};
	for (const m of text.matchAll(/^\|[^|]*\|\s*`(\w+)`\s*\|\s*(>=|<=)\s*([\d.]+)\s*(\S+)\s*\|$/gm)) {
		if (!(m[4] in UNIT_SCALE)) throw new Error(`spec.md: unknown unit ${m[4]}`);
		limits[m[1]] = { op: m[2], value: Number(m[3]) * UNIT_SCALE[m[4]] };
	}
	if (Object.keys(corners).length !== 3 || METRICS.some((k) => !limits[k])) throw new Error("spec.md: corners or limits not found");
	return { corners, limits };
}

export const passes = (value, { op, value: limit }) => (op === ">=" ? value >= limit : value <= limit);

/** A correct testbench for one corner: the circuit of tb_ota.spice with the spec conditions. */
function referenceDeck({ vdd, temp }) {
	return `* Reference testbench for evals/ota-pvt: VDD = ${vdd} V, VCM = VDD / 2, ${temp} degC
.include "ota.spice"
.temp ${temp}
.param vdd=${vdd} vcm=${vdd / 2}
Vdd vdd 0 {vdd}
Vss vss 0 0
Ib vdd ibias 10u
Vinp inp 0 dc {vcm} ac 1
Lfb out inn 1G
Cfb inn 0 1G
CL out 0 2p
Xdut inp inn out vdd vss ibias ota
.control
op
print v(out)
ac dec 100 1 10G
meas ac gain_db find vdb(out) at=1
meas ac ugf_hz when vdb(out)=0
* vp() is in radians in ngspice.
meas ac phase_ugf_rad find vp(out) at=ugf_hz
let pm_deg = 180 + phase_ugf_rad * 180 / pi
print pm_deg
wrdata ac.txt v(out)
.endc
`;
}

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
	// The team testbench without its .lib line: the adapter adds the model section.
	const team = readFileSync(join(here, "tb_ota.spice"), "utf8");
	const teamNoLib = team.replace(/^\.lib .*\n/m, "");
	if (teamNoLib === team) throw new Error("tb_ota.spice: .lib line not found");
	writeFileSync(join(work, "team.spice"), teamNoLib);

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

		const naive = await simulate("team.spice", c.section, `team testbench as it is, model section of corner ${corner}`);
		const values = Object.fromEntries(METRICS.map((k) => [k, ref.values[k]]));
		const pass = Object.fromEntries(METRICS.map((k) => [k, passes(values[k], spec.limits[k])]));
		corners[corner] = {
			conditions: c,
			experiment: ref.id,
			values,
			v_out: ref.values["v(out)"],
			pass,
			cross_check: check,
			team_testbench: { experiment: naive.id, values: Object.fromEntries(METRICS.map((k) => [k, naive.values[k]])) },
		};
		console.log(`${corner}: ${JSON.stringify(values)} pass ${JSON.stringify(pass)}; team testbench ${JSON.stringify(corners[corner].team_testbench.values)}`);
		provenance ??= {
			image_id: ref.experiment.environment.image_id ?? null,
			ngspice: ref.result.tool.version,
			pdk_commit: ref.result.tool.pdk?.commit ?? null,
			design_files: ref.result.input_files.files.filter((f) => f.path === "ota.spice"),
		};
	}

	const expected = {
		task: "ota-pvt",
		generated_by: "evals/ota-pvt/reference.mjs",
		provenance,
		limits: spec.limits,
		meets_spec: Object.values(corners).every((c) => Object.values(c.pass).every(Boolean)),
		// A value is correct when it is within these limits of the reference value.
		tolerance: { gain_db: { abs: 0.5 }, ugf_hz: { rel: 0.05 }, pm_deg: { abs: 2 } },
		corners,
	};
	writeFileSync(join(here, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
	console.log(`meets_spec: ${expected.meets_spec}\nwrote evals/ota-pvt/expected.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
