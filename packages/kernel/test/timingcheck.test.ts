import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatTimingStepFinding, hasTimingResult, timingStepFinding } from "../src/timingcheck.ts";

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
	assert.equal(hasTimingResult("Startpoint: a (rising edge-triggered flip-flop clocked by clk)\n"), true);
	assert.equal(hasTimingResult("wns max -0.25\n"), true);
	assert.equal(hasTimingResult("worst slack max 1.20\n"), true);
	assert.equal(hasTimingResult("tns 0.00\n"), true);
	assert.equal(hasTimingResult("Error: 1390 acc is not a verilog module.\n"), false);
	assert.equal(hasTimingResult("the slack is fine\n"), false);
});
