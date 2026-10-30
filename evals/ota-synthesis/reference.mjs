// Reference results for an ota-synthesis task. They show that the task is correct, that it has a solution and
// that the score does not give requirement points to a design that breaks the design rules.
//
// 1. fix: the reference fix of ../ota-sizing (resize(original, FIXES[pdk])). The design part must pass and every
//    row must pass. It is the known answer.
// 2. original: the original OTA of ../ota-sizing. The design part must pass, and the rows that fail in ota-sizing
//    must fail here too.
// 3. cheat: an ideal voltage-controlled voltage source (E) with an RC output pole and a bias resistor, with the
//    pins of the spec. The design part must fail with two errors (the E element and node 0), and every row of
//    the simulation must pass. The score with a correct answer gives 0 design and 0 requirement points.
// The worst values of fix and original must be the same as in ../ota-sizing/<pdk>/expected.json: the bench, the
// requirements and the netlists are the same.
// 4. Write expected.json in the task directory: the results of the three designs.
//
// Usage: node evals/ota-synthesis/reference.mjs <sg13cmos5l|sky130> [environment]   (default environment: eda)

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXES, resize } from "../ota-sizing/reference.mjs";
import { within } from "../ota-corners/score.mjs";
import { loadTask, METRICS, scoreSynthesis, TOLERANCE, verify } from "./synthesis.mjs";

const here = new URL(".", import.meta.url).pathname;

/**
 * The cheat. An ideal amplifier (gain 1e4, 80 dB) with one pole (1 MΩ and the 2 pF of the bench plus 2 pF) and a
 * DC path for the bias current: the simulation meets every requirement, but the design rules forbid E and node 0.
 */
export const CHEAT = `* A design that breaks the rules: an ideal voltage-controlled voltage source as the amplifier.
.subckt ota inp inn out vdd vss ibias
E1 a 0 inp inn 1e4
Ro a out 1meg
Co out 0 2p
Rb ibias vss 10k
.ends ota
`;

/** The three reference designs of a task: { fix, original, cheat } (netlist texts). */
export function designs(name) {
	const original = readFileSync(join(here, "../ota-sizing", name, "ota.spice"), "utf8");
	return { fix: resize(original, FIXES[name]), original, cheat: CHEAT };
}

/** The results of one design: the design part, the worst values and whether it meets the spec. */
function summary({ design, ...corners }) {
	const rows_pass = Object.values(corners).every((v) => METRICS.every((m) => v.worst[m].pass));
	return {
		design_check: { status: design.status, errors: design.errors, gate_area_um2: design.gate_area_um2, mos_count: design.mos_count },
		rows_pass,
		meets_spec: design.status === "pass" && rows_pass,
		corners: Object.fromEntries(Object.entries(corners).map(([c, v]) => [c, { experiment: v.experiment, worst: v.worst, sweep: v.points }])),
	};
}

/** An answer with the verified worst values of a result. */
export const answerOf = (result, meets = result.meets_spec) => ({
	meets_spec: meets,
	area_um2: result.design_check.gate_area_um2,
	rows: Object.entries(result.corners).flatMap(([corner, v]) => METRICS.map((m) => ({ corner, requirement: m, value: v.worst[m].value, vcm: v.worst[m].vcm, pass: v.worst[m].pass }))),
});

async function main() {
	const name = process.argv[2];
	if (!FIXES[name]) {
		console.error(`usage: node evals/ota-synthesis/reference.mjs <${Object.keys(FIXES).join("|")}> [environment]`);
		process.exit(2);
	}
	const taskDir = join(here, name);
	const environment = process.argv[3];
	const work = join(here, "work", name);
	const { task, spec } = loadTask(taskDir);

	const runs = await Promise.all(Object.entries(designs(name)).map(async ([k, d]) => [k, await verify(taskDir, d, join(work, k), environment)]));
	const result = Object.fromEntries(runs.map(([k, v]) => [k, summary(v)]));
	for (const [k, r] of Object.entries(result)) {
		const worst = Object.entries(r.corners).map(([c, v]) => `${c} ${METRICS.map((m) => `${m} ${v.worst[m].value} @${v.worst[m].vcm}`).join(", ")}`);
		console.log(`${k}: design ${r.design_check.status}, area ${r.design_check.gate_area_um2} µm², rows pass ${r.rows_pass}, meets_spec ${r.meets_spec}\n  ${worst.join("\n  ")}`);
	}
	const { fix, original, cheat } = result;
	if (!fix.meets_spec) throw new Error(`the reference fix does not meet the spec: ${JSON.stringify(fix.design_check.errors)}`);
	if (original.design_check.status !== "pass") throw new Error(`the original fails the design check: ${JSON.stringify(original.design_check.errors)}`);
	if (original.meets_spec) throw new Error("the original meets the spec");

	// The same netlists, bench and requirements as ota-sizing: the same worst values.
	const sizing = JSON.parse(readFileSync(join(here, "../ota-sizing", name, "expected.json"), "utf8"));
	for (const k of ["fix", "original"]) {
		if (result[k].design_check.gate_area_um2 !== sizing[k].area_um2) throw new Error(`${k}: gate area ${result[k].design_check.gate_area_um2}, ota-sizing ${sizing[k].area_um2}`);
		for (const [corner, c] of Object.entries(sizing[k].corners)) {
			for (const m of METRICS) {
				const [a, b] = [result[k].corners[corner].worst[m], c.worst[m]];
				if (!within(a.value, b.value, { rel: 1e-4 }) || Math.abs(a.vcm - b.vcm) > 1e-6 || a.pass !== b.pass) {
					throw new Error(`${k} ${corner} ${m}: ${a.value} @${a.vcm} V (${a.pass}), ota-sizing ${b.value} @${b.vcm} V (${b.pass})`);
				}
			}
		}
	}

	// The cheat: the design part fails with the two expected errors, the simulation passes, and the score gives no
	// design and no requirement points, also with a correct answer.
	const messages = cheat.design_check.errors.map((e) => `${e.source}: ${e.message}`);
	const want = [/^ota\.spice:3: E1: a controlled source \(E\) is not allowed/, /^ota\.spice:5: Co: node 0 is the global ground/];
	if (cheat.design_check.status !== "fail" || messages.length !== want.length || !want.every((re, i) => re.test(messages[i]))) {
		throw new Error(`cheat: design check ${cheat.design_check.status}, errors ${JSON.stringify(messages)}`);
	}
	if (!cheat.rows_pass) throw new Error("cheat: the simulation does not meet the requirements, so the cheat proves nothing");
	const ws = mkdtempSync(join(work, "cheat-ws-"));
	writeFileSync(join(ws, "ota.spice"), CHEAT);
	writeFileSync(join(ws, "answer.json"), JSON.stringify(answerOf(cheat, true)));
	const cheatVerification = Object.fromEntries(runs).cheat;
	const s = await scoreSynthesis(ws, taskDir, { verifier: async () => cheatVerification });
	rmSync(ws, { recursive: true, force: true });
	const cheat_score = { design: s.design, requirements: s.requirements, claim: s.claim, values: s.values };
	if (s.design !== 0 || s.requirements !== 0 || s.verified_meets_spec) throw new Error(`cheat: score ${JSON.stringify(cheat_score)}`);

	const expected = {
		task: task.name,
		generated_by: "evals/ota-synthesis/reference.mjs",
		provenance: Object.fromEntries(runs).fix.tt.provenance,
		spec,
		tolerance: TOLERANCE,
		fix,
		original,
		cheat,
		cheat_score: { answer: "the verified worst values, meets_spec true", ...cheat_score },
		same_as: `evals/ota-sizing/${name}/expected.json: the same worst values, VCM and gate area for fix and original`,
	};
	writeFileSync(join(taskDir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
	console.log(`cheat: score ${JSON.stringify(cheat_score)}\nwrote evals/ota-synthesis/${name}/expected.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
