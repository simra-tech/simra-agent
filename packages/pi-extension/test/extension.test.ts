// The extension against a fake pi API: it registers run_experiment and check_requirements, and both tools run and record.
// Its tool_result hook adds the netlist check to the result of a call that names a netlist.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension, { netlistsOf } from "../index.ts";

const fakeAdapters = new URL("../../kernel/test/fixtures/adapters", import.meta.url).pathname;

test("run_experiment runs the adapter and names the records", async (t) => {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} } as any);
	const tool = tools.get("run_experiment");
	assert.ok(tool, "run_experiment is not registered");
	assert.match(tool.description, /adapter "ngspice", operation "simulate"/);

	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [fakeAdapters] }));

	const result = await tool.execute(
		"call-1",
		{ adapter: "fake", operation: "run", inputs: { mode: "ok" }, purpose: "test" },
		undefined,
		undefined,
		{ cwd: root },
	);
	const text = result.content[0].text;
	assert.match(text, /^experiment \S+: completed/);
	assert.match(text, /x = 1\.5 V/);
	assert.equal(result.details.status, "completed");
	assert.ok(existsSync(join(root, "simra", "experiments", result.details.id, "result.json")));
});

test("check_requirements runs the check and gives the verdict", async (t) => {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} } as any);
	const tool = tools.get("check_requirements");
	assert.ok(tool, "check_requirements is not registered");

	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [fakeAdapters] }));
	writeFileSync(
		join(root, "requirements.json"),
		JSON.stringify({
			schema: "simra.requirements/0",
			conditions: { tt: {} },
			experiments: { dc: { adapter: "fake", operation: "run", inputs: { mode: "ok" } } },
			requirements: [{ id: "out", experiment: "dc", measurement: "x", unit: "V", op: "<=", limit: 1.8, conditions: ["tt"] }],
		}),
	);

	const result = await tool.execute("call-1", {}, undefined, undefined, { cwd: root });
	assert.match(result.content[0].text, /^check \S+: PASS \(1 pass, 0 fail/);
	assert.equal(result.details.status, "pass");
	assert.ok(existsSync(join(root, "simra", "checks", result.details.id, "verdict.json")));
});

test("the tool_result hook adds each netlist warning once", async (t) => {
	let hook: any;
	extension({ registerTool: () => {}, registerCommand: () => {}, on: (event: string, fn: any) => event === "tool_result" && (hook = fn) } as any);
	assert.ok(hook, "no tool_result hook");

	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), "{}");
	writeFileSync(join(root, "tb.spice"), "* tb\n.option rshunt=5e5\n");
	const ctx = { cwd: root };
	const content = [{ type: "text", text: "file text" }];

	const read = await hook({ toolName: "read", input: { path: "tb.spice" }, content, isError: false }, ctx);
	assert.equal(read.content[0].text, "file text");
	assert.match(read.content[1].text, /warning \(tb\.spice:2\): '\.option rshunt=5e5' connects a 500 kΩ resistor/);
	// The same finding is not added again; a call without a netlist is not changed.
	assert.equal(await hook({ toolName: "bash", input: { command: "ngspice -b tb.spice" }, content, isError: false }, ctx), undefined);
	assert.equal(await hook({ toolName: "bash", input: { command: "ls" }, content, isError: false }, ctx), undefined);
});

test("netlistsOf finds the netlists that a call names", (t) => {
	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const f of ["a.spice", "b.cir"]) writeFileSync(join(root, f), "* x\n");
	const bash = { toolName: "bash", input: { command: "cat a.spice > c.spice; ngspice -b ./b.cir 2>&1 | tee log" } } as any;
	assert.deepEqual(netlistsOf(bash, root), [join(root, "a.spice"), join(root, "b.cir")]);
	assert.deepEqual(netlistsOf({ toolName: "write", input: { path: join(root, "a.spice") } } as any, "/"), [join(root, "a.spice")]);
	assert.deepEqual(netlistsOf({ toolName: "grep", input: { path: "a.spice" } } as any, root), []);
});
