// Touchstone record type: parser (version 1 and 2), the passivity and reciprocity numbers, and the summary that the
// runner adds to result.json. The files are small synthetic examples with known answers, written by the test.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	annotateTouchstone,
	entry,
	formatTouchstone,
	largestSingularValue,
	parseTouchstone,
	sDb,
	stabilityMu,
	summarizeTouchstone,
} from "../src/index.ts";

const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

/** sigma_max of a 2 x 2 complex matrix in closed form: s^2 = (F + sqrt(F^2 - 4 |det|^2)) / 2, F = Frobenius norm^2. */
function sigma2x2(m: [number, number][]): number {
	const f = m.reduce((acc, [re, im]) => acc + re * re + im * im, 0);
	const [a, b, c, d] = m;
	const det: [number, number] = [a[0] * d[0] - a[1] * d[1] - (b[0] * c[0] - b[1] * c[1]), a[0] * d[1] + a[1] * d[0] - (b[0] * c[1] + b[1] * c[0])];
	const det2 = det[0] ** 2 + det[1] ** 2;
	return Math.sqrt((f + Math.sqrt(f * f - 4 * det2)) / 2);
}

test("version 1 two-port: the data order is S11 S21 S12 S22, RI format, Hz", () => {
	const text = ["! amplifier", "# HZ S RI R 50", "1e9  0.2 0  3 0  0.01 0  0.3 0", "2e9  0.2 0.1  2.5 -1  0.02 0  0.3 -0.1"].join("\n");
	const t = parseTouchstone(text, "amp.s2p");
	assert.equal(t.version, 1);
	assert.deepEqual(t.f, [1e9, 2e9]);
	assert.deepEqual(entry(t, 0, 1, 0), [3, 0], "the second pair is S21");
	assert.deepEqual(entry(t, 0, 0, 1), [0.01, 0], "the third pair is S12");
	const s = summarizeTouchstone(t);
	assert.equal(s.nports, 2);
	assert.deepEqual(s.z0_ohm, [50, 50]);
	assert.equal(s.dc_point, false);
	assert.equal(s.uniform_grid, true);
	close(s.reciprocity.max_abs_difference, 3 - 0.01);
	assert.equal(s.reciprocity.at_hz, 1e9);
	const expected = Math.max(sigma2x2([[0.2, 0], [0.01, 0], [3, 0], [0.3, 0]]), sigma2x2([[0.2, 0.1], [0.02, 0], [2.5, -1], [0.3, -0.1]]));
	close(s.passivity.max_singular_value, expected, 1e-9);
	close(sDb(t, 0, 2, 1), 20 * Math.log10(3));
	assert.match(formatTouchstone(s), /NOT PASSIVE/);
});

test("singular values: a normal 2-port and a scaled unitary 3-port", () => {
	// S = 0.1 I + 0.5j X: eigenvalues 0.1 +- 0.5j, normal, so sigma = |0.1 + 0.5j|.
	close(largestSingularValue(Float64Array.from([0.1, 0, 0, 0.5, 0, 0.5, 0.1, 0]), 2), Math.hypot(0.1, 0.5), 1e-12);
	// 0.8 times a permutation with phases: every singular value is 0.8.
	const p = new Float64Array(18);
	const set = (i: number, j: number, re: number, im: number) => {
		p[(i * 3 + j) * 2] = re;
		p[(i * 3 + j) * 2 + 1] = im;
	};
	set(0, 1, 0.8, 0);
	set(1, 2, 0, 0.8);
	set(2, 0, -0.8 * Math.SQRT1_2, 0.8 * Math.SQRT1_2);
	close(largestSingularValue(p, 3), 0.8, 1e-12);
	close(largestSingularValue(Float64Array.from([0.6, -0.8]), 1), 1, 1e-15);
});

test("version 1 one-port: GHz, MA by default, and a version 1 two-port with noise data", () => {
	const one = parseTouchstone("# GHZ S MA R 50\n1 0.3333 180\n2 0.3333 180\n", "r25.s1p");
	assert.deepEqual(one.f, [1e9, 2e9]);
	close(entry(one, 0, 0, 0)[0], -0.3333, 1e-12);
	const noisy = ["# MHZ S DB R 50", "100 -20 0 10 90 -40 0 -15 0", "200 -20 0 9 80 -40 0 -15 0", "100 1.2 0.3 20 0.2", "200 1.3 0.3 25 0.2"].join("\n");
	const t = parseTouchstone(noisy, "lna.s2p");
	assert.equal(t.f.length, 2);
	assert.equal(t.noise, true);
	close(sDb(t, 1, 2, 1), 9, 1e-9);
	close(entry(t, 0, 1, 0)[1], 10 ** 0.5, 1e-9);
});

test("version 2: two-port order 12_21 (as Xyce .LIN writes it), and a 3-port with a lower matrix", () => {
	const v2 = [
		"[Version] 2.0",
		"# Hz S RI R 50",
		"[Number of Ports] 2",
		"[Two-Port Data Order] 12_21",
		"[Number of Frequencies] 1",
		"[Reference] 50 50",
		"[Network Data]",
		"1e9 0.1 0 0.01 0 2 0 0.2 0",
		"[End]",
	].join("\n");
	const t = parseTouchstone(v2, "lin.cir.s2p");
	assert.equal(t.version, 2);
	assert.deepEqual(entry(t, 0, 0, 1), [0.01, 0]);
	assert.deepEqual(entry(t, 0, 1, 0), [2, 0]);
	// A unilateral matched amplifier: mu = 1 / |S22|.
	const amp = parseTouchstone(v2.replace("1e9 0.1 0 0.01 0 2 0 0.2 0", "1e9 0 0 0 0 4 0 0.5 0"), "amp.s2p");
	close(stabilityMu(amp, 0), 2, 1e-12);

	const three = [
		"[Version] 2.0",
		"# GHz S RI R 50",
		"[Number of Ports] 3",
		"[Number of Frequencies] 2",
		"[Reference] 50 75",
		"25",
		"[Matrix Format] Lower",
		"[Network Data]",
		"1 0.1 0",
		"  0.2 0 0.3 0",
		"  0.4 0 0.5 0 0.6 0",
		"2 0.1 0 0.2 0 0.3 0 0.4 0 0.5 0 0.6 0",
		"[End]",
	].join("\n");
	const t3 = parseTouchstone(three, "x.s3p");
	assert.deepEqual(t3.z0, [50, 75, 25]);
	assert.deepEqual(entry(t3, 1, 0, 2), [0.4, 0], "the lower matrix fills the upper half");
	const s3 = summarizeTouchstone(t3);
	assert.equal(s3.reciprocity.max_abs_difference, 0);
	assert.equal(s3.uniform_grid, true);
});

test("files that are not valid or not supported give a reason", () => {
	assert.throws(() => parseTouchstone("# GHZ Y RI R 50\n1 0 0\n", "y.s1p"), /only S-parameters/);
	assert.throws(() => parseTouchstone("# GHZ S RI R 50\n1 0 0\n", "data.txt"), /port count in its name/);
	assert.throws(() => parseTouchstone("# GHZ S RI R 50\n1 0 0 1 0 1 0\n", "a.s2p"), /after the last full point/);
	assert.throws(() => parseTouchstone("# GHZ S RI R 50\n2 0 0\n1 0 0\n", "a.s1p"), /do not increase/);
	assert.throws(() => parseTouchstone("[Version] 2.0\n# GHZ S RI R 50\n[Number of Ports] 2\n[Network Data]\n1 0 0 0 0 0 0 0 0\n", "a.s2p"), /Two-Port Data Order/);
});

test("the runner adds the summary to a Touchstone entry, and refuses a file that changed", (t) => {
	const root = mkdtempSync(join(tmpdir(), "simra-ts-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const text = "# GHZ S RI R 50\n1 0 0 0.5 0 0.5 0 0 0\n2 0 0 0.5 0 0.5 0 0 0\n";
	writeFileSync(join(root, "line.s2p"), text);
	writeFileSync(join(root, "other.s2p"), text);
	const hash = createHash("sha256").update(text).digest("hex");
	const result = {
		input_files: { complete: true, files: [{ path: "line.s2p", sha256: hash, role: "touchstone" }, { path: "deck.cir", sha256: "x", role: "deck" }] },
		outputs: [{ path: "other.s2p", sha256: "0".repeat(64) }],
	};
	annotateTouchstone(root, result);
	const summary = result.input_files.files[0] as { touchstone?: { nports: number; passivity: { max_singular_value: number } } };
	assert.equal(summary.touchstone?.nports, 2);
	close(summary.touchstone?.passivity.max_singular_value ?? 0, 0.5, 1e-12);
	assert.equal((result.input_files.files[1] as { touchstone?: unknown }).touchstone, undefined);
	assert.deepEqual((result.outputs[0] as { touchstone?: unknown }).touchstone, { error: "the file changed after the adapter hashed it" });
});
