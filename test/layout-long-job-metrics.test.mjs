// The job diagnostics of the layout scorer (background_runs, log_reads, deck_wall_s) on fixture transcripts of pi,
// Codex CLI and OpenCode, and the check of the generated task files in run-arm.mjs.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backgroundRun, deckMetrics, logRead } from "../evals/layout-drc-fix/layout.mjs";
import { checkGenerated } from "../evals/run-arm.mjs";

const lines = (events) => events.map((e) => JSON.stringify(e)).join("\n");

test("backgroundRun: a deck that starts with &, nohup, setsid or disown", () => {
	for (const c of [
		"./drc.sh block.gds idac > d.txt 2>&1 &",
		"(./drc.sh block.gds idac > drc.out 2>&1) &",
		"nohup ./lvs.sh block.gds idac > lvs.out 2>&1 &",
		"setsid sh drc.sh block.gds idac",
		"./drc.sh block.gds idac & disown",
		"bash -lc './drc.sh block.gds idac &'",
		"./drc.sh block.gds idac &> d.txt & echo started",
	])
		assert.equal(backgroundRun(c), true, c);
	for (const c of [
		"./drc.sh block.gds idac",
		"./drc.sh block.gds idac && ./lvs.sh block.gds idac",
		"./drc.sh block.gds idac > d.txt 2>&1; echo $?",
		"./drc.sh block.gds idac 2>&1 | tail -20",
		"sleep 5 & wait",
		"nohup python3 fix.py &",
		undefined,
	])
		assert.equal(backgroundRun(c), false, String(c));
});

test("logRead: tail, cat, grep or wc on a file under drc/, lvs/ or simra/experiments/", () => {
	for (const c of [
		"tail -5 drc/drc.log",
		"sleep 30; tail -n 3 drc/drc.log",
		"cat lvs/lvs.log | grep -c match",
		"grep -c '<item>' drc/block_idac_full.lyrdb",
		"wc -l /work/drc/drc.log",
		"tail -3 ./lvs/lvs.log",
		"cat simra/experiments/20261102-1/result.json",
	])
		assert.equal(logRead(c), true, c);
	for (const c of ["cat drc.sh", "ls drc/", "grep M1 $PDK_ROOT/ihp-sg13g2/libs.tech/klayout/tech/drc/sg13g2.drc", "tail -5 d.txt", "head drc/drc.log", undefined])
		assert.equal(logRead(c), false, String(c));
});

test("deckMetrics: background runs, log reads and the deck wall time of a pi transcript", () => {
	const pi = lines([
		{ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "nohup ./drc.sh block.gds idac > drc.out 2>&1 &" } },
		{ type: "tool_execution_end", toolCallId: "a", result: { content: [] }, durationMs: 40 },
		{ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "sleep 60; tail -3 drc/drc.log" } },
		{ type: "tool_execution_end", toolCallId: "b", result: { content: [] }, durationMs: 60_010 },
		{ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "./lvs.sh block.gds idac" } },
		{ type: "tool_execution_start", toolCallId: "d", toolName: "run_experiment", args: { adapter: "klayout", operation: "drc", inputs: {} } },
		{ type: "tool_execution_end", toolCallId: "d", result: { content: [] }, durationMs: 200_000 },
		{ type: "tool_execution_end", toolCallId: "c", result: { content: [] }, durationMs: 95_250 },
		{ type: "tool_execution_start", toolCallId: "e", toolName: "job_start", args: { command: "./drc.sh block.gds idac" } },
		{ type: "tool_execution_end", toolCallId: "e", result: { content: [] }, durationMs: 15 },
		{ type: "tool_execution_start", toolCallId: "f", toolName: "job_status", args: { id: "1" } },
		{ type: "tool_execution_end", toolCallId: "f", result: { content: [] }, durationMs: 5 },
		{ type: "tool_execution_start", toolCallId: "g", toolName: "run_experiment", args: { adapter: "klayout", operation: "query", inputs: {} } },
		{ type: "tool_execution_end", toolCallId: "g", result: { content: [] }, durationMs: 1_000 },
	]);
	// The deck calls: a (0.04 s), c (95.25 s), d (200 s) and the job tool call e (0.015 s: it starts the deck and returns).
	// The query call g is counted in run_experiment, but it is not a deck call.
	assert.deepEqual(deckMetrics(pi), {
		deck_runs: { drc: 2, lvs: 1, run_experiment: { drc: 1, lvs: 0, query: 1, diff: 0 } },
		wait_calls: 1,
		background_runs: 2,
		log_reads: 1,
		deck_wall_s: 295.3,
	});
});

test("deckMetrics: Codex CLI has no run times (deck_wall_s null); OpenCode has them", () => {
	const codex = lines([
		{ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/usr/bin/bash -lc './drc.sh block.gds idac > drc.out 2>&1 &'", aggregated_output: "" } },
		{ type: "item.completed", item: { id: "item_2", type: "command_execution", command: "/usr/bin/bash -lc 'tail -n 5 drc/drc.log'", aggregated_output: "" } },
		{ type: "item.completed", item: { id: "item_3", type: "command_execution", command: "/usr/bin/bash -lc './lvs.sh block.gds idac'", aggregated_output: "" } },
	]);
	assert.deepEqual(deckMetrics(codex), { deck_runs: { drc: 1, lvs: 1, run_experiment: { drc: 0, lvs: 0, query: 0, diff: 0 } }, wait_calls: 0, background_runs: 1, log_reads: 1, deck_wall_s: null });
	const opencode = lines([
		{ type: "tool_use", part: { type: "tool", tool: "bash", callID: "x", state: { input: { command: "./drc.sh block.gds idac" }, output: "", time: { start: 1000, end: 191_000 } } } },
		{ type: "tool_use", part: { type: "tool", tool: "bash", callID: "y", state: { input: { command: "cat lvs/lvs.log" }, output: "", time: { start: 191_500, end: 191_600 } } } },
	]);
	assert.deepEqual(deckMetrics(opencode), { deck_runs: { drc: 1, lvs: 0, run_experiment: { drc: 0, lvs: 0, query: 0, diff: 0 } }, wait_calls: 0, background_runs: 0, log_reads: 1, deck_wall_s: 190 });
	// A transcript with run times but no deck call: 0 s.
	const none = lines([
		{ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "ls" } },
		{ type: "tool_execution_end", toolCallId: "a", result: { content: [] }, durationMs: 12 },
	]);
	assert.equal(deckMetrics(none).deck_wall_s, 0);
});

test("checkGenerated: a generated task file must exist with its recorded hash", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "simra-generated-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// SHA-256 of "abc".
	const task = { generated: { "big.gds": { sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", command: "make big.gds" } } };
	assert.throws(() => checkGenerated(dir, task), /big\.gds not found: make it with make big\.gds/);
	writeFileSync(join(dir, "big.gds"), "abd");
	assert.throws(() => checkGenerated(dir, task), /expected ba7816bf/);
	writeFileSync(join(dir, "big.gds"), "abc");
	checkGenerated(dir, task);
	checkGenerated(dir, {});
});
