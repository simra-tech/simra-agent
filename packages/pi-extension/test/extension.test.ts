// The extension against a fake pi API: it registers run_experiment, wait_experiments, check_requirements and design_record, and the tools run and record.
// Its tool_result hook adds the netlist check to the result of a call that names a netlist.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateRequirements } from "@simra-tech/kernel";
import extension, { netlistsOf, REQUIREMENTS_EXAMPLE, sessionClock } from "../index.ts";

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

test("run_experiment adds the PNG outputs of role image as image parts after the text, up to the limits", async (t) => {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} } as any);
	const run = tools.get("run_experiment");
	assert.ok(run.promptGuidelines.some((g: string) => /operation render/.test(g) && /Look at the picture/.test(g)));
	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [fakeAdapters] }));
	const ctx = { cwd: root };
	const one = await run.execute("call-1", { adapter: "fake", operation: "run", inputs: { mode: "image" }, purpose: "picture" }, undefined, undefined, ctx);
	assert.equal(one.content.length, 2);
	assert.match(one.content[0].text, /^outputs:\n.*render\.json \(2 bytes\)\n  image .*render-1\.png \(\d+ bytes\)$/m);
	assert.deepEqual(one.content[1], { type: "image", data: readFileSync(join(root, "simra/experiments", one.details.id, "work/render-1.png")).toString("base64"), mimeType: "image/png" });
	// Six images: four parts (the first four).
	const six = await run.execute("call-2", { adapter: "fake", operation: "run", inputs: { mode: "image", count: 6 }, purpose: "pictures" }, undefined, undefined, ctx);
	assert.equal(six.content.filter((c: any) => c.type === "image").length, 4);
	// Images over the byte limit in all are skipped; the text still names them.
	const big = await run.execute("call-3", { adapter: "fake", operation: "run", inputs: { mode: "image", count: 2, bytes: 600_000 }, purpose: "big" }, undefined, undefined, ctx);
	assert.equal(big.content.filter((c: any) => c.type === "image").length, 1);
	assert.match(big.content[0].text, /image .*render-2\.png \(600000 bytes\)/);
	// A detached run: wait_experiments carries the image too.
	const started = await run.execute("call-4", { adapter: "fake", operation: "run", inputs: { mode: "image" }, purpose: "detached", detached: true }, undefined, undefined, ctx);
	const done = await tools.get("wait_experiments").execute("call-5", { ids: [started.details.id], timeout_s: 30 }, undefined, undefined, ctx);
	assert.equal(done.content.filter((c: any) => c.type === "image").length, 1);
});

test("run_experiment detached starts the run, and wait_experiments gives the summary of a blocking run", async (t) => {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} } as any);
	const run = tools.get("run_experiment");
	const wait = tools.get("wait_experiments");
	assert.ok(wait, "wait_experiments is not registered");
	// The parameters: detached is an optional boolean; ids is a list, timeout_s is optional.
	assert.equal(run.parameters.properties.detached.type, "boolean");
	assert.ok(!(run.parameters.required ?? []).includes("detached"));
	assert.equal(wait.parameters.properties.ids.type, "array");
	assert.equal(wait.parameters.properties.ids.items.type, "string");
	assert.equal(wait.parameters.properties.timeout_s.type, "number");
	assert.deepEqual(wait.parameters.required, ["ids"]);
	assert.match(run.description, /Use detached for a\nrun that takes minutes, or for two runs that are independent/);
	assert.match(wait.description, /The call blocks until every listed experiment\nhas ended, or until timeout_s/);
	assert.ok(run.promptGuidelines.includes(
		"For a run that takes minutes, or for independent runs, start them with run_experiment detached and wait_experiments; do not poll with sleep, tail or log reads.",
	));
	assert.ok(run.promptGuidelines.includes(
		"To read a layout, use run_experiment with adapter klayout, operation query, and put several questions in one call. To see what an edit or a commit changed, use operation diff (against a file or git:<ref>). Write Python only to change a layout.",
	));

	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [fakeAdapters] }));
	const ctx = { cwd: root };
	const blocking = await run.execute("call-1", { adapter: "fake", operation: "run", inputs: { mode: "ok" }, purpose: "first" }, undefined, undefined, ctx);
	assert.doesNotMatch(blocking.content[0].text, /^estimate:/m);

	const started = await run.execute("call-2", { adapter: "fake", operation: "run", inputs: { mode: "slow", seconds: 6 }, purpose: "slow", detached: true }, undefined, undefined, ctx);
	const id = started.details.id;
	assert.equal(started.details.status, "running");
	const text = started.content[0].text;
	assert.match(text, new RegExp(`^experiment ${id}: running \\(detached\\)\n`));
	assert.match(text, /^estimate: earlier runs of fake run on this design took [\d.]+ s \(1 run\)$/m);
	assert.match(text, new RegExp(`^wait: wait_experiments with ids \\["${id}"\\]$`, "m"));
	assert.equal(existsSync(join(root, "simra", "experiments", id, "result.json")), false);

	const early = await wait.execute("call-3", { ids: [id], timeout_s: 1 }, undefined, undefined, ctx);
	assert.match(early.content[0].text, new RegExp(`^experiment ${id}: still running after 1 s \\(records: simra/experiments/${id}/\\)$`));
	assert.deepEqual(early.details.experiments.map((e: any) => e.status), ["running"]);
	const done = await wait.execute("call-4", { ids: [id, blocking.details.id] }, undefined, undefined, ctx);
	const [first, second] = done.content[0].text.split("\n\n");
	assert.match(first, new RegExp(`^experiment ${id}: completed`));
	assert.match(first, /^estimate: earlier runs of fake run on this design took [\d.]+ s \(1 run\)$/m);
	assert.match(first, /^ {2}x = 1\.5 V$/m);
	assert.match(second, new RegExp(`^experiment ${blocking.details.id}: completed`));
	assert.deepEqual(done.details.experiments.map((e: any) => e.status), ["completed", "completed"]);
});

test("check_requirements runs the check and gives the verdict", async (t) => {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} } as any);
	const tool = tools.get("check_requirements");
	assert.ok(tool, "check_requirements is not registered");
	// The description gives the file format with a valid example.
	assert.ok(tool.description.includes(REQUIREMENTS_EXAMPLE));
	assert.deepEqual(validateRequirements(JSON.parse(REQUIREMENTS_EXAMPLE)), []);
	// It names the condition inputs of ngspice and the sweep convention.
	assert.match(tool.description, /params .* and temp_c/);
	assert.match(tool.description, /'ROW <sweep>=<v> <name>=<value> \.\.\.'/);
	// It names the requirements without conditions; the adapter catalog names the design check.
	assert.match(tool.description, /A requirement without conditions runs its\n {2}experiment once/);
	assert.doesNotMatch(tool.description, /check_design|ngspice operation/);
	assert.match(tools.get("run_experiment").description, /adapter "ngspice", operation "check_design"/);

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

test("the session clock gives a time note once after 50 % and once after 80 %", () => {
	const min = 60_000;
	const note = sessionClock(0, 30 * min);
	assert.equal(note(10 * min), null);
	assert.match(note(15 * min) ?? "", /15 of 30 min used, 15 min left\.\nWrite the output files/);
	assert.equal(note(16 * min), null);
	assert.match(note(25 * min) ?? "", /25 of 30 min used, 5 min left/);
	assert.equal(note(29 * min), null);
	// A first call after both marks gives one note, not two.
	const late = sessionClock(0, 30 * min);
	assert.match(late(27 * min) ?? "", /27 of 30 min used/);
	assert.equal(late(28 * min), null);
});

test("the tool_result hook adds the time note when SIMRA_SESSION_DEADLINE is set", async (t) => {
	const saved = process.env.SIMRA_SESSION_DEADLINE;
	t.after(() => (saved === undefined ? delete process.env.SIMRA_SESSION_DEADLINE : (process.env.SIMRA_SESSION_DEADLINE = saved)));
	process.env.SIMRA_SESSION_DEADLINE = new Date(Date.now() + 50).toISOString();
	let hook: any;
	extension({ registerTool: () => {}, registerCommand: () => {}, on: (event: string, fn: any) => event === "tool_result" && (hook = fn) } as any);
	await new Promise((r) => setTimeout(r, 80));
	const content = [{ type: "text", text: "ok" }];
	const r = await hook({ toolName: "bash", input: { command: "ls" }, content, isError: false }, { cwd: tmpdir() });
	assert.deepEqual(r.content[0], content[0]);
	assert.match(r.content[1].text, /Simra session time: .* 0 min left\./);
	assert.equal(await hook({ toolName: "bash", input: { command: "ls" }, content, isError: false }, { cwd: tmpdir() }), undefined);
});

test("design_record gives the checks of each file of record, and the guideline about stale checks", async (t) => {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} } as any);
	const tool = tools.get("design_record");
	assert.ok(tool, "design_record is not registered");
	assert.equal(tool.parameters.properties.paths.type, "array");
	assert.ok(!(tool.parameters.required ?? []).includes("paths"));
	assert.ok(tool.promptGuidelines.some((g: string) => g.startsWith("A verdict counts only for the file that it ran on.")));
	assert.ok(tool.promptGuidelines.some((g: string) => /do not overwrite it with your own earlier copy/.test(g)));

	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), "{}");
	writeFileSync(join(root, "block.gds"), "v2");
	const id = "20261103-100000-aaaaaa";
	const dir = join(root, "simra", "experiments", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "experiment.json"), JSON.stringify({
		id, created_at: "2026-11-03T10:00:00Z", purpose: "drc", adapter: { name: "klayout" }, operation: "drc", inputs: {}, design: {},
	}));
	const v1 = "a".repeat(64);
	writeFileSync(join(dir, "result.json"), JSON.stringify({
		status: "completed", measurements: { markers: { value: 3, unit: null, status: "measured" } },
		input_files: { complete: true, files: [{ path: "block.gds", sha256: v1, role: "layout" }] },
	}));
	const result = await tool.execute("call-1", { paths: ["block.gds"] }, undefined, undefined, { cwd: root });
	const text = result.content[0].text;
	assert.match(text, /^layout block\.gds sha256:[0-9a-f]{12}\n {2}no check on the current file\n/);
	assert.match(text, new RegExp(`^  ${id} klayout drc completed markers=3 \\(stale: ran on sha256:aaaaaaaaaaaa\\)$`, "m"));
	assert.deepEqual(result.details.files, [{ path: "block.gds", sha256: result.details.files[0].sha256, current: [], stale: [id] }]);
});
