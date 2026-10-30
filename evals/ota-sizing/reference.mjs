// Reference results for an ota-sizing task. They show that the task is correct and that it has a solution.
//
// 1. Verify the original ota.spice (the verification sweep of sizing.mjs). It must not meet spec.md.
// 2. Verify a reference fix: the original with the sizes in FIXES. It must meet spec.md and the design limits.
// 3. Cross-check the verification sweep: at each corner, simulate the original at the VCM of its worst UGF with
//    one operating point and one AC analysis, and calculate gain, UGF and PM from the raw AC data. They must
//    agree with the sweep.
// 4. sg13cmos5l only: the original must give the worst values of evals/ota-saturation (IHP SG13G2). The MOS
//    model files of the two IHP PDKs are the same.
// 5. Write expected.json in the task directory: the results of the original and of the reference fix.
//
// Usage: node evals/ota-sizing/reference.mjs <sg13cmos5l|sky130> [environment]   (default environment: eda)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runExperiment } from "@simra-tech/kernel";
import { crossCheck } from "../ota-corners/reference.mjs";
import { changedSizes, checkTopology, gateArea, loadTask, METRICS, parseOta, spiceNumber, TOLERANCE, verify } from "./sizing.mjs";
import { within } from "../ota-corners/score.mjs";

const here = new URL(".", import.meta.url).pathname;

/** The reference fix of each task: { device: { parameter: value } }. */
export const FIXES = {
	sg13cmos5l: { XM1: { w: "12u" }, XM2: { w: "12u" }, XM3: { w: "8u" }, XM4: { w: "8u" }, XM6: { w: "32u", ng: "8" } },
	sky130: { XM1: { w: "8" }, XM2: { w: "8" }, XM3: { w: "12" }, XM4: { w: "12" }, XM6: { w: "48", nf: "6" } },
};

/** The netlist with new values for some parameters of some devices. Each parameter must be on its line. */
export function resize(text, fix) {
	return text
		.split("\n")
		.map((line) => {
			const sizes = fix[line.split(/\s+/)[0]];
			if (!sizes) return line;
			for (const [k, v] of Object.entries(sizes)) {
				const re = new RegExp(`\\b${k}=\\S+`);
				if (!re.test(line)) throw new Error(`${line}: no parameter ${k}`);
				line = line.replace(re, `${k}=${v}`);
			}
			return line;
		})
		.join("\n");
}

/** One corner, one VCM: an operating point and an AC analysis, with the raw AC data in ac.txt. */
function pointDeck({ vdd, temp }, vcm) {
	return `* ota-sizing cross-check: VDD = ${vdd} V, VCM = ${vcm} V, CL = 2 pF, ${temp} degC
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
ac dec 100 1 10G
wrdata ac.txt v(out)
.endc
`;
}

/** The results of one design: topology, limits, area, verification and whether it meets the spec. */
function summary(spec, task, original, design, verification) {
	const topology = checkTopology(original, design);
	const area_um2 = Number(gateArea(design, task.length_unit_m).toFixed(3));
	const cc_f = spiceNumber(parseOta(design).elements.CC.params.value);
	const limits = area_um2 <= spec.design.area_um2 && cc_f <= spec.design.cc_f;
	const corners = Object.fromEntries(Object.entries(verification).map(([c, v]) => [c, { experiment: v.experiment, worst: v.worst, sweep: v.points }]));
	const meets = topology.length === 0 && limits && Object.values(verification).every((v) => METRICS.every((m) => v.worst[m].pass));
	return { changed: changedSizes(original, design), area_um2, cc_f, topology, limits, meets_spec: meets, corners };
}

async function main() {
	const name = process.argv[2];
	if (!FIXES[name]) {
		console.error(`usage: node evals/ota-sizing/reference.mjs <${Object.keys(FIXES).join("|")}> [environment]`);
		process.exit(2);
	}
	const taskDir = join(here, name);
	const environment = process.argv[3];
	const work = join(here, "work", name);
	const { task, spec, original } = loadTask(taskDir);

	const fixed = resize(original, FIXES[name]);
	const [vo, vf] = await Promise.all([verify(taskDir, original, join(work, "original"), environment), verify(taskDir, fixed, join(work, "fix"), environment)]);
	const result = { original: summary(spec, task, original, original, vo), fix: summary(spec, task, original, fixed, vf) };
	for (const [k, r] of Object.entries(result)) {
		const worst = Object.entries(r.corners).map(([c, v]) => `${c} ${METRICS.map((m) => `${m} ${v.worst[m].value} @${v.worst[m].vcm}`).join(", ")}`);
		console.log(`${k}: meets_spec ${r.meets_spec}, area ${r.area_um2} µm²\n  ${worst.join("\n  ")}`);
	}
	if (result.original.meets_spec) throw new Error("the original meets the spec: the task has nothing to fix");
	if (!result.fix.meets_spec) throw new Error("the reference fix does not meet the spec");

	// The cross-check, at the VCM of the worst UGF of the original.
	const root = join(work, "cross-check");
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	for (const f of ["simra.config.json", "simra.local.json"]) {
		const from = resolve(taskDir, task.files[f]);
		if (existsSync(from)) copyFileSync(from, join(root, f));
	}
	writeFileSync(join(root, "ota.spice"), original);
	const checks = await Promise.all(
		Object.entries(spec.corners).map(async ([corner, c]) => {
			const vcm = vo[corner].worst.ugf_hz.vcm;
			const sweepPoint = vo[corner].points.find((p) => Math.abs(p.vcm - vcm) < 1e-6);
			const deck = `point_${corner}.spice`;
			writeFileSync(join(root, deck), pointDeck(c, vcm));
			const { id, dir, result: r } = await runExperiment({ root, adapter: "ngspice", operation: "simulate", environment: environment ?? task.environment, purpose: `ota-sizing cross-check, corner ${corner}, VCM ${vcm} V`, inputs: { deck, libs: [{ path: spec.lib, section: c.section }] } });
			if (r.status !== "completed") throw new Error(`cross-check ${corner}: ${r.status} ${r.errors.join("; ")}`);
			const raw = crossCheck(readFileSync(join(dir, "work", "ac.txt"), "utf8"));
			const agrees = Math.abs(raw.gain_db - sweepPoint.gain_db) < 0.01 && Math.abs(raw.ugf_hz / sweepPoint.ugf_hz - 1) < 0.005 && Math.abs(raw.pm_deg - sweepPoint.pm_deg) < 0.5;
			if (!agrees) throw new Error(`cross-check ${corner} at VCM ${vcm} V: sweep ${JSON.stringify(sweepPoint)}, raw AC data ${JSON.stringify(raw)}`);
			return [corner, { experiment: id, vcm, raw }];
		}),
	);

	// The IHP SG13CMOS5L MOS models are the same files as the IHP SG13G2 MOS models.
	let same_as = null;
	if (name === "sg13cmos5l") {
		const sat = JSON.parse(readFileSync(join(here, "../ota-saturation/expected.json"), "utf8"));
		for (const [corner, c] of Object.entries(sat.corners)) {
			for (const m of ["gain_db", "ugf_hz", "pm_deg"]) {
				const w = vo[corner].worst[m];
				if (!within(w.value, c.values[m], { rel: 1e-4 }) || Math.abs(w.vcm - c.vcm[m]) > 1e-6) {
					throw new Error(`${corner} ${m}: ${w.value} @${w.vcm} V, ota-saturation (SG13G2) ${c.values[m]} @${c.vcm[m]} V`);
				}
			}
		}
		same_as = "evals/ota-saturation/expected.json (IHP SG13G2): the same worst values and VCM";
	}

	const expected = {
		task: task.name,
		generated_by: "evals/ota-sizing/reference.mjs",
		provenance: vo.tt.provenance,
		spec,
		tolerance: TOLERANCE,
		original: result.original,
		fix: result.fix,
		cross_check: Object.fromEntries(checks),
		same_as,
	};
	writeFileSync(join(taskDir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
	console.log(`cross-check agrees at each corner${same_as ? `; ${same_as}` : ""}\nwrote evals/ota-sizing/${name}/expected.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
