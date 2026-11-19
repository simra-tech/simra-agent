// EM S-parameters (emSParameters, simra em): one simulate job per port, then the merge to Touchstone. On a fake
// openEMS adapter (synthetic columns; the merge is the merge of the real adapter), in the local environment.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareTouchstone, emPortJobs, emSParameters, formatSnpDiff } from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;

function designRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "simra-em-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	return root;
}
const ports = [
	{ name: "in", x: 0, y: 0, from: "Metal1", to: "TopMetal2" },
	{ name: "out", x: 300, y: 0, from: "Metal1", to: "TopMetal2" },
];

test("emPortJobs: one simulate job per port with only that port excited", () => {
	const jobs = emPortJobs({ root: "/x", inputs: { ports, band_hz: [1e9, 2e9] }, timeoutS: 900 });
	assert.deepEqual(jobs.map((j) => [j.operation, j.inputs.excite, j.timeout_s]), [["simulate", [1], 900], ["simulate", [2], 900]]);
	assert.throws(() => emPortJobs({ root: "/x", inputs: { ports, excite: [1] } }), /set by simra em/);
	assert.throws(() => emPortJobs({ root: "/x", inputs: {} }), /ports must be a list/);
});

test("emSParameters: two port jobs and the merge give one 2-port Touchstone file", async (t) => {
	const root = designRoot(t);
	const out = await emSParameters({ root, adapter: "openems-fake", inputs: { ports }, parallel: 2 });
	assert.deepEqual(out.problems, []);
	assert.deepEqual(out.ports.jobs.map((j) => j.status), ["completed", "completed"]);
	assert.equal(out.merge?.status, "completed");
	assert.match(out.touchstone ?? "", /line\.s2p$/);
	const rows = readFileSync(join(root, out.touchstone as string), "utf8").split("\n").filter((l) => l && !/^[!#]/.test(l));
	// S11 S21 S12 S22 at the first frequency, real parts
	assert.deepEqual(rows[0].trim().split(/\s+/).slice(1).filter((_, i) => i % 2 === 0).map(Number), [0.1, 0.9, 0.9, 0.1]);
	assert.match(out.text, /EM S-parameters: .*line\.s2p/);
});

test("emSParameters: a port that did not reach the end criterion stops the merge", async (t) => {
	const root = designRoot(t);
	const out = await emSParameters({ root, adapter: "openems-fake", inputs: { ports, unconverged_port: 2 }, parallel: 2 });
	assert.equal(out.touchstone, null);
	assert.equal(out.merge, null);
	assert.equal(out.problems.length, 1);
	assert.match(out.problems[0], /EM port 2 of 2: failed: port 2: the end criterion -40 dB was not reached/);
	assert.match(out.text, /merge: not run/);
});

test("emSParameters: with allow_unconverged the merge runs and keeps a warning", async (t) => {
	const root = designRoot(t);
	const out = await emSParameters({ root, adapter: "openems-fake", inputs: { ports, unconverged_port: 2, allow_unconverged: true }, parallel: 2 });
	assert.match(out.touchstone ?? "", /line\.s2p$/);
	const result = JSON.parse(readFileSync(join(root, "simra/experiments", out.merge?.id as string, "result.json"), "utf8"));
	assert.equal(result.diagnostics[0].severity, "warning");
});

test("emSParameters: a failed solver names the port job and its reason", async (t) => {
	const root = designRoot(t);
	const out = await emSParameters({ root, adapter: "openems-fake", inputs: { ports, fail_port: 1 }, parallel: 2 });
	assert.equal(out.touchstone, null);
	assert.match(out.problems[0], /EM port 1 of 2: failed: port 1: the solver failed/);
});

test("compareTouchstone: dB, degree and |dS| differences at the common points, with a noise floor", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "simra-snpdiff-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const s2p = (rows: number[][]) => `# Hz S MA R 50\n${rows.map((r) => r.join(" ")).join("\n")}\n`;
	// f, S11 (mag, deg), S21, S12, S22
	writeFileSync(join(dir, "a.s2p"), s2p([[1e9, 0.1, 0, 0.9, -10, 0.9, -10, 0.001, 0], [2e9, 0.1, 0, 0.9, -20, 0.9, -20, 0.001, 0], [3e9, 0.1, 0, 0.9, -30, 0.9, -30, 0.001, 0]]));
	writeFileSync(join(dir, "b.s2p"), s2p([[1e9, 0.1, 0, 0.9, -10, 0.9, -10, 0.002, 90], [2e9, 0.11, 0, 0.8, -25, 0.8, -25, 0.002, 90], [2.5e9, 1, 0, 1, 0, 1, 0, 1, 0]]));
	const d = compareTouchstone(join(dir, "a.s2p"), join(dir, "b.s2p"));
	assert.equal(d.points, 2);
	const s21 = d.entries.find((e) => e.entry === "S21");
	assert.ok(Math.abs((s21?.max_abs_db ?? 0) - 20 * Math.log10(0.9 / 0.8)) < 1e-9);
	assert.ok(Math.abs((s21?.max_abs_deg ?? 0) - 5) < 1e-9);
	assert.equal(s21?.at_deg_hz, 2e9);
	const s22 = d.entries.find((e) => e.entry === "S22");
	assert.deepEqual([s22?.max_abs_db, s22?.max_abs_deg], [0, 0], "S22 is below the -40 dB floor in both files");
	assert.ok((s22?.max_abs_ds ?? 0) > 0.002);
	assert.equal(compareTouchstone(join(dir, "a.s2p"), join(dir, "b.s2p"), [1.5e9, 3e9]).points, 1);
	assert.match(formatSnpDiff(d), /^2 common points\nS11: max 0\.828 dB at 2\.0 GHz/);
});
