import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatTimingStepFinding, hasTimingResult, timingLogSizes, timingStepFinding } from "../src/timingcheck.ts";

// The logs of timing runs on public designs (adapters/openroad/fixtures/README.md).
const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "adapters", "openroad", "fixtures");

function workspace(files: Record<string, string>, fixtures: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "simra-timingcheck-"));
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	for (const [name, fixture] of Object.entries(fixtures)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		copyFileSync(join(FIX, fixture), join(dir, name));
	}
	return dir;
}

test("timing check: a timing log with a syntax error of the netlist and no slack line is not run", () => {
	const dir = workspace({}, { "sta/sta.log": "sta_signed_syntax_error.log" });
	try {
		const found = timingStepFinding(dir, 0);
		assert.deepEqual(found?.logs, ["sta/sta.log"]);
		assert.equal(found?.problem?.line, 1);
		assert.match(found?.problem?.text ?? "", /Error: 171 fir\.nl\.v line 8, syntax error/);
		const note = formatTimingStepFinding(found!);
		assert.match(note, /Simra timing check: not run/);
		assert.match(note, /sta\/sta\.log:1: Error: 171/);
		assert.match(note, /not as passed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("timing check: a top module that the netlist does not have is not run; the file name need not say timing", () => {
	const dir = workspace({}, { "logs/signoff.log": "sta_not_a_module.log" });
	try {
		const found = timingStepFinding(dir, 0);
		assert.deepEqual(found?.logs, ["logs/signoff.log"]);
		assert.match(found?.problem?.text ?? "", /acc is not a verilog module/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("timing check: an empty timing log is not run, with no problem line", () => {
	const dir = workspace({ "sta/opensta.out": "" });
	try {
		const found = timingStepFinding(dir, 0);
		assert.deepEqual(found?.logs, ["sta/opensta.out"]);
		assert.equal(found?.problem, null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("timing check, negative control: a log with slack lines gives no finding, also next to a log without them", () => {
	const dir = workspace({ "sta/sta_setup.log": "Error: cannot open file x.sdc\n" }, { "sta/sta.log": "sta_valid.log" });
	try {
		assert.equal(timingStepFinding(dir, 0), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("timing check, negative control: other logs, old logs and the step logs of a flow run give no finding", () => {
	const dir = workspace({
		"out/sim.log": "ERROR: tb.v:15: syntax error\n",
		"old/sta.log": "Error: 171 a.v line 8, syntax error\n",
		"runs/r1/12-openroad-staprepnr/nom/sta.log": "\n",
		"sta/sta.bin": "\0\0",
	});
	try {
		const old = new Date(Date.now() - 3600_000);
		utimesSync(join(dir, "old", "sta.log"), old, old);
		assert.equal(timingStepFinding(dir, Date.now() - 60_000), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("timing check: what counts as a timing result", () => {
	assert.equal(hasTimingResult("                                  2.05   slack (MET)\n"), true);
	assert.equal(hasTimingResult("                               -158.79   slack (VIOLATED)\n"), true);
	assert.equal(hasTimingResult("Startpoint: a (rising edge-triggered flip-flop clocked by clk)\n"), false, "a path header alone is not a result");
	assert.equal(hasTimingResult("wns max -0.25\n"), true);
	assert.equal(hasTimingResult("worst slack max 1.20\n"), true);
	assert.equal(hasTimingResult("tns 0.00\n"), true);
	assert.equal(hasTimingResult("Error: 1390 acc is not a verilog module.\n"), false);
	assert.equal(hasTimingResult("the slack is fine\n"), false);
});

test("timing check: a path header without a slack line, and a text that starts like a summary line, are no timing result", () => {
	assert.equal(hasTimingResult("Startpoint: u0 (rising edge-triggered flip-flop clocked by clk)\n"), false);
	assert.equal(hasTimingResult("wns max 0 paths reported\n"), false);
	assert.equal(hasTimingResult("worst slack max 1.2.3\n"), false);
	assert.equal(hasTimingResult("   1e-3   slack (MET)\n"), true);
	assert.equal(hasTimingResult("  -2.5E+01   slack (VIOLATED)\n"), true);
	assert.equal(hasTimingResult("wns max -1.5e-2\n"), true);
	const dir = workspace({ "sta/sta.log": "Startpoint: u0\nError: cannot read the library\n" });
	try {
		assert.deepEqual(timingStepFinding(dir, 0)?.logs, ["sta/sta.log"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("timing check: a failed run that is appended to a log with an old slack line is not run", () => {
	// The fixture is a valid log with the log of a failed run appended (a script that writes with >>).
	const dir = workspace({}, { "sta/sta.log": "sta_valid_then_not_a_module.log" });
	try {
		const found = timingStepFinding(dir, 0);
		assert.deepEqual(found?.logs, ["sta/sta.log"]);
		assert.match(found?.problem?.text ?? "", /acc is not a verilog module/);
		assert.match(formatTimingStepFinding(found!), /slack lines? .* older run/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("timing check: with the sizes from before the command, only the new part of a log counts", () => {
	const dir = workspace({}, { "sta/sta.log": "sta_valid.log" });
	try {
		const before = timingLogSizes(dir);
		assert.equal(before.get(join(dir, "sta/sta.log"))?.size, readFileSync(join(dir, "sta/sta.log")).length);
		// The command appends a banner and no result: the old slack line does not count.
		appendFileSync(join(dir, "sta/sta.log"), "OpenSTA 3.2.0\nread_sdc acc.sdc\n");
		assert.deepEqual(timingStepFinding(dir, 0, before)?.logs, ["sta/sta.log"]);
		assert.equal(timingStepFinding(dir, 0), null, "without the sizes, the whole file is read");
		// Negative control: the command appends a new result.
		appendFileSync(join(dir, "sta/sta.log"), readFileSync(join(FIX, "sta_valid.log")));
		assert.equal(timingStepFinding(dir, 0, before), null);
		// A file that the command wrote again from the start is read from the start.
		writeFileSync(join(dir, "sta/sta.log"), "wns max 0.25\n");
		assert.equal(timingStepFinding(dir, 0, before), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("timing check: a log that the command wrote again, longer than before, is read from the start", () => {
	const dir = workspace({ "sta/sta.log": "previous run failed\n" });
	try {
		const before = timingLogSizes(dir);
		// The new content is longer than the old one and starts with the result.
		writeFileSync(join(dir, "sta/sta.log"), "   1e-3   slack (MET)\nreport_checks done, the log has no other result line\n");
		assert.equal(timingStepFinding(dir, 0, before), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
