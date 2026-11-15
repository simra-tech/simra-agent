// Scorer and agent consistency: the reference design of a task goes through the check path of the agent (runCheck in
// a workspace made of the task files, as the check tool of the agent runs it) and through the verify function of the
// task scorer. The test fails on any difference of the row set, a row status or a row value.
//
// The reference designs are not part of this repository. The test runs only with SIMRA_TEST_REFERENCES, a directory
// with one subdirectory per task:
//   det-cell-sg13g2/det_cell.spice
//   det-cell-sg13g2-hard/det_cell.spice and tap.gds
//   lna-sg13g2/lna_core.spice and em/<network>.s3p (see evals/lna-sg13g2/reference.mjs)
// The task files simra.local.json must name an environment image with the PDK. A task without its reference
// directory is reported as skipped: that check did not run.

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheck } from "@simra-tech/kernel";

const REFS = process.env.SIMRA_TEST_REFERENCES;
const evals = resolve(new URL("../evals", import.meta.url).pathname);

/** The workspace files of a task, as the arm gives them to the agent. */
function taskWorkspace(task, ws) {
	const dir = join(evals, task);
	const t = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
	mkdirSync(ws, { recursive: true });
	for (const [to, from] of Object.entries(t.files ?? {})) if (existsSync(join(dir, from))) copyFileSync(join(dir, from), join(ws, to));
}

/** Rows of the agent check path: {"condition requirement": {value, status}}. */
async function agentRows(ws) {
	const { verdict } = await runCheck({ root: ws, parallel: 5 });
	return Object.fromEntries(verdict.rows.map((r) => [`${r.condition} ${r.requirement}`, { value: r.value ?? null, status: r.status }]));
}

function compare(agent, scorer) {
	const diffs = [];
	const keys = new Set([...Object.keys(agent), ...Object.keys(scorer)]);
	for (const k of keys) {
		const a = agent[k];
		const s = scorer[k];
		if (!a || !s) diffs.push(`${k}: only in the ${a ? "agent check" : "scorer"}`);
		else if (a.status !== s.status) diffs.push(`${k}: status ${a.status} (agent) against ${s.status} (scorer)`);
		else if (a.value !== s.value && !(typeof a.value === "number" && typeof s.value === "number" && Math.abs(a.value - s.value) <= 1e-9 * Math.max(Math.abs(a.value), Math.abs(s.value))))
			diffs.push(`${k}: value ${a.value} (agent) against ${s.value} (scorer)`);
	}
	return diffs;
}

const scorerRows = (v) => Object.fromEntries(Object.entries(v.rows).map(([k, r]) => [k, { value: r.value, status: r.status }]));

function setup(t, task, files) {
	const ref = REFS && join(REFS, task);
	const missing = !REFS ? "SIMRA_TEST_REFERENCES is not set" : files.find((f) => !existsSync(join(ref, f)));
	if (missing) {
		t.skip(typeof missing === "string" && !REFS ? missing : `no ${missing} for ${task}`);
		return null;
	}
	const base = mkdtempSync(join(realpathSync(tmpdir()), `simra-consistency-${task}-`));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	return { ref, ws: join(base, "ws"), verify: join(base, "verify") };
}

test("det-cell-sg13g2: the agent check and the scorer give the same rows for the reference", { timeout: 3_600_000 }, async (t) => {
	const s = setup(t, "det-cell-sg13g2", ["det_cell.spice"]);
	if (!s) return;
	const text = readFileSync(join(s.ref, "det_cell.spice"), "utf8");
	taskWorkspace("det-cell-sg13g2", s.ws);
	writeFileSync(join(s.ws, "det_cell.spice"), text);
	const { verify } = await import("../evals/det-cell-sg13g2/score.mjs");
	const diffs = compare(await agentRows(s.ws), scorerRows(await verify(join(evals, "det-cell-sg13g2"), text, s.verify)));
	assert.deepEqual(diffs, []);
});

test("det-cell-sg13g2-hard: the agent check and the scorer give the same rows for the reference", { timeout: 7_200_000 }, async (t) => {
	const s = setup(t, "det-cell-sg13g2-hard", ["det_cell.spice", "tap.gds"]);
	if (!s) return;
	const text = readFileSync(join(s.ref, "det_cell.spice"), "utf8");
	taskWorkspace("det-cell-sg13g2-hard", s.ws);
	writeFileSync(join(s.ws, "det_cell.spice"), text);
	copyFileSync(join(s.ref, "tap.gds"), join(s.ws, "tap.gds"));
	const { verify } = await import("../evals/det-cell-sg13g2-hard/score.mjs");
	const diffs = compare(await agentRows(s.ws), scorerRows(await verify(join(evals, "det-cell-sg13g2-hard"), text, s.verify, join(s.ref, "tap.gds"))));
	assert.deepEqual(diffs, []);
});

test("lna-sg13g2: the agent check and the scorer give the same rows for the reference (fit records in the workspace)", { timeout: 7_200_000 }, async (t) => {
	const s = setup(t, "lna-sg13g2", ["lna_core.spice", "em/lna_IN.s3p"]);
	if (!s) return;
	const { buildReference } = await import("../evals/lna-sg13g2/reference.mjs");
	await buildReference(s.ref, s.ws);
	// the workspace of an agent has the requirements of the task unchanged (em_passives_min 1)
	copyFileSync(join(evals, "lna-sg13g2", "requirements.json"), join(s.ws, "requirements.json"));
	const text = readFileSync(join(s.ws, "lna.spice"), "utf8");
	const agent = await agentRows(s.ws);
	const { verify } = await import("../evals/lna-sg13g2/score.mjs");
	const diffs = compare(agent, scorerRows(await verify(join(evals, "lna-sg13g2"), text, s.verify, 5, s.ws)));
	assert.deepEqual(diffs, []);
	// the reference passes the netlist gate apart from the EM-record rule
	const gate = Object.entries(agent).find(([k]) => k.includes("gate netlist"));
	assert.ok(gate, "a netlist gate row");
});
