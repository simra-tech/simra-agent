// The digital flow hooks of the extension: which run directories and tools a call touches, and the notes that the
// tool_result hook adds to a bash result (the flow check of the librelane adapter and the command check).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension, { flowFindingKey, flowRunsOf, flowToolsOf, isFlowRun } from "../index.ts";

const TYP = "nom_typ_1p20V_25C";
const SLOW = "nom_slow_1p08V_125C";

function put(path: string, data: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
}

/** A small LibreLane run: timing without wires for two corners, then a placement and a timing step for one or two corners. */
function makeRun(design: string, tag: string, midCorners: string[]): string {
	const run = join(design, "runs", tag);
	put(join(run, "resolved.json"), { DESIGN_DIR: design, STA_CORNERS: [SLOW, TYP], DEFAULT_CORNER: TYP });
	const pre = { [`timing__setup__ws__corner:${SLOW}`]: 0.95, [`timing__setup__ws__corner:${TYP}`]: 3.0 };
	const stepDir = (name: string) => join(run, name);
	put(join(stepDir("12-openroad-staprepnr"), "config.json"), { meta: { step: "OpenROAD.STAPrePNR" } });
	put(join(stepDir("12-openroad-staprepnr"), "state_in.json"), { metrics: {} });
	put(join(stepDir("12-openroad-staprepnr"), "state_out.json"), { metrics: pre });
	for (const corner of [SLOW, TYP]) put(join(stepDir("12-openroad-staprepnr"), corner, "sta.log"), "\n");
	put(join(stepDir("28-openroad-globalplacement"), "config.json"), { meta: { step: "OpenROAD.GlobalPlacement" } });
	put(join(stepDir("28-openroad-globalplacement"), "state_out.json"), { metrics: pre });
	const mid = Object.fromEntries(midCorners.map((c) => [`timing__setup__ws__corner:${c}`, 1.6]));
	put(join(stepDir("31-openroad-stamidpnr"), "config.json"), { meta: { step: "OpenROAD.STAMidPNR" } });
	put(join(stepDir("31-openroad-stamidpnr"), "or_metrics_out.json"), mid);
	put(join(stepDir("31-openroad-stamidpnr"), "state_out.json"), { metrics: { ...pre, ...mid } });
	return run;
}

function hooks() {
	const handlers = new Map<string, any[]>();
	extension({ registerTool: () => {}, registerCommand: () => {}, on: (name: string, h: any) => handlers.set(name, [...(handlers.get(name) ?? []), h]) } as any);
	return async (name: string, event: any, ctx: any) => {
		let last;
		for (const h of handlers.get(name) ?? []) last = (await h(event, ctx)) ?? last;
		return last;
	};
}

test("flowToolsOf and flowRunsOf find the tools and the run directories of a call", () => {
	const design = mkdtempSync(join(tmpdir(), "simra-flow-"));
	try {
		const run = makeRun(design, "r1", [TYP]);
		assert.ok(isFlowRun(run));
		assert.ok(!isFlowRun(design));
		assert.deepEqual(flowToolsOf({ toolName: "bash", input: { command: "librelane --run-tag r1 config.json" } }), ["librelane", "openroad", "yosys"]);
		assert.deepEqual(flowToolsOf({ toolName: "bash", input: { command: "cat status.txt && ls" } }), []);
		assert.deepEqual(flowRunsOf({ toolName: "bash", input: { command: "cat runs/r1/31-openroad-stamidpnr/state_out.json | head" } }, design, null), [run]);
		assert.deepEqual(flowRunsOf({ toolName: "read", input: { path: "runs/r1/resolved.json" } }, design, null), [run]);
		assert.deepEqual(flowRunsOf({ toolName: "bash", input: { command: "librelane --run-tag r1 config.json" } }, design, 0), [run]);
		assert.deepEqual(flowRunsOf({ toolName: "bash", input: { command: "ls src" } }, design, 0), []);
		assert.equal(flowFindingKey("slack +0.954 ns at step 12"), flowFindingKey("slack -1.2 ns at step 43"));
	} finally {
		rmSync(design, { recursive: true, force: true });
	}
});

test("tool_result: the flow check adds its finding once, and the command check (when it is on) reports a log with an error", async () => {
	const design = mkdtempSync(join(tmpdir(), "simra-flow-"));
	process.env.SIMRA_COMMAND_CHECK = "on";
	try {
		makeRun(design, "r1", [TYP]);
		const emit = hooks();
		const ctx = { cwd: design };
		const call = { toolName: "bash", toolCallId: "c1", input: { command: "cat runs/r1/31-openroad-stamidpnr/state_out.json" } };
		await emit("tool_call", call, ctx);
		put(join(design, "sta", "sta.log"), "Error: 171 fir.nl.v line 8, syntax error\n");
		const first = await emit("tool_result", { ...call, content: [{ type: "text", text: "{}" }], isError: false }, ctx);
		const text = first.content.map((c: any) => c.text).join("\n");
		assert.match(text, /Simra flow check of runs\/r1/);
		assert.match(text, /carry the old values/);
		assert.match(text, /Simra command check/);
		assert.match(text, /sta\/sta\.log has 1 error line/);
		const again = { ...call, toolCallId: "c2" };
		await emit("tool_call", again, ctx);
		const second = await emit("tool_result", { ...again, content: [{ type: "text", text: "{}" }], isError: false }, ctx);
		assert.equal(second, undefined, "a finding is shown once; a file that did not change is not checked again");
	} finally {
		delete process.env.SIMRA_COMMAND_CHECK;
		rmSync(design, { recursive: true, force: true });
	}
});

test("tool_result: the command check is off by default", async () => {
	const design = mkdtempSync(join(tmpdir(), "simra-flow-"));
	try {
		const emit = hooks();
		const call = { toolName: "bash", toolCallId: "c1", input: { command: "./run_sim.sh" } };
		await emit("tool_call", call, { cwd: design });
		put(join(design, "out", "sim.log"), "Error: 171 tb.v line 8, syntax error\n");
		assert.equal(await emit("tool_result", { ...call, content: [{ type: "text", text: "done" }], isError: false }, { cwd: design }), undefined);
	} finally {
		rmSync(design, { recursive: true, force: true });
	}
});

test("tool_result: a timing step that wrote a log and no slack line is reported as not run", async () => {
	const design = mkdtempSync(join(tmpdir(), "simra-flow-"));
	try {
		const emit = hooks();
		const ctx = { cwd: design };
		const call = { toolName: "bash", toolCallId: "c1", input: { command: "./run_sta.sh" } };
		await emit("tool_call", call, ctx);
		put(join(design, "sta", "sta.log"), "Error: 1390 acc is not a verilog module.\n");
		const first = await emit("tool_result", { ...call, content: [{ type: "text", text: "sta done" }], isError: false }, ctx);
		const text = first.content.map((c: any) => c.text).join("\n");
		assert.match(text, /Simra timing check: not run/);
		assert.match(text, /sta\/sta\.log:1: Error: 1390 acc is not a verilog module/);
		assert.doesNotMatch(text, /Simra command check/, "the command check is off by default");
		// A command that failed has its own error: no note.
		const failed = { ...call, toolCallId: "c2" };
		await emit("tool_call", failed, ctx);
		put(join(design, "sta", "sta.log"), "Error: 1390 acc is not a verilog module.\n");
		assert.equal(await emit("tool_result", { ...failed, content: [{ type: "text", text: "exit 1" }], isError: true }, ctx), undefined);
		// With slack lines in the new log: no note.
		const good = { ...call, toolCallId: "c3" };
		await emit("tool_call", good, ctx);
		put(join(design, "sta", "sta.log"), "Startpoint: a\n   2.05   slack (MET)\n");
		assert.equal(await emit("tool_result", { ...good, content: [{ type: "text", text: "sta done" }], isError: false }, ctx), undefined);
	} finally {
		rmSync(design, { recursive: true, force: true });
	}
});

test("tool_result: a command that appends a failed timing run to a log with an old slack line is reported as not run", async () => {
	const design = mkdtempSync(join(tmpdir(), "simra-flow-"));
	try {
		const emit = hooks();
		const ctx = { cwd: design };
		const old = "Startpoint: a\n   2.05   slack (MET)\nwns max 0.00\n";
		put(join(design, "sta", "sta.log"), old);
		const call = { toolName: "bash", toolCallId: "c1", input: { command: "./run_sta.sh >> sta/sta.log" } };
		await emit("tool_call", call, ctx);
		// The new part has no error line that the check knows: only the sizes from before the command show that it has no result.
		put(join(design, "sta", "sta.log"), `${old}OpenSTA 3.2.0\nWarning: the library has no cells\n`);
		const result = await emit("tool_result", { ...call, content: [{ type: "text", text: "sta done" }], isError: false }, ctx);
		const text = result.content.map((c: any) => c.text).join("\n");
		assert.match(text, /Simra timing check: not run/);
		assert.match(text, /from an older run/);
	} finally {
		rmSync(design, { recursive: true, force: true });
	}
});

test("tool_result: SIMRA_FLOW_CHECK=off turns the timing step check off", async () => {
	const design = mkdtempSync(join(tmpdir(), "simra-flow-"));
	process.env.SIMRA_FLOW_CHECK = "off";
	try {
		const emit = hooks();
		const call = { toolName: "bash", toolCallId: "c1", input: { command: "./run_sta.sh" } };
		await emit("tool_call", call, { cwd: design });
		put(join(design, "sta", "sta.log"), "Error: 1390 acc is not a verilog module.\n");
		assert.equal(await emit("tool_result", { ...call, content: [{ type: "text", text: "sta done" }], isError: false }, { cwd: design }), undefined);
	} finally {
		delete process.env.SIMRA_FLOW_CHECK;
		rmSync(design, { recursive: true, force: true });
	}
});

test("tool_result, negative control: a clean run and a clean command add no note", async () => {
	const design = mkdtempSync(join(tmpdir(), "simra-flow-"));
	process.env.SIMRA_COMMAND_CHECK = "on";
	try {
		makeRun(design, "r1", [SLOW, TYP]);
		const emit = hooks();
		const ctx = { cwd: design };
		const call = { toolName: "bash", toolCallId: "c1", input: { command: "cat runs/r1/31-openroad-stamidpnr/state_out.json" } };
		await emit("tool_call", call, ctx);
		put(join(design, "out", "sim.log"), "WARNING: not enough words\n1000 vectors\n");
		const result = await emit("tool_result", { ...call, content: [{ type: "text", text: "{}" }], isError: false }, ctx);
		assert.equal(result, undefined);
	} finally {
		delete process.env.SIMRA_COMMAND_CHECK;
		rmSync(design, { recursive: true, force: true });
	}
});
