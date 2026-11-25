import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandFindings, errorLines, formatCommandFindings } from "../src/commandcheck.ts";

function workspace(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "simra-commandcheck-"));
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

test("command check: a log with an error line and an empty result file are findings", () => {
	const dir = workspace({
		"out/sim.log": "WARNING: tb.v:3: note\nERROR: tb/tb.v:15: $readmemh: Unable to open stim.hex for reading.\n",
		"out/result.txt": "",
		"sta/sta.log": "Error: 171 ../syn/fir.nl.v line 8, syntax error\n",
	});
	try {
		const found = commandFindings(dir, 0);
		assert.deepEqual(found.map((f) => `${f.kind} ${f.path}`), ["empty_file out/result.txt", "error_lines out/sim.log", "error_lines sta/sta.log"]);
		const note = formatCommandFindings(found) ?? "";
		assert.match(note, /exit code 0/);
		assert.match(note, /out\/sim\.log has 1 error line: 2: ERROR: tb\/tb\.v:15/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("command check, negative control: warnings, zero counts, empty logs and old files give no finding", () => {
	const dir = workspace({
		"out/sim.log": "WARNING: tb/tb.v:15: $readmemh: Not enough words in the file for the requested range [0:1023].\n1000 vectors\n",
		"runs/r1/error.log": "",
		"runs/r1/flow.log": "Check for Lint errors clear.\n0 errors, 2 warnings\nerrors: 0\n[INFO] No errors found\n",
		"report.rpt": "",
		"old/sta.log": "Error: old run\n",
		"simra/experiments/x/work/tool.log": "Error: inside a record\n",
	});
	try {
		const past = new Date(Date.now() - 3_600_000);
		utimesSync(join(dir, "old/sta.log"), past, past);
		assert.deepEqual(commandFindings(dir, Date.now() - 60_000), []);
		assert.equal(formatCommandFindings([]), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("errorLines: tool error forms", () => {
	const text = ["[ERROR RSZ-0060] Max buffer count reached.", "Error: rsz.tcl, 58 RSZ-0060", "%Error: a.v:1: syntax", "Traceback (most recent call last):", "sh: 1: vvp: command not found", "[INFO] Error model loaded", "no errors"].join("\n");
	assert.deepEqual(errorLines(text).map((l) => l.line), [1, 2, 3, 4, 5]);
});
