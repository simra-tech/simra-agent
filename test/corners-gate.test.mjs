// The required-corner gate on a public block: examples/acc-sg13g2 (IHP SG13G2) with its requirements.json, the real
// librelane adapter (operation read, Python standard library only) and the kernel command line.
// The run directories are made here, with the structure of a LibreLane run and the slack values that LibreLane
// 3.1.0.dev6 gave for this block at the timing step before the layout (2026-11-28, image hpretl/iic-osic-tools:2026.11):
//   1. the flow analysed the three corners: the block passes at the typical corner and fails at the slow corner
//      (setup) and at the fast corner (hold); each required corner has a gate row with a value;
//   2. the flow analysed the typical corner only: the two other required corners are "not run", and the check is
//      not a pass.
// It needs python3. Without it the cases are skipped: that check did not run.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repo = new URL("../", import.meta.url).pathname;
const example = join(repo, "examples/acc-sg13g2");
const cli = join(repo, "packages/kernel/src/cli.ts");
const skip = spawnSync("python3", ["--version"]).status !== 0 && "python3 is not there";

const TYP = "nom_typ_1p20V_25C";
const SLOW = "nom_slow_1p08V_125C";
const FAST = "nom_fast_1p32V_m40C";
/** Worst setup and hold slack in ns of acc at each corner, timing without wires (step OpenROAD.STAPrePNR). */
const MEASURED = { [FAST]: [3.6454431616310465, -0.04887820841973182], [SLOW]: [-0.7555569717067425, 0.20754837325121828], [TYP]: [2.0261757289918876, 0.04557290784848875] };

const write = (path, data) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
};

/** A design root with the files of the example and the run runs/syn, in which the flow analysed the given corners. */
function designRoot(t, corners) {
	const root = mkdtempSync(join(tmpdir(), "simra-corners-acc-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const f of ["config.json", "requirements.json"]) copyFileSync(join(example, f), join(root, f));
	mkdirSync(join(root, "src"));
	copyFileSync(join(example, "src/acc.v"), join(root, "src/acc.v"));
	// The example names a container environment; the read needs none.
	writeFileSync(join(root, "simra.config.json"), "{}");
	const run = join(root, "runs/syn");
	write(join(run, "resolved.json"), { DESIGN_NAME: "acc", DESIGN_DIR: root, STA_CORNERS: corners, DEFAULT_CORNER: TYP, CLOCK_PERIOD: 7.1, VERILOG_FILES: [join(root, "src/acc.v")], meta: { librelane_version: "3.1.0.dev6" } });
	const metrics = {};
	for (const c of corners) {
		metrics[`timing__setup__ws__corner:${c}`] = MEASURED[c][0];
		metrics[`timing__hold__ws__corner:${c}`] = MEASURED[c][1];
	}
	const step = (dir, id, before, after) => {
		write(join(run, dir, "config.json"), { meta: { librelane_version: "3.1.0.dev6", step: id } });
		write(join(run, dir, "state_in.json"), { metrics: before });
		write(join(run, dir, "state_out.json"), { metrics: after });
	};
	step("06-yosys-synthesis", "Yosys.Synthesis", {}, {});
	step("12-openroad-staprepnr", "OpenROAD.STAPrePNR", {}, metrics);
	for (const c of corners) write(join(run, "12-openroad-staprepnr", c, "sta.log"), "\n");
	return root;
}

function check(root) {
	const r = spawnSync("node", [cli, "--root", root, "check"], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	const id = readdirSync(join(root, "simra/checks"))[0];
	return { ...r, verdict: JSON.parse(readFileSync(join(root, "simra/checks", id, "verdict.json"), "utf8")) };
}
const gate = (verdict, requirement, corner) => verdict.rows.find((r) => r.gate?.name === "corners" && r.gate.stage === requirement && r.condition === corner);

test("acc, the flow analysed the three corners: each required corner has a gate row with its value; the slow and the fast corner fail", { skip }, (t) => {
	const { status, stdout, stderr, verdict } = check(designRoot(t, [FAST, SLOW, TYP]));
	assert.equal(status, 1, stderr);
	assert.equal(verdict.status, "fail");
	assert.deepEqual(verdict.counts, { pass: 8, fail: 4, not_measured: 0, not_run: 0 });
	assert.deepEqual([TYP, SLOW, FAST].map((c) => gate(verdict, "setup", c).status), ["pass", "fail", "pass"]);
	assert.deepEqual([TYP, SLOW, FAST].map((c) => gate(verdict, "hold", c).status), ["pass", "pass", "fail"]);
	assert.ok(Math.abs(gate(verdict, "setup", SLOW).value + 0.755557) < 1e-6);
	assert.match(stdout, new RegExp(`^  FAIL         gate corners setup @ ${SLOW}: -0\\.7556 ns, limit >= 0 margin -0\\.7556 ns \\[\\S+\\] \\(from requirement setup\\)$`, "m"));
	assert.match(stdout, new RegExp(`^  PASS         gate corners setup @ ${TYP}: 2\\.026 ns, limit >= 0 `, "m"));
});

test("acc, the flow analysed the typical corner only: the block passes there, and the two other required corners are not run", { skip }, (t) => {
	const { status, stdout, stderr, verdict } = check(designRoot(t, [TYP]));
	assert.equal(status, 1, stderr);
	// Every value that exists passes. The check is still not a pass.
	assert.equal(verdict.counts.fail, 0);
	assert.equal(verdict.status, "incomplete");
	assert.deepEqual(verdict.counts, { pass: 4, fail: 0, not_measured: 4, not_run: 4 });
	for (const requirement of ["setup", "hold"]) {
		assert.equal(gate(verdict, requirement, TYP).status, "pass");
		for (const c of [SLOW, FAST]) {
			const row = gate(verdict, requirement, c);
			assert.equal(row.status, "not_run");
			assert.equal(row.value, null);
			assert.match(row.reason, new RegExp(`^no result at the required corner ${c}: experiment \\S+ gave no value for ${requirement}_ws_ns@${c}$`));
		}
	}
	assert.match(stdout, /^check \S+: INCOMPLETE \(4 pass, 0 fail, 4 not measured, 4 not run; 3 experiments\)$/m);
	assert.match(stdout, new RegExp(`^  NOT_RUN      gate corners hold @ ${FAST}: -, limit >= 0 `, "m"));
});
