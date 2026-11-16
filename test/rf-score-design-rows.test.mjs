// The RF scorer (evals/rf-score.mjs) with a stub verifier: a "gate fit_band <network>" row of the reference names a
// network of the reference design. It must not count as a missed row of another design.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { score as lnaScore } from "../evals/lna-sg13g2/score.mjs";
import { score as paScore } from "../evals/pa-stage-sg13g2/score.mjs";

for (const [task, score, design] of [["lna-sg13g2", lnaScore, "lna.spice"], ["pa-stage-sg13g2", paScore, "pa_stage.spice"]])
test(`${task} scorer: reference fit_band rows do not apply to another design`, async (t) => {
	const expected = JSON.parse(readFileSync(new URL(`../evals/${task}/expected.json`, import.meta.url), "utf8"));
	const dir = mkdtempSync(join(tmpdir(), "simra-rfscore-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const ws = join(dir, "ws");
	mkdirSync(ws);
	writeFileSync(join(ws, design), ".subckt x a b\n.ends\n");
	writeFileSync(join(ws, "answer.json"), JSON.stringify({ meets_spec: true, rows: [] }));
	const refFitRows = Object.keys(expected.rows).filter((k) => / gate fit_band /.test(k));
	assert.ok(refFitRows.length > 0, "the reference has fit_band rows");
	const rows = {};
	for (const k of Object.keys(expected.rows)) if (!refFitRows.includes(k)) rows[k] = { value: 1, pass: true, status: "pass" };
	rows["null gate fit_band agent_line"] = { value: 0, pass: true, status: "pass" };
	const s = await score(ws, expected, ws, { verifier: async () => ({ rows }) });
	for (const k of refFitRows) assert.ok(!(k in s.rows), `${k} is a row of the reference design only`);
	assert.ok(s.closed.includes("null gate fit_band agent_line"));
	assert.ok(!s.missed.some((k) => / gate fit_band /.test(k)));
});
