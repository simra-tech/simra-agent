// Reference results for a comparator-synthesis task. They show that the task is correct, that it has a solution,
// that the bench finds a design that fails, and that the score does not give requirement points to a design that
// breaks the design rules.
//
// 1. reference: a two-stage comparator (REFERENCES). The design part must pass and every row must pass. It is the
//    known answer, and its worst values set the limits (LIMIT_FACTOR).
// 2. known_fail: the reference with one change, the tail current source at half its width (KNOWN_FAIL). The
//    design part must pass, and at least 2 rows must fail at one corner.
// 3. cheat: a behavioural source (B) with a small positive feedback, an output resistor and a bias resistor to
//    node 0, with the pins of the spec. The design part must fail with two errors (the B element and node 0), and
//    every row of the simulation must pass. The score with a correct answer gives 0 design and 0 requirement
//    points.
// 4. input_load: a design with a resistive divider on each input (INPUT_LOAD). The input sources of the bench supply
//    the current of the dividers. The design part must pass, iin_a must fail at every corner, and every other row
//    must pass. It shows that iin_a finds a design that takes its current from the inputs.
// 5. Each limit of the reference (the delays, the supply current and the area) is at least LIMIT_FACTOR times
//    the worst value of the reference.
// 6. Write expected.json in the task directory: the results of the four designs, the limit margins and the input
//    current (the iin_a limit, the worst iin_a of the reference and the least iin_a of input_load).
//
// The designs run one after the other: each runs its corners in parallel, and more parallel runs only slow
// ngspice down.
//
// Usage: node evals/comparator-synthesis/reference.mjs <sg13cmos5l|sky130> [environment]   (default environment: eda)

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inputCurrent, answerOf as synthesisAnswer, summary } from "../ota-synthesis/reference.mjs";
import { loadTask, METRICS, scoreComparator, TOLERANCE, verify } from "./synthesis.mjs";

const here = new URL(".", import.meta.url).pathname;

/** The limits of spec.md are at least this factor times the worst value of the reference. */
export const LIMIT_FACTOR = 1.3;

/**
 * The reference designs. An NMOS differential pair with a PMOS current-mirror load, a PMOS common-source second
 * stage with an NMOS current sink, and a CMOS inverter at the output. XM0 is the bias diode. XM6 is two times XM4
 * and its sink is two times the half tail current, thus the systematic offset is near zero.
 */
export const REFERENCES = {
	sg13cmos5l: `* comparator-synthesis reference: two stages and an output inverter.
.subckt cmp inp inn out vdd vss ibias
XM0 ibias ibias vss vss sg13_lv_nmos w=2u l=1u
XM5 tail ibias vss vss sg13_lv_nmos w=4u l=1u
XM1 x inp tail vss sg13_lv_nmos w=16u l=0.25u
XM2 y inn tail vss sg13_lv_nmos w=16u l=0.25u
XM3 x x vdd vdd sg13_lv_pmos w=2u l=0.25u
XM4 y x vdd vdd sg13_lv_pmos w=2u l=0.25u
XM6 z y vdd vdd sg13_lv_pmos w=4u l=0.25u
XM7 z ibias vss vss sg13_lv_nmos w=4u l=1u
XM8 out z vdd vdd sg13_lv_pmos w=2u l=0.13u
XM9 out z vss vss sg13_lv_nmos w=1u l=0.13u
.ends cmp
`,
	sky130: `* comparator-synthesis reference: two stages and an output inverter.
.subckt cmp inp inn out vdd vss ibias
XM0 ibias ibias vss vss sky130_fd_pr__nfet_01v8 w=2 l=1
XM5 tail ibias vss vss sky130_fd_pr__nfet_01v8 w=4 l=1
XM1 x inp tail vss sky130_fd_pr__nfet_01v8_lvt w=8 l=0.5
XM2 y inn tail vss sky130_fd_pr__nfet_01v8_lvt w=8 l=0.5
XM3 x x vdd vdd sky130_fd_pr__pfet_01v8 w=4 l=0.25
XM4 y x vdd vdd sky130_fd_pr__pfet_01v8 w=4 l=0.25
XM6 z y vdd vdd sky130_fd_pr__pfet_01v8 w=8 l=0.25
XM7 z ibias vss vss sky130_fd_pr__nfet_01v8 w=4 l=1
XM8 out z vdd vdd sky130_fd_pr__pfet_01v8 w=2 l=0.15
XM9 out z vss vss sky130_fd_pr__nfet_01v8 w=1 l=0.15
.ends cmp
`,
};

/** The one change of the known fail: the new W of the tail current source XM5 (half of the reference). */
export const KNOWN_FAIL = { sg13cmos5l: "2u", sky130: "2" };

/**
 * The cheat. An ideal comparator: a tanh of the differential input (gain 1e4 / 2 at the threshold) with 1 mV of
 * positive feedback from out, a 1 kΩ output resistor, and a bias resistor to node 0. The simulation meets every
 * requirement, but the design rules forbid B and node 0.
 */
export const CHEAT = `* A design that breaks the rules: a behavioural source as the comparator.
.subckt cmp inp inn out vdd vss ibias
B1 a vss V=v(vdd)*(1+tanh(1e4*(v(inp)-v(inn)+1m*(2*v(out)/v(vdd)-1))))/2
Ro a out 1k
Rb ibias 0 10k
.ends cmp
`;

/**
 * A design with a resistive divider on each input: inp - 1k - gp - 30k - vss, and the same from inn to gn. The MOS
 * gates that were on inp and inn go to gp and gn. The input sources then supply tens of µA, and the gates see 30/31
 * of the input voltage.
 */
export function inputDivider(text) {
	const divider = ["Rip inp gp 1k", "Rgp gp vss 30k", "Rin inn gn 1k", "Rgn gn vss 30k"];
	const lines = text.split("\n").map((l) => (/^X/i.test(l) ? l.replace(/\binp\b/g, "gp").replace(/\binn\b/g, "gn") : l));
	const at = lines.findIndex((l) => /^\.subckt\s/i.test(l)) + 1;
	return [...lines.slice(0, at), ...divider, ...lines.slice(at)].join("\n");
}

/**
 * The input-load designs. sg13cmos5l: a design of an agent run that passed every row of the bench before iin_a,
 * with a 1k / 3k divider to vss on each input. sky130: the reference with a 1k / 30k divider (inputDivider).
 */
export const INPUT_LOAD = {
	sg13cmos5l: `.subckt cmp inp inn out vdd vss ibias
Rip inp gp 1k
Rgp gp vss 3k
Rin inn gn 1k
Rgn gn vss 3k
Xbn ibias ibias vss vss sg13_lv_nmos w=2u l=0.5u
Xbp bp ibias vss vss sg13_lv_nmos w=2u l=0.5u
Xpr bp bp vdd vdd sg13_lv_pmos w=4u l=0.5u
Xtail tail bp vdd vdd sg13_lv_pmos w=8u l=0.5u
Xip a gp tail tail sg13_lv_pmos w=6u l=0.2u
Xin b gn tail tail sg13_lv_pmos w=6u l=0.2u
Xnd b b vss vss sg13_lv_nmos w=1u l=0.25u
Xnm a b vss vss sg13_lv_nmos w=1u l=0.25u
Xp1 c bp vdd vdd sg13_lv_pmos w=4u l=0.5u
Xn1 c a vss vss sg13_lv_nmos w=1u l=0.25u
Xp2 d c vdd vdd sg13_lv_pmos w=2u l=0.13u
Xn2 d c vss vss sg13_lv_nmos w=1u l=0.13u
Xp3 out d vdd vdd sg13_lv_pmos w=4u l=0.13u
Xn3 out d vss vss sg13_lv_nmos w=2u l=0.13u
.ends cmp
`,
	sky130: inputDivider(REFERENCES.sky130),
};

/** The four reference designs of a task: { reference, known_fail, cheat, input_load } (netlist texts). */
export function designs(name) {
	const reference = REFERENCES[name];
	const known_fail = reference.replace(/^(XM5\s.*\bw=)\S+/m, `$1${KNOWN_FAIL[name]}`);
	return { reference, known_fail, cheat: CHEAT, input_load: INPUT_LOAD[name] };
}

/** An answer with the verified worst values of a result. */
export const answerOf = (result, meets = result.meets_spec) => synthesisAnswer(result, meets, METRICS);

/** The limits of the reference, with the worst value of the reference and the factor limit / worst. */
function margins(spec, reference) {
	const worst = (m) => Math.max(...Object.values(reference.corners).map((c) => c.worst[m].value));
	const out = Object.fromEntries(["tpd_r_s", "tpd_f_s", "idd_a"].map((m) => [m, { limit: spec.limits[m].value, worst: worst(m) }]));
	out.area_um2 = { limit: spec.design.area_um2, worst: reference.design_check.area_um2 };
	for (const v of Object.values(out)) v.factor = Number((v.limit / v.worst).toFixed(3));
	return out;
}

async function main() {
	const name = process.argv[2];
	if (!REFERENCES[name]) {
		console.error(`usage: node evals/comparator-synthesis/reference.mjs <${Object.keys(REFERENCES).join("|")}> [environment]`);
		process.exit(2);
	}
	const taskDir = join(here, name);
	const environment = process.argv[3];
	const work = join(here, "work", name);
	const { task, spec } = loadTask(taskDir);

	const runs = {};
	for (const [k, d] of Object.entries(designs(name))) runs[k] = await verify(taskDir, d, join(work, k), environment);
	const result = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, summary(v, METRICS)]));
	for (const [k, r] of Object.entries(result)) {
		const worst = Object.entries(r.corners).map(([c, v]) => `${c} ${METRICS.map((m) => `${m} ${v.worst[m].value} @${v.worst[m].vcm}`).join(", ")}`);
		console.log(`${k}: design ${r.design_check.status}, area ${r.design_check.area_um2} µm² (gate ${r.design_check.gate_area_um2}), rows pass ${r.rows_pass}, meets_spec ${r.meets_spec}\n  ${worst.join("\n  ")}`);
	}
	const { reference, known_fail, cheat, input_load } = result;
	if (!reference.meets_spec) throw new Error(`the reference does not meet the spec: ${JSON.stringify(reference.design_check.errors)}`);
	if (known_fail.design_check.status !== "pass") throw new Error(`the known fail fails the design check: ${JSON.stringify(known_fail.design_check.errors)}`);
	const failed = Object.values(known_fail.corners).map((v) => METRICS.filter((m) => !v.worst[m].pass).length);
	if (Math.max(...failed) < 2) throw new Error(`the known fail does not fail 2 rows at one corner: ${failed}`);

	// The cheat: the design part fails with the two expected errors, the simulation passes, and the score gives no
	// design and no requirement points, also with a correct answer.
	const messages = cheat.design_check.errors.map((e) => `${e.source}: ${e.message}`);
	const want = [/^cmp\.spice:3: B1: a behavioural source \(B\) is not allowed/, /^cmp\.spice:5: Rb: node 0 is the global ground/];
	if (cheat.design_check.status !== "fail" || messages.length !== want.length || !want.every((re, i) => re.test(messages[i]))) {
		throw new Error(`cheat: design check ${cheat.design_check.status}, errors ${JSON.stringify(messages)}`);
	}
	if (!cheat.rows_pass) throw new Error("cheat: the simulation does not meet the requirements, so the cheat proves nothing");
	const ws = mkdtempSync(join(work, "cheat-ws-"));
	writeFileSync(join(ws, "cmp.spice"), CHEAT);
	writeFileSync(join(ws, "answer.json"), JSON.stringify(answerOf(cheat, true)));
	const s = await scoreComparator(ws, taskDir, { verifier: async () => runs.cheat });
	rmSync(ws, { recursive: true, force: true });
	const cheat_score = { design: s.design, requirements: s.requirements, claim: s.claim, values: s.values };
	if (s.design !== 0 || s.requirements !== 0 || s.verified_meets_spec) throw new Error(`cheat: score ${JSON.stringify(cheat_score)}`);

	const limit_margins = margins(spec, reference);
	const low = Object.entries(limit_margins).filter(([, v]) => v.factor < LIMIT_FACTOR);
	if (low.length) throw new Error(`limits below ${LIMIT_FACTOR} times the reference: ${JSON.stringify(Object.fromEntries(low))}`);

	const input_current = inputCurrent(spec, reference, input_load, METRICS);

	const expected = {
		task: task.name,
		generated_by: "evals/comparator-synthesis/reference.mjs",
		provenance: runs.reference.tt.provenance,
		spec,
		tolerance: TOLERANCE,
		limit_margins,
		reference,
		known_fail,
		cheat,
		cheat_score: { answer: "the verified worst values, meets_spec true", ...cheat_score },
		input_load,
		input_current,
	};
	writeFileSync(join(taskDir, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
	console.log(`limit margins ${JSON.stringify(limit_margins)}\ncheat: score ${JSON.stringify(cheat_score)}\ninput current ${JSON.stringify(input_current)}\nwrote evals/comparator-synthesis/${name}/expected.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
