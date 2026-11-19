// The scorers of the lna-sg13g2 and det-cell-sg13g2-hard pilot tasks, with a stub verifier (no simulator): the
// device rules, the EM passive found through the records, the gate rows and the rows without a condition.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { score as hardScore, rowKey } from "../evals/det-cell-sg13g2-hard/score.mjs";
import { checkDesign, copyFitRecords, emFits, paramTable, score as lnaScore, value } from "../evals/lna-sg13g2/score.mjs";

const FIT = ".subckt em_match p1 p1_ref p2 p2_ref\nvsense1 p1 s1 0\ngport1 s1 p1_ref s1 p1_ref 0.02\ngr1_1_1 p1_ref s1 x1_1 0 1e3\ncx1_1 x1_1 0 1e-12\n.ends em_match\n";
const LNA = (fit) =>
	`.subckt lna rfin rfout vcc18 iref1 iref2 iref3\nxq1 c1 b1 0 0 npn13G2 Nx=4 sw_nqs=1\nxm rfin 0 b1 0 em_match\nxl c1 rfout tm2_w13 len=200e-6\nxc rfout 0 cap_cmim w=2u l=2u\n.ends\n${fit}`;
const sha = (text) => createHash("sha256").update(text).digest("hex");

function record(ws, id, adapter, operation, result) {
	const dir = join(ws, "simra", "experiments", id);
	mkdirSync(join(dir, "work"), { recursive: true });
	writeFileSync(join(dir, "experiment.json"), JSON.stringify({ id, adapter: { name: adapter }, operation, inputs: {} }));
	writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "completed", outputs: [], input_files: null, ...result }));
	return dir;
}

function workspace(t) {
	const ws = join(mkdtempSync(join(tmpdir(), "simra-step6-")), "ws");
	mkdirSync(ws);
	t.after(() => rmSync(join(ws, ".."), { recursive: true, force: true }));
	return ws;
}

test("lna scorer: a fit counts only when its Touchstone input is an openEMS output", (t) => {
	const ws = workspace(t);
	const s2p = "# Hz S RI R 50\n1e9 0 0 1 0 1 0 0 0\n";
	record(ws, "e1", "openems", "merge", { outputs: [{ path: "simra/experiments/e1/work/m.s2p", sha256: sha(s2p), role: "touchstone" }] });
	const fitDir = record(ws, "e2", "touchstone", "fit_to_spice", {
		input_files: { files: [{ path: "m.s2p", sha256: sha(s2p) }], complete: true },
		outputs: [{ path: "simra/experiments/e2/work/em_match.lib", sha256: sha(FIT), role: "subckt" }],
	});
	writeFileSync(join(fitDir, "work", "em_match.lib"), FIT);
	const other = FIT.replace(/em_match/g, "other_fit");
	const otherDir = record(ws, "e3", "touchstone", "fit_to_spice", {
		input_files: { files: [{ path: "x.s2p", sha256: sha("other") }], complete: true },
		outputs: [{ path: "simra/experiments/e3/work/other.lib", sha256: sha(other), role: "subckt" }],
	});
	writeFileSync(join(otherDir, "work", "other.lib"), other);
	const fits = emFits(ws);
	assert.deepEqual(fits.found.map((f) => [f.name, f.fit, f.em]), [["em_match", "e2", "e1"], ["other_fit", "e3", null]]);
	// the verify root gets the fit and EM records with their outputs, so that the gates see the same fitted models
	const root = join(ws, "..", "verify");
	record(ws, "e4", "ngspice", "simulate", {});
	assert.equal(copyFitRecords(ws, root), 3);
	assert.deepEqual(emFits(root).found.map((f) => [f.name, f.fit, f.em]), [["em_match", "e2", "e1"], ["other_fit", "e3", null]]);
	assert.match(fits.refused[0].reason, /not the output of an openems record/);
	const ok = checkDesign(LNA(FIT), fits.found);
	assert.deepEqual(ok.errors, []);
	assert.deepEqual(ok.em, [{ subckt: "em_match", fit: "e2", em: "e1" }]);
	// a changed fit is not an EM passive, and its sources break the device rules
	const changed = checkDesign(LNA(FIT.replace("1e3", "2e3")), fits.found);
	assert.deepEqual(changed.em, []);
	assert.ok(changed.errors.some((e) => /vsense1: no sources/.test(e)));
	const bad = checkDesign(".subckt lna rfin rfout vcc18 iref1 iref2 iref3\nxl a b tm2_w6 len=2e-3\nl1 a b 100p\n.ends\n", []);
	assert.deepEqual(bad.errors, ["xl: tm2_w6 needs len from 1e-9 to 0.001, got 2e-3", "l1: ideal L 100p is above 5e-11 (wiring models only)"]);
});

test("lna scorer: gate rows count as requirements, values only for requirement rows", async (t) => {
	const ws = workspace(t);
	writeFileSync(join(ws, "lna.spice"), LNA(""));
	const rows = { "tt gain": { value: 14, pass: true }, "tt gate limits hbt_vce_max": { value: 1.7, pass: false } };
	writeFileSync(join(ws, "answer.json"), JSON.stringify({ meets_spec: false, rows: [{ corner: "tt", requirement: "gain", value: 14.05 }] }));
	const s = await lnaScore(ws, { rows: { "tt gain": 13.6 } }, ws, { verifier: async () => ({ rows }) });
	assert.equal(s.design, 0, "em_match is not defined in lna.spice");
	assert.equal(s.em_passive, 0);
	assert.ok(s.missed.includes("tt gate limits hbt_vce_max"));
	assert.equal(s.rows["tt gain"].value, true);
	assert.equal(s.values, 1);
	assert.equal(s.claim, 4);
	assert.equal(s.max.values, 13);
});

test("det-cell-hard scorer: rows without a condition (the EM tap rows)", async (t) => {
	const ws = workspace(t);
	writeFileSync(join(ws, "det_cell.spice"), ".subckt det_cell lin vcc18 outd outr iref\nxq vcc18 lin outd 0 npn13G2 sw_nqs=1\n.ends\n");
	const req = JSON.parse(readFileSync(new URL("../evals/det-cell-sg13g2-hard/requirements.json", import.meta.url), "utf8"));
	const rows = {};
	for (const r of req.requirements) for (const c of r.conditions ?? [null]) rows[rowKey(c, r.id)] = { value: -30, pass: true };
	const answer = { meets_spec: true, rows: [{ corner: null, requirement: "tap_s31", value: -30.3 }] };
	writeFileSync(join(ws, "answer.json"), JSON.stringify(answer));
	const s = await hardScore(ws, { rows: {} }, ws, { verifier: async () => ({ rows }) });
	assert.equal(s.max.values, 37);
	assert.equal(s.requirements, 37);
	assert.equal(s.rows.tap_s31.value, true);
	assert.equal(s.claim, 4);
	assert.match(s.errors.join(" "), /tap.gds not found/);
});

test("lna scorer: values may be .param expressions", () => {
	const text = ".param le=2p lc=120u rd=200\n.subckt lna rfin rfout vcc18 iref1 iref2 iref3\nle1 a b {le}\nxl a b tm2_w13 len={lc}\nxr a b 0 rppd w=2u l={rd/260*2u}\nlx a b {le*100}\nxy a b tm2_w6 len={nope}\n.ends\n";
	const p = paramTable(text);
	assert.deepEqual(Object.keys(p), ["le", "lc", "rd"]);
	assert.ok(Math.abs(p.lc - 1.2e-4) < 1e-18 && p.le === 2e-12 && p.rd === 200);
	assert.equal(value("{1e-3*2}"), 0.002);
	assert.ok(Number.isNaN(value("{a;b}")));
	assert.deepEqual(checkDesign(text, []).errors, ["lx: ideal L {le*100} is above 5e-11 (wiring models only)", "xy: tm2_w6 needs len from 1e-9 to 0.001, got {nope}"]);
});
