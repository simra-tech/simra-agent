// The scorer of the det-cell-sg13g2 pilot task, with a stub verifier (no simulator): the device rules, the points of
// each part and the rows closed and missed.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDesign, score, spiceNumber } from "../evals/det-cell-sg13g2/score.mjs";

const req = JSON.parse(readFileSync(new URL("../evals/det-cell-sg13g2/requirements.json", import.meta.url), "utf8"));
const corners = Object.keys(req.conditions);
const ids = req.requirements.map((r) => r.id);

test("det-cell scorer: device rules", () => {
	assert.equal(spiceNumber("1.3u"), 1.3e-6);
	assert.equal(spiceNumber("2meg"), 2e6);
	assert.deepEqual(checkDesign(".subckt det_cell lin vcc18 outd outr iref\nxq c b e 0 npn13G2 Nx=1\nxc a 0 cap_cmim w=1u l=1u\nr1 a b 11.8\nl1 b c 6p\nk1 l1 l2 0.3\n.ends\n"), []);
	assert.deepEqual(checkDesign(".subckt det_cell lin vcc18 outr outd iref\nB1 a 0 V=1\nr1 a 0 10k\n.ends\n"), [
		"B1: no sources in the design (block det_cell is not a fitted model of a fit_to_spice record)",
		"r1: ideal R 10k is above 50 (wiring models only)",
		'det_cell pins are "lin vcc18 outr outd iref", expected "lin vcc18 outd outr iref"',
	]);
});

test("det-cell scorer: points, claim and rows with a stub verifier", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "simra-det-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const ws = join(dir, "ws");
	rmSync(ws, { recursive: true, force: true });
	await import("node:fs").then((fs) => fs.mkdirSync(ws));
	writeFileSync(join(ws, "det_cell.spice"), ".subckt det_cell lin vcc18 outd outr iref\nxq vcc18 lin outd 0 npn13G2\n.ends\n");
	const rows = {};
	for (const c of corners) for (const id of ids) rows[`${c} ${id}`] = { value: 1, pass: !(c === "slow_hot" && id === "vout_m10_v"), status: "pass" };
	const answer = { meets_spec: true, rows: corners.flatMap((c) => ids.map((id) => ({ corner: c, requirement: id, value: id === "idd_a" ? 1.05 : 1, pass: true }))) };
	writeFileSync(join(ws, "answer.json"), JSON.stringify(answer));
	const s = await score(ws, { rows: {} }, ws, { verifier: async () => ({ rows }) });
	assert.equal(s.design, 2);
	assert.equal(s.requirements, 29);
	assert.deepEqual(s.missed, ["slow_hot vout_m10_v"]);
	assert.equal(s.claim, 0, "meets_spec true, but one row fails");
	assert.equal(s.values, 25, "idd_a 1.05 against 1 is outside 2 %");
});
