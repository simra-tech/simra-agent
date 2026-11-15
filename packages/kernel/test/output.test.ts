import assert from "node:assert/strict";
import { test } from "node:test";
import { queryTable, readLog, readTable } from "../src/index.ts";

// Fixtures: ngspice 41 output of an RC with a 1 A AC current (ac lin 3 1g 3g): ASCII and binary raw files, a wrdata
// file with vector names, and the log with print and meas lines (two error lines and a warning added).
const root = new URL("./fixtures/output/", import.meta.url).pathname;

test("readLog gives the measurement lines, the errors once, the warnings and the matches", () => {
	const s = readLog(root, "ngspice.log", { pattern: "^gmax" });
	assert.deepEqual(s.measurements.map((m) => [m.name, m.value]), [["gmax", 43.92776]]);
	assert.equal(s.counts.errors, 2);
	assert.deepEqual(s.errors.map((e) => e.text), ["Error: singular matrix"]);
	assert.deepEqual(s.warnings.map((e) => e.text), ["Warning: test warning one"]);
	assert.equal(s.counts.matches, 1);
	assert.throws(() => readLog(root, "../output.test.ts"), /outside the design root/);
});

test("readTable reads ASCII and binary raw files, wrdata and print output alike", () => {
	const a = readTable(root, "ac_ascii.raw");
	const b = readTable(root, "ac_bin.raw");
	assert.deepEqual(a.columns, ["frequency", "v(a).re", "v(a).im"]);
	assert.equal(a.format, "raw-ascii");
	assert.equal(b.format, "raw-binary");
	assert.equal(a.rows.length, 3);
	for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) assert.ok(Math.abs(a.rows[i][k] - b.rows[i][k]) <= 1e-9 * Math.abs(a.rows[i][k]) + 1e-12);
	assert.ok(Math.abs(a.rows[0][1] - 24.70452303185764) < 1e-9);
	const w = readTable(root, "ac.dat");
	assert.deepEqual(w.columns, ["frequency", "vdb(a)", "vp(a)"]);
	const p = readTable(root, "ngspice.log");
	assert.deepEqual(p.columns, ["frequency", "vdb(a)"]);
	assert.deepEqual(p.rows.map((r) => r[1]), [43.92776, 37.98839, 34.48177]);
});

test("queryTable selects columns and a range and gives the extremes", () => {
	const q = queryTable(root, "ac.dat", { columns: ["vdb(a)"], from: 1.5e9, to: 3e9 });
	assert.deepEqual(q.columns, ["frequency", "vdb(a)"]);
	assert.equal(q.rows_in_range, 2);
	assert.deepEqual(q.stats[0], { column: "vdb(a)", min: 34.4817716, at_min: 3e9, max: 37.9883874, at_max: 2e9 });
	assert.deepEqual(queryTable(root, "ac_bin.raw", { columns: ["/\\.im$/"], max_rows: 2 }).rows.length, 2);
	assert.throws(() => queryTable(root, "ac.dat", { columns: ["nope"] }), /no column "nope"; the columns are frequency, vdb\(a\), vp\(a\)/);
});
