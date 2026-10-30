// Shared parts of the ota-synthesis tasks (one task directory for each PDK).
//
// The agent gets a pin specification (spec.md), the bench verify.spice and requirements.json, and no netlist. It
// writes the OTA in ota.spice; the topology is free. The scorer does not trust the answer: it runs the check of
// requirements.json on the final ota.spice through the kernel (the verify() of ../ota-sizing/sizing.mjs). The
// check lints ota.spice against the design section of requirements.json (the design part of the verdict) and
// simulates it with the bench at each corner and at each VCM of the range. scoreSynthesis() takes the corners, the
// metrics and the design file from requirements.json, so other synthesis tasks (comparator-synthesis) use it too.
//
// Score:
// - design (2): the design part of the verdict passes (the contract, the element rules and the limits).
// - requirements (12): for each corner and requirement, the verified worst value passes. Given only when the
//   design part passes.
// - claim (4): meets_spec is the same as the verification (the design part and all requirements).
// - values (12): for each row, the reported worst value is within the tolerance of the verified worst value.
//
// Diagnostics (no points): area_um2 and mos_count of the design part, design_errors, supported (rows whose value
// appears in a workspace file other than answer.json and ota.spice), verification (the experiments, the sweep
// points and the worst values with provenance), errors.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { numbersIn, readTexts, shown, within } from "../ota-corners/score.mjs";
import { METRICS, metricsOf, parseConditions, TOLERANCE, taskRequirements, verify } from "../ota-sizing/sizing.mjs";

export { METRICS, TOLERANCE, verify };

/** The conditions, corners, requirements (the ids metrics) and design rules of spec.md. */
export function parseSpec(text, metrics = METRICS) {
	const pins = text.match(/The \w+ is the subcircuit `(\w+)` in `([\w.]+)`, with the pins `([\w ]+)`, in this order\./);
	const models = text.match(/^\s*1\. MOS devices of the model library of the corner: ((?:`\w+`,?\s*)+)\./m);
	const area = text.match(/sum of W × L over the MOS devices is <= ([\d.]+) µm²/);
	const r = text.match(/Ideal resistors \(R\): each resistor is <= ([\d.]+) MΩ\./);
	const c = text.match(/Ideal capacitors \(C\): each capacitor is <= ([\d.]+) pF\./);
	if (!pins || !models || !area || !r || !c) throw new Error("spec.md: pins, devices or design limits not found");
	return {
		...parseConditions(text, metrics),
		design: {
			file: pins[2],
			subckt: pins[1],
			pins: pins[3].split(" "),
			devices: [...models[1].matchAll(/`(\w+)`/g)].map((m) => m[1]),
			area_um2: Number(area[1]),
			r_ohm: Number(r[1]) * 1e6,
			c_f: Number(c[1]) * 1e-12,
		},
	};
}

/** The task data: task.json and spec.md of a task directory. */
export function loadTask(taskDir) {
	const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
	const spec = parseSpec(readFileSync(join(taskDir, "spec.md"), "utf8"));
	return { task, spec };
}

/**
 * Score a workspace of a synthesis task. The verification goes to verifyRoot (default: next to ws). A test can
 * give its own verifier, with the arguments of verify. The corners, the metrics (the requirement ids) and the
 * design file come from requirements.json of the task; tolerance gives the value tolerance of each metric
 * (default: the OTA tolerance), and file (optional) replaces the design file name.
 */
export async function scoreSynthesis(ws, taskDir, { verifyRoot = join(dirname(ws), "verify"), verifier = verify, tolerance = TOLERANCE, file } = {}) {
	const requirements = taskRequirements(taskDir);
	const metrics = metricsOf(requirements);
	const corners = Object.keys(requirements.conditions);
	const designFile = file ?? requirements.design.file;
	const rowCount = corners.length * metrics.length;
	const report = {
		workspace: ws,
		design: 0,
		requirements: 0,
		claim: 0,
		values: 0,
		max: { design: 2, requirements: rowCount, claim: 4, values: rowCount },
		meets_spec: null,
		verified_meets_spec: false,
		design_status: "not_run",
		area_um2: null,
		mos_count: null,
		design_errors: [],
		rows: {},
		supported: 0,
		verification: null,
		errors: [],
	};
	const designPath = join(ws, designFile);
	if (!existsSync(designPath)) report.errors.push(`${designFile} not found`);
	else {
		report.verification = await verifier(taskDir, readFileSync(designPath, "utf8"), verifyRoot, undefined, undefined, { file: designFile, metrics });
		const d = report.verification.design;
		report.design_status = d.status;
		report.area_um2 = d.gate_area_um2;
		report.mos_count = d.mos_count;
		report.design_errors = d.errors;
		if (d.status === "pass") report.design = 2;
		else if (d.status === "fail") report.errors.push(...d.errors.map((e) => `${e.source}: ${e.message}`));
		else report.errors.push(`design check not run (experiment ${d.experiment ?? "none"})`);
	}

	let answer = null;
	const answerPath = join(ws, "answer.json");
	if (!existsSync(answerPath)) report.errors.push("answer.json not found");
	else {
		try {
			answer = JSON.parse(readFileSync(answerPath, "utf8"));
		} catch (err) {
			report.errors.push(`answer.json is not valid JSON: ${err.message}`);
		}
	}
	const evidence = numbersIn(
		readTexts(ws)
			.filter((f) => !["answer.json", designFile].includes(relative(ws, f.path)))
			.map((f) => f.text)
			.join("\n"),
	);
	const rows = Array.isArray(answer?.rows) ? answer.rows : [];
	const designPass = report.design === 2;
	let allPass = designPass;
	for (const corner of corners) {
		for (const m of metrics) {
			const key = `${corner} ${m}`;
			const v = report.verification?.[corner]?.worst[m] ?? { value: null, vcm: null, pass: false };
			const r = rows.find((x) => x?.corner === corner && x?.requirement === m);
			const s = { verified: v.value, verified_vcm: v.vcm, pass: v.pass, reported: r?.value ?? null, value: false, supported: false };
			report.rows[key] = s;
			allPass &&= v.pass;
			if (designPass) report.requirements += Number(v.pass);
			if (!r || v.value === null) continue;
			s.value = within(r.value, v.value, tolerance[m]);
			s.supported = shown(evidence, m, r.value);
			report.values += Number(s.value);
			report.supported += Number(s.supported);
		}
	}
	report.verified_meets_spec = allPass;
	report.meets_spec = typeof answer?.meets_spec === "boolean" ? answer.meets_spec : null;
	if (report.meets_spec === allPass) report.claim = 4;
	return report;
}

/** The command line of the score.mjs of a task directory: node <task>/score.mjs <workspace>. */
export async function scoreMain(taskDir, argv, options = {}) {
	if (!argv[2]) {
		console.error(`usage: node ${relative(process.cwd(), join(taskDir, "score.mjs"))} <workspace>`);
		process.exit(2);
	}
	console.log(JSON.stringify(await scoreSynthesis(resolve(argv[2]), taskDir, options), null, 2));
}
