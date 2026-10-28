// The ota-corners scorer gives full points to a correct, traceable answer and removes points for each defect.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ccValuePf, score } from "../evals/ota-corners/score.mjs";

const repo = new URL("../", import.meta.url).pathname;
const expected = JSON.parse(readFileSync(join(repo, "evals/ota-corners/expected.json"), "utf8"));
const sha = (text) => createHash("sha256").update(text).digest("hex");

/** A workspace in which the agent simulated each case and kept one log per case. */
function goodWorkspace() {
	const ws = mkdtempSync(join(tmpdir(), "simra-score-"));
	copyFileSync(join(repo, "examples/ota-sg13g2/ota.spice"), join(ws, "ota.spice"));
	const original = readFileSync(join(ws, "ota.spice"), "utf8");
	const changed = original.replace("Cc z out 1p", "Cc z out 1.5e-12");
	writeFileSync(join(ws, "ota_cc1p5.spice"), changed);
	const cases = [
		["tt", "tt", 1, expected.corners.tt.values, original],
		["ss", "ss", 1, expected.corners.ss.values, original],
		["ff", "ff", 1, expected.corners.ff.values, original],
		["tt_cc1p5", "tt", 1.5, expected.variants.tt_cc1p5.values, changed],
	];
	const results = cases.map(([label, corner, cc, v, ota]) => {
		// The log shows the phase at the UGF in degrees; the agent computed the margin from it.
		writeFileSync(join(ws, `${label}.log`), `.lib cornerMOSlv.lib mos_${corner}\ngain_db = ${v.gain_db}\nugf_hz = ${v.ugf_hz}\nphase = ${v.pm_deg - 180}\nvn = ${v.vn_1k_nv}\n`);
		return { label, corner, cc_pf: cc, gain_db: v.gain_db, ugf_hz: v.ugf_hz, pm_deg: v.pm_deg, vn_1k_nv: v.vn_1k_nv, evidence: `${label}.log`, ota_sha256: sha(ota) };
	});
	const answer = { simulator_version: "ngspice-46", pdk_commit: expected.provenance.pdk_commit.slice(0, 10), results };
	writeFileSync(join(ws, "answer.json"), JSON.stringify(answer));
	return { ws, answer };
}

test("Cc value parser", () => {
	assert.equal(ccValuePf("Cc z out 1p"), 1);
	assert.equal(ccValuePf("cc z out 1.5pF"), 1.5);
	assert.equal(ccValuePf("Cc z out 1.5e-12"), 1.5);
	assert.equal(ccValuePf("CL out 0 2p"), null);
});

test("a correct, traceable answer gets full points", () => {
	const { ws } = goodWorkspace();
	try {
		const r = score(ws, expected);
		assert.deepEqual([r.correctness, r.traceability, r.tool, r.errors], [16, 16, 2, []]);
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test("each defect removes points", () => {
	const { ws, answer } = goodWorkspace();
	try {
		const [tt, ss, ff, v] = answer.results;
		tt.pm_deg += 5; // wrong value, and the evidence does not show it
		ss.evidence = "missing.log"; // evidence does not exist
		writeFileSync(join(ws, "ff.log"), readFileSync(join(ws, "ff.log"), "utf8").replace("mos_ff", "mos_tt")); // wrong corner
		v.ota_sha256 = tt.ota_sha256; // claims the Cc = 1 pF netlist for the Cc = 1.5 pF result
		answer.simulator_version = "41";
		writeFileSync(join(ws, "answer.json"), JSON.stringify(answer));
		const r = score(ws, expected);
		assert.equal(r.correctness, 15);
		assert.equal(r.traceability, 16 - 1 - 3 - 1 - 1);
		assert.equal(r.tool, 1);
		assert.equal(r.results.ss.evidence, false);
		assert.equal(r.results.ff.corner, false);
		assert.equal(r.results.tt_cc1p5.inputs, false);
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});

test("no answer file gives zero points and an error", () => {
	const ws = mkdtempSync(join(tmpdir(), "simra-score-"));
	try {
		const r = score(ws, expected);
		assert.deepEqual([r.correctness, r.traceability, r.tool], [0, 0, 0]);
		assert.match(r.errors[0], /answer.json not found/);
	} finally {
		rmSync(ws, { recursive: true, force: true });
	}
});
