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

// A reported row (requirement.reported): the value is checked against the verified run, it gives no requirement point,
// and its failure does not change meets_spec.
import { score as vcoScore } from "../evals/vco-sg13g2/score.mjs";

test("vco-sg13g2 scorer: the reported row pn_dev at slow_hot is checked for its value and not scored", async (t) => {
	const req = JSON.parse(readFileSync(new URL("../evals/vco-sg13g2/requirements.json", import.meta.url), "utf8"));
	const pn = req.requirements.find((r) => r.id === "pn_dev");
	assert.deepEqual([pn.conditions, pn.reported.conditions], [["tt"], ["slow_hot"]]);
	const dir = mkdtempSync(join(tmpdir(), "simra-rfscore-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const ws = join(dir, "ws");
	mkdirSync(ws);
	writeFileSync(join(ws, "vco.spice"), ".subckt x a b\n.ends\n");
	const scored = req.requirements.flatMap((r) => r.conditions.map((c) => `${c} ${r.id}`));
	const rows = Object.fromEntries(scored.map((k) => [k, { value: 1, pass: true, status: "pass" }]));
	rows["slow_hot pn_dev"] = { value: -78.32, pass: false, status: "fail", reported: true };
	const verifier = async () => ({ rows });
	const answerRows = (v) => [...scored.map((k) => ({ corner: k.split(" ")[0], requirement: k.split(" ")[1], value: 1 })), { corner: "slow_hot", requirement: "pn_dev", value: v }];
	writeFileSync(join(ws, "answer.json"), JSON.stringify({ meets_spec: true, rows: answerRows(-78.4) }));
	let s = await vcoScore(ws, { rows: {}, reported: { "slow_hot pn_dev": -78.32 } }, ws, { verifier });
	assert.equal(s.rows["slow_hot pn_dev"].scored, false);
	assert.equal(s.rows["slow_hot pn_dev"].value, true, "within 0.5 dB");
	assert.equal(s.rows["slow_hot pn_dev"].reference, -78.32);
	assert.ok(!s.missed.includes("slow_hot pn_dev") && !s.closed.includes("slow_hot pn_dev"));
	assert.equal(s.max.values, scored.length + 1);
	assert.equal(s.max.requirements, scored.length);
	assert.equal(s.verified_meets_spec, false, "design and EM points are 0 with the stub design");
	writeFileSync(join(ws, "answer.json"), JSON.stringify({ meets_spec: true, rows: answerRows(-83.5) }));
	s = await vcoScore(ws, { rows: {} }, ws, { verifier });
	assert.equal(s.rows["slow_hot pn_dev"].value, false, "a reported value that does not agree loses its value point");
	assert.equal(s.rows["slow_hot pn_dev"].reported, -83.5);
});
