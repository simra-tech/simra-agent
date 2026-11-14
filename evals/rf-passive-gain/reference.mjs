// Reference values for the rf-passive-gain task.
//
// 1. Copy match.s2p and amp.cir into evals/rf-passive-gain/work/reference (not tracked).
// 2. Run the touchstone adapter (fit_to_spice) on match.s2p, for the band of the deck (0.25 to 30 GHz; the data has
//    a DC point), with the re-simulation in ngspice and Xyce. Copy the subcircuit to match.lib.
// 3. Check requirements.json with the kernel: the xyce adapter (simulate) runs amp.cir with its .LIN analysis; the
//    rows read the Touchstone output: |S21| at f0 (kind s_db) and mu over the band (kind mu).
// 4. Cross-check |S21| at f0 against a nodal analysis of the deck with the closed-form network (network.mjs),
//    which uses no simulator and no fit.
// 5. Write expected.json: the value, the tolerance, the trap values and the provenance.
//
// Usage: [SIMRA_LOCAL_JSON=<file>] node evals/rf-passive-gain/reference.mjs [environment]   (default environment: eda; the environment needs
// Xyce, ngspice and python3 with numpy)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTouchstone, runCheck, runExperiment, sDb } from "@simra-tech/kernel";
import { ampS21, db, F0, networkY, NETWORK } from "./network.mjs";

const here = new URL(".", import.meta.url).pathname;
const work = join(here, "work", "reference");
const environment = process.argv[2] ?? "eda";
const BAND = [0.25e9, 30e9];

export const TOLERANCE_DB = 0.1;

/** The trap values: the gain without the network, and with the lossless network (R = 0). */
export function traps() {
	return {
		without_network: db(ampS21(F0, false)),
		lossless_network: db(ampS21(F0, (f) => networkY(f, { ...NETWORK, r: 1e-9 }))),
	};
}

async function main() {
	if (existsSync(work)) rmSync(work, { recursive: true });
	mkdirSync(work, { recursive: true });
	for (const f of ["match.s2p", "amp.cir"]) copyFileSync(join(here, f), join(work, f));
	// SIMRA_LOCAL_JSON: an optional machine file (image, CPU set) in place of the one of the example.
	for (const f of ["simra.config.json", "simra.local.json"]) {
		const src = f === "simra.local.json" && process.env.SIMRA_LOCAL_JSON ? process.env.SIMRA_LOCAL_JSON : join(here, "../../examples/ota-sg13g2", f);
		if (existsSync(src)) copyFileSync(src, join(work, f));
	}
	const fit = await runExperiment({ root: work, adapter: "touchstone", operation: "fit_to_spice", environment, purpose: "reference: model of match.s2p",
		inputs: { touchstone: "match.s2p", uses: { band_hz: BAND } } });
	if (fit.result.status !== "completed") throw new Error(`fit_to_spice: ${JSON.stringify(fit.result.diagnostics)}`);
	const lib = fit.result.outputs.find((o) => o.role === "subckt").path;
	copyFileSync(join(work, lib), join(work, "match.lib"));
	writeFileSync(join(work, "requirements.json"), JSON.stringify({
		schema: "simra.requirements/0",
		conditions: {},
		experiments: { amp: { adapter: "xyce", operation: "simulate", environment, inputs: { deck: "amp.cir" } } },
		requirements: [
			{ id: "gain_f0", experiment: "amp", kind: "s_db", entry: [2, 1], band_hz: [F0, F0], op: ">=", limit: 14, unit: "dB" },
			{ id: "stable", experiment: "amp", kind: "mu", band_hz: BAND, op: ">=", limit: 1 },
		],
	}, null, 2));
	const { id: check, verdict } = await runCheck({ root: work });
	const gainRow = verdict.rows.find((r) => r.requirement === "gain_f0");
	const muRow = verdict.rows.find((r) => r.requirement === "stable");
	if (gainRow.value === null) throw new Error(`no gain: ${gainRow.reason}`);
	// The same value read directly from the Touchstone output of the run.
	const amp = JSON.parse(readFileSync(join(work, "simra/experiments", gainRow.experiment, "result.json"), "utf8"));
	const ts = amp.outputs.find((o) => o.role === "touchstone");
	const data = readTouchstone(join(work, ts.path));
	const k = data.f.findIndex((f) => Math.abs(f - F0) < 1);
	const closed = db(ampS21(F0));
	const m = fit.result.measurements;
	const expected = {
		f0_hz: F0,
		gain_db: gainRow.value,
		tolerance: { gain_db: { abs: TOLERANCE_DB } },
		cross_check: { closed_form_gain_db: closed, difference_db: gainRow.value - closed, touchstone_gain_db: sDb(data, k, 2, 1) },
		mu_min: { value: muRow.value, at_hz: muRow.at?.f_hz ?? null, status: muRow.status },
		traps: traps(),
		fit: { experiment: fit.id, order: m.order.value, fit_max_abs_ds: m.fit_max_abs_ds.value, passivity_margin: m.passivity_margin.value,
			verify_ngspice_max_abs_ds: m.verify_ngspice_max_abs_ds.value, verify_xyce_max_abs_ds: m.verify_xyce_max_abs_ds.value },
		provenance: {
			numbers: "simulated: Xyce .LIN of amp.cir with the fitted subcircuit; the cross-check is a closed-form nodal analysis",
			check: check,
			check_status: verdict.status,
			fit_tool: fit.result.tool,
			amp_tool: amp.tool,
			// The image ID identifies the environment; the image name and the CPU set are machine facts.
			environment: (({ image, cpus, ...rest }) => rest)(fit.experiment.environment),
			date: new Date().toISOString().slice(0, 10),
		},
	};
	if (Math.abs(expected.cross_check.difference_db) > 0.05) throw new Error(`cross-check differs by ${expected.cross_check.difference_db} dB`);
	writeFileSync(join(here, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
	console.log(JSON.stringify({ gain_db: expected.gain_db, cross_check: expected.cross_check, mu_min: expected.mu_min, traps: expected.traps, fit: expected.fit }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
