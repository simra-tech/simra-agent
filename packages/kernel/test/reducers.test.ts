// Sweep reducers and the bracket rule: a reduced value is invalid when a point inside its bracket has no value.

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReduced, reduceSweep, reducerError } from "../src/index.ts";

const pts = (ys: (number | null)[], x0 = -10, dx = 5) => ys.map((y, k) => ({ x: x0 + k * dx, y }));

test("compression: interpolated in the bracket; a failed point inside the bracket makes it invalid, after it does not", () => {
	// Gain from -10 dBm in steps of 5 dB: 10, 9.8, 9.4, 8.6, 7.0. The 1 dB point is between 0 and 5 dBm.
	const good = reduceSweep(pts([10, 9.8, 9.4, 8.6, 7.0]), { kind: "compression" });
	assert.equal(good.status, "measured");
	assert.ok(Math.abs((good.value as number) - (0 + ((9.0 - 9.4) * 5) / (8.6 - 9.4))) < 1e-12);
	assert.deepEqual(good.bracket, [-10, 5]);
	// The point at 0 dBm failed: the interpolation from -5 to 5 dBm would hide the real compression.
	const bad = reduceSweep(pts([10, 9.8, null, 8.6, 7.0]), { kind: "compression" });
	assert.equal(bad.status, "failed");
	assert.equal(bad.value, null);
	assert.match(bad.reason as string, /the point 0 has no value and is inside the bracket of the 1 dB compression/);
	// A failed point after the bracket does not matter.
	assert.equal(reduceSweep(pts([10, 9.8, 9.4, 8.6, null]), { kind: "compression" }).status, "measured");
	// No compression in the range: missing, not a value.
	const none = reduceSweep(pts([10, 9.9, 9.8]), { kind: "compression" });
	assert.equal(none.status, "missing");
	assert.match(none.reason as string, /^no 1 dB compression between -10 and 0$/);
	assert.equal(reduceSweep(pts([null, 9.9, 8]), { kind: "compression" }).status, "failed", "the reference point failed");
	assert.equal(reduceSweep(pts([10, 9, 8]), { kind: "compression", db: 3 }).status, "missing");
});

test("crossing: first crossing in the direction; the bracket ends at the crossing", () => {
	// Rising through 0 between x = 0 and x = 5.
	const ys = [-3, -2, -1, 4, 6];
	const r = reduceSweep(pts(ys), { kind: "crossing", level: 0, direction: "rising" });
	assert.ok(Math.abs((r.value as number) - (0 + (1 / 5) * 5)) < 1e-12);
	assert.equal(reduceSweep(pts([-3, null, -1, 4]), { kind: "crossing", level: 0 }).status, "failed");
	assert.equal(reduceSweep(pts([-3, -2, -1, 4, null]), { kind: "crossing", level: 0 }).status, "measured");
	assert.equal(reduceSweep(pts(ys), { kind: "crossing", level: 0, direction: "falling" }).status, "missing");
	// A point exactly at the level is the crossing.
	assert.equal(reduceSweep(pts([-1, 0, 1]), { kind: "crossing", level: 0 }).value, -5);
});

test("min and max: every point is in the bracket", () => {
	assert.deepEqual([reduceSweep(pts([3, 1, 2]), { kind: "min" }).value, reduceSweep(pts([3, 1, 2]), { kind: "min" }).at], [1, -5]);
	assert.equal(reduceSweep(pts([3, 1, 2]), { kind: "max" }).value, 3);
	const bad = reduceSweep(pts([3, 1, null]), { kind: "max" });
	assert.equal(bad.status, "failed");
	assert.match(formatReduced(bad), /^FAILED \(the point 0 has no value and is inside the bracket of the maximum \(every point\)\)$/);
	assert.equal(formatReduced(reduceSweep(pts([3, 1, 2]), { kind: "min" }), "dB"), "1 dB @ -5");
});

test("reducer specifications are checked", () => {
	assert.match(reducerError({ kind: "mean" }) as string, /reduce.kind must be one of min, max, crossing, compression/);
	assert.match(reducerError({ kind: "crossing" }) as string, /level must be a number/);
	assert.match(reducerError({ kind: "compression", db: -1 }) as string, /positive/);
	assert.equal(reducerError({ kind: "crossing", level: 1, direction: "rising" }), null);
	assert.throws(() => reduceSweep([], { kind: "crossing" } as never), /level/);
});
