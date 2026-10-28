// Reference values for the ota-corners task.
//
// 1. Copy examples/ota-sg13g2 into evals/ota-corners/work/reference (not tracked).
// 2. Run reference.spice at mos_tt, mos_ss and mos_ff through the kernel runner and the ngspice adapter.
// 3. Check the ngspice "meas" results against an independent calculation from the raw AC data.
// 4. Write expected.json: values, tolerances for scoring, and the provenance of each value.
//
// Usage: node evals/ota-corners/reference.mjs [environment]   (default environment: eda)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExperiment } from "@simra-tech/kernel";

const here = new URL(".", import.meta.url).pathname;
const example = new URL("../../examples/ota-sg13g2/", import.meta.url).pathname;
const work = join(here, "work", "reference");
const environment = process.argv[2] ?? "eda";
export const CORNERS = ["tt", "ss", "ff"];
const CORNER_LIB = "$PDK_ROOT/ihp-sg13g2/libs.tech/ngspice/models/cornerMOSlv.lib";
const MEASUREMENTS = { "v(out)": "V", gain_db: "dB", ugf_hz: "Hz", pm_deg: "deg", vn_1k_nv: "nV/sqrt(Hz)" };

/** Gain at the first point, unity-gain frequency and phase margin from "freq re im" rows. */
export function crossCheck(text) {
	const rows = text
		.trim()
		.split("\n")
		.map((l) => l.trim().split(/\s+/).map(Number))
		.map(([f, re, im]) => ({ f, mag: Math.hypot(re, im), ph: Math.atan2(im, re) }));
	// Unwrap the phase from the first point, then convert to degrees.
	for (let i = 1; i < rows.length; i++) {
		while (rows[i].ph - rows[i - 1].ph > Math.PI) rows[i].ph -= 2 * Math.PI;
		while (rows[i].ph - rows[i - 1].ph < -Math.PI) rows[i].ph += 2 * Math.PI;
	}
	const i = rows.findIndex((r) => r.mag < 1);
	const [a, b] = [rows[i - 1], rows[i]];
	// Interpolate on log(frequency) against log(magnitude).
	const t = Math.log(a.mag) / (Math.log(a.mag) - Math.log(b.mag));
	const ugf = Math.exp(Math.log(a.f) + t * (Math.log(b.f) - Math.log(a.f)));
	const phUgf = a.ph + t * (b.ph - a.ph);
	return { gain_db: 20 * Math.log10(rows[0].mag), ugf_hz: ugf, pm_deg: 180 + (phUgf * 180) / Math.PI };
}

async function main() {
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	for (const f of ["ota.spice", "tb_ota.spice", "simra.config.json", "simra.local.json"]) {
		if (existsSync(join(example, f))) copyFileSync(join(example, f), join(work, f));
	}
	copyFileSync(join(here, "reference.spice"), join(work, "reference.spice"));

	const corners = {};
	let provenance = null;
	for (const corner of CORNERS) {
		const { id, dir, experiment, result } = await runExperiment({
			root: work,
			adapter: "ngspice",
			operation: "simulate",
			environment,
			purpose: `reference values, corner ${corner}`,
			inputs: { deck: "reference.spice", libs: [{ path: CORNER_LIB, section: `mos_${corner}` }], measurements: MEASUREMENTS },
		});
		if (result.status !== "completed") throw new Error(`corner ${corner}: ${result.status} ${result.errors.join("; ")}`);
		const m = Object.fromEntries(Object.entries(result.measurements).map(([k, v]) => [k, v.value]));
		for (const [k, v] of Object.entries(m)) if (v === null) throw new Error(`corner ${corner}: ${k} not measured`);

		const check = crossCheck(readFileSync(join(dir, "work", "ac.txt"), "utf8"));
		const diffs = {
			gain_db: Math.abs(check.gain_db - m.gain_db),
			ugf_rel: Math.abs(check.ugf_hz / m.ugf_hz - 1),
			pm_deg: Math.abs(check.pm_deg - m.pm_deg),
		};
		const agrees = diffs.gain_db < 0.01 && diffs.ugf_rel < 0.005 && diffs.pm_deg < 0.5;
		console.log(`${corner}: ${JSON.stringify(m)}  cross-check ${agrees ? "agrees" : "DISAGREES"} ${JSON.stringify(diffs)}`);
		if (!agrees) throw new Error(`corner ${corner}: meas and cross-check disagree`);

		corners[corner] = { experiment: id, values: m, cross_check: check };
		provenance ??= {
			image_id: experiment.environment.image_id ?? null,
			ngspice: result.tool.version,
			pdk_commit: result.tool.pdk?.commit ?? null,
			design_files: result.input_files.files.filter((f) => f.role !== "model"),
		};
	}

	// Variant for part 2 of the task: Cc = 1.5 pF, corner tt, in a separate copy of the design.
	const variantWork = join(here, "work", "reference-cc1p5");
	rmSync(variantWork, { recursive: true, force: true });
	mkdirSync(variantWork, { recursive: true });
	for (const f of ["tb_ota.spice", "simra.config.json", "simra.local.json", "reference.spice"]) {
		if (existsSync(join(work, f))) copyFileSync(join(work, f), join(variantWork, f));
	}
	const ota = readFileSync(join(work, "ota.spice"), "utf8");
	const variantOta = ota.replace(/^Cc z out 1p$/m, "Cc z out 1.5p");
	if (variantOta === ota) throw new Error("ota.spice: Cc line not found");
	writeFileSync(join(variantWork, "ota.spice"), variantOta);
	const v = await runExperiment({
		root: variantWork,
		adapter: "ngspice",
		operation: "simulate",
		environment,
		purpose: "reference values, corner tt, Cc = 1.5 pF",
		inputs: { deck: "reference.spice", libs: [{ path: CORNER_LIB, section: "mos_tt" }], measurements: MEASUREMENTS },
	});
	if (v.result.status !== "completed") throw new Error(`variant: ${v.result.status} ${v.result.errors.join("; ")}`);
	const vm = Object.fromEntries(Object.entries(v.result.measurements).map(([k, x]) => [k, x.value]));
	const vcheck = crossCheck(readFileSync(join(v.dir, "work", "ac.txt"), "utf8"));
	console.log(`tt, Cc = 1.5 pF: ${JSON.stringify(vm)}  cross-check ${JSON.stringify(vcheck)}`);
	if (Math.abs(vcheck.pm_deg - vm.pm_deg) > 0.5) throw new Error("variant: meas and cross-check disagree");
	const variants = {
		tt_cc1p5: {
			corner: "tt",
			change: "ota.spice: Cc z out 1p -> 1.5p",
			ota_sha256: v.result.input_files.files.find((f) => f.path === "ota.spice").sha256,
			experiment: v.id,
			values: vm,
			cross_check: vcheck,
		},
	};

	const expected = {
		task: "ota-corners",
		generated_by: "evals/ota-corners/reference.mjs",
		provenance,
		// An answer is correct when it is within these limits of the reference value.
		tolerance: { gain_db: { abs: 0.5 }, ugf_hz: { rel: 0.05 }, pm_deg: { abs: 2 }, vn_1k_nv: { rel: 0.1 } },
		corners,
		variants,
	};
	writeFileSync(join(here, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
	console.log("wrote evals/ota-corners/expected.json");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
