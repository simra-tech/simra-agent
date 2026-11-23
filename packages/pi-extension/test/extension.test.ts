// The extension against a fake pi API: it registers run_experiment, wait_experiments, check_requirements and design_record, and the tools run and record.
// Its tool_result hook adds the netlist check to the result of a call that names a netlist.
// Its tool_call hook sends a read of a PDF to the page-marked text in the cache, and a read of <file>.pdf#page=N to an
// image of page N that it renders first.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { validateRequirements } from "@simra-tech/kernel";
import { makePdf } from "../../kernel/test/pdf-fixture.ts";
import extension, { adapterCatalog, endGuardItems, endGuardMessage, END_GUARD_TYPE, checkHints, leanContext, netlistsOf, readsOutputs, readPath, readsRecords, REQUIREMENTS_EXAMPLE, sessionClock } from "../index.ts";

const fakeAdapters = new URL("../../kernel/test/fixtures/adapters", import.meta.url).pathname;

test("the adapter list of run_experiment has the adapters of the user's directory", (t) => {
	const data = mkdtempSync(join(tmpdir(), "simra-ext-data-"));
	const saved = process.env.XDG_DATA_HOME;
	t.after(() => {
		if (saved === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = saved;
		rmSync(data, { recursive: true, force: true });
	});
	process.env.XDG_DATA_HOME = data;
	assert.doesNotMatch(adapterCatalog(), /adapter "fake"/);
	cpSync(join(fakeAdapters, "fake"), join(data, "simra", "adapters", "fake"), { recursive: true });
	assert.match(adapterCatalog(), /adapter "fake", operation "run"/);
	assert.match(adapterCatalog(), /adapter "ngspice", operation "simulate"/);
});

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
	assert.ok(run.promptGuidelines.some((g: string) => /operation render/.test(g) && /not for every marker/.test(g)));
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

/** The tool_call hook, and a folder with manual.pdf (page 2 without text), broken.pdf and the cache. */
function pdfHook(t: { after: (fn: () => void) => void }) {
	let hook: any;
	extension({ registerTool: () => {}, registerCommand: () => {}, on: (event: string, fn: any) => event === "tool_call" && (hook = fn) } as any);
	assert.ok(hook, "no tool_call hook");
	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const saved = process.env.SIMRA_CACHE_DIR;
	process.env.SIMRA_CACHE_DIR = join(root, "cache");
	t.after(() => (saved === undefined ? delete process.env.SIMRA_CACHE_DIR : (process.env.SIMRA_CACHE_DIR = saved)));
	writeFileSync(join(root, "manual.pdf"), makePdf([{ lines: ["VDD = 1.2 V"] }, {}]));
	writeFileSync(join(root, "broken.pdf"), "not a pdf");
	return { hook, root };
}

test("the tool_call hook sends a read of a PDF to document.md in the cache", async (t) => {
	const { hook, root } = pdfHook(t);
	const ctx = { cwd: root };

	const read = { toolName: "read", input: { path: "manual.pdf", offset: 5 } };
	assert.equal(await hook(read, ctx), undefined);
	assert.match(read.input.path, new RegExp(`^${join(root, "cache", "pdf")}/[0-9a-f]{64}/document\\.md$`));
	assert.equal(read.input.offset, 5);
	assert.match(readFileSync(read.input.path, "utf8"), /\[page 1\]\nVDD = 1\.2 V\n\n\[page 2\]\n\(no text layer\. To see this page, read the PDF path with #page=2 at the end\)\n/);
	// A broken PDF blocks the call with the reason. Other calls do not change.
	assert.deepEqual(await hook({ toolName: "read", input: { path: "broken.pdf" } }, ctx), {
		block: true,
		reason: `Simra PDF reader: ${join(root, "broken.pdf")}: cannot read the PDF (Invalid PDF structure.). The file is broken or is not a PDF.`,
	});
	for (const call of [{ toolName: "read", input: { path: "notes.txt" } }, { toolName: "bash", input: { command: "cat manual.pdf" } }]) {
		const before = structuredClone(call);
		assert.equal(await hook(call, ctx), undefined);
		assert.deepEqual(call, before);
	}
});

test("the tool_call hook renders page N for a read of <file>.pdf#page=N, if the model has image input", async (t) => {
	const { hook, root } = pdfHook(t);
	const ctx = { cwd: root, model: { id: "vision", input: ["text", "image"] } };
	const read = { toolName: "read", input: { path: "manual.pdf#page=2" } };
	assert.equal(await hook(read, ctx), undefined);
	assert.match(read.input.path, new RegExp(`^${join(root, "cache", "pdf")}/[0-9a-f]{64}/page-2\\.png$`));
	assert.deepEqual([...readFileSync(read.input.path).subarray(0, 4)], [137, 80, 78, 71]);
	assert.deepEqual(await hook({ toolName: "read", input: { path: "manual.pdf#page=3" } }, ctx), {
		block: true,
		reason: "Simra PDF reader: page 3: the PDF has pages 1-2",
	});
	// A model without image input: the call is blocked with the reason, and no page is rendered.
	const textOnly = { cwd: root, model: { id: "text-only", input: ["text"] } };
	assert.deepEqual(await hook({ toolName: "read", input: { path: "manual.pdf#page=1" } }, textOnly), {
		block: true,
		reason: "Simra PDF reader: the model text-only has no image input, so it cannot see page 1. Read the text after [page 1] in manual.pdf, or use a model with image input.",
	});
	assert.equal(existsSync(join(dirname(read.input.path), "page-1.png")), false);
});

test("readPath gives the path that pi's read opens", async (t) => {
	assert.equal(await readPath("docs/a.pdf", "/w"), "/w/docs/a.pdf");
	assert.equal(await readPath("@a.pdf", "/w"), "/w/a.pdf");
	assert.equal(await readPath("file:///x/a%20b.pdf", "/w"), "/x/a b.pdf");
	assert.equal(await readPath("~/a.pdf", "/w"), join(homedir(), "a.pdf"));
	// pi's fallback for a macOS file name: a straight apostrophe finds the file with a curly one.
	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "Capture d\u2019écran.pdf"), "");
	assert.equal(await readPath("Capture d'écran.pdf", root), join(root, "Capture d\u2019écran.pdf"));
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

test("run_jobs runs N jobs and gives one line per job; assumption_rows lists the rows of an assumption", async (t) => {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} } as any);
	const jobs = tools.get("run_jobs");
	assert.ok(jobs, "run_jobs is not registered");
	assert.ok(jobs.promptGuidelines.some((g: string) => /pgrep/.test(g)));
	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [fakeAdapters] }));
	const ctx = { cwd: root };
	const out = await jobs.execute("call-j", { jobs: [{ adapter: "fake", operation: "run", inputs: { mode: "ok" } }, { adapter: "fake", operation: "run", inputs: { mode: "failed" } }], parallel: 2 }, undefined, undefined, ctx);
	assert.deepEqual(out.details.jobs.map((j: any) => j.status), ["completed", "failed"]);
	assert.match(out.content[0].text, /^jobs: 2 \(1 completed, 1 failed\)/m);

	const rows = tools.get("assumption_rows");
	assert.ok(rows, "assumption_rows is not registered");
	writeFileSync(join(root, "requirements.json"), JSON.stringify({
		schema: "simra.requirements/0",
		assumptions: { leak: { description: "leakage level", value: -34, unit: "dBm" } },
		conditions: {},
		experiments: { e: { adapter: "fake", operation: "run", inputs: { mode: "ok" } } },
		requirements: [{ id: "x", experiment: "e", measurement: "x", op: ">=", limit: 1, assumptions: ["leak"] }],
	}));
	const listed = await rows.execute("call-a", { id: "leak" }, undefined, undefined, ctx);
	assert.match(listed.content[0].text, /^assumption leak: leakage level = -34 dBm\n {2}requirement x via requirement; conditions \(none\)$/);
	assert.deepEqual(listed.details.assumptions, [{ id: "leak", requirements: ["x"] }]);
});

test("em_sparameters runs one job per port, merges, and lists S at the requested frequencies", async (t) => {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} } as any);
	const em = tools.get("em_sparameters");
	assert.ok(em, "em_sparameters is not registered");
	assert.ok(em.promptGuidelines.some((g: string) => /em_sparameters/.test(g)));
	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [fakeAdapters] }));
	const ports = [{ name: "in", x: 0, y: 0, from: "Metal1", to: "TopMetal2" }, { name: "out", x: 300, y: 0, from: "Metal1", to: "TopMetal2" }];
	const out = await em.execute("call-e", { adapter: "openems-fake", inputs: { ports }, parallel: 2, report_at_hz: [1e9, 1.6e9] }, undefined, undefined, { cwd: root });
	assert.match(out.details.touchstone, /line\.s2p$/);
	assert.deepEqual(out.details.points.map((p: any) => p.f_hz), [1e9, 2e9]);
	assert.match(out.content[0].text, /^1 GHz: S11 -20\.000 dB 0\.00 deg, S12 -0\.915 dB 0\.00 deg/m);
	assert.match(out.content[0].text, /^2 GHz \(nearest point to 1\.6 GHz\): /m);
	const bad = await em.execute("call-f", { adapter: "openems-fake", inputs: { ports, unconverged_port: 1 }, parallel: 2 }, undefined, undefined, { cwd: root });
	assert.equal(bad.details.touchstone, null);
	assert.match(bad.content[0].text, /no Touchstone file/);
});

test("workarounds lists the registry; run_experiment shows the gaps of its adapter and PDK once per session", async (t) => {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: () => {} } as any);
	const wa = tools.get("workarounds");
	assert.ok(wa, "workarounds is not registered");
	const listed = await wa.execute("call-w", { simulator: "xyce", pdk: "ihp-sg13g2" });
	assert.ok(listed.details.ids.includes("xyce-sg13g2-psp103"));
	const root = mkdtempSync(join(tmpdir(), "simra-ext-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// an adapter named xyce (the fake adapter under another name) so that the registry has entries for it
	const dir = join(root, "adapters", "xyce");
	mkdirSync(dir, { recursive: true });
	const fake = JSON.parse(readFileSync(join(fakeAdapters, "fake", "adapter.json"), "utf8"));
	writeFileSync(join(dir, "adapter.json"), JSON.stringify({ ...fake, name: "xyce", command: fake.command.map((c: string) => c.replace("{adapter_dir}", join(fakeAdapters, "fake"))) }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(root, "adapters")], environments: { local: { kind: "local", env: { PDK: "ihp-sg13g2" } } } }));
	const run = tools.get("run_experiment");
	const first = await run.execute("call-r1", { adapter: "xyce", operation: "run", inputs: { mode: "ok" }, purpose: "test" }, undefined, undefined, { cwd: root });
	assert.match(first.content[0].text, /known gaps of xyce with ihp-sg13g2 \(workaround registry/);
	assert.match(first.content[0].text, /xyce-sg13g2-psp103/);
	const second = await run.execute("call-r2", { adapter: "xyce", operation: "run", inputs: { mode: "ok" }, purpose: "test" }, undefined, undefined, { cwd: root });
	assert.doesNotMatch(second.content[0].text, /known gaps/);
});

test("readsRecords finds the calls that read record files", () => {
	const bash = (command: string) => ({ toolName: "bash", input: { command } }) as any;
	assert.equal(readsRecords(bash("cat simra/experiments/20261115-1/result.json | jq .measurements")), true);
	assert.equal(readsRecords(bash("python3 -c 'import json; json.load(open(\"simra/checks/x/verdict.json\"))'")), true);
	assert.equal(readsRecords({ toolName: "read", input: { path: "/w/simra/checks/abc/verdict.json" } } as any), true);
	// a work file of an experiment (a log, a Touchstone file) is not a record
	assert.equal(readsRecords(bash("tail -20 simra/experiments/20261115-1/work/ngspice.log")), false);
	assert.equal(readsRecords(bash("ls lna.spice")), false);
});

test("checkHints names the query of the check and the stability diagnosis of a failed mu row", () => {
	const rows = [
		{ requirement: "mu", status: "fail", condition: "tt", experiment: "e1" },
		{ requirement: "gain", status: "pass", condition: "tt", experiment: "e1" },
	];
	const text = checkHints("c1", rows);
	assert.match(text, /query_results with source "checks", check "c1"/);
	assert.match(text, /tt: experiment e1\): run_experiment with adapter ngspice, operation stability_diagnosis/);
	assert.doesNotMatch(checkHints("c2", [rows[1]]), /stability_diagnosis/);
});

test("leanContext leaves out earlier reasoning and earlier state notes, and keeps the last ones", () => {
	const a = (blocks: unknown[]) => ({ role: "assistant", content: blocks });
	const msgs = [
		{ role: "user", content: "task" },
		a([{ type: "thinking", thinking: "old" }, { type: "toolCall", name: "state_note", arguments: { note: "n1" } }]),
		{ role: "toolResult", content: [{ type: "text", text: "ok" }] },
		a([{ type: "thinking", thinking: "mid" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }]),
		{ role: "toolResult", content: [{ type: "text", text: "x" }] },
		a([{ type: "thinking", thinking: "new" }, { type: "toolCall", name: "state_note", arguments: { note: "n2" } }]),
	];
	const out = leanContext(msgs as any) as any[];
	assert.deepEqual(out[1].content.map((b: any) => b.type), ["toolCall"]);
	assert.match(out[1].content[0].arguments.note, /earlier state note/);
	assert.deepEqual(out[3].content.map((b: any) => b.type), ["toolCall"]);
	assert.equal(out[5], msgs[5]);
	assert.equal((msgs[1] as any).content.length, 2, "the input is not changed");
});

test("readsOutputs finds the calls that read simulator logs and tables", () => {
	const bash = (command: string) => ({ toolName: "bash", input: { command } }) as any;
	assert.equal(readsOutputs(bash("tail -50 simra/experiments/20261115-1/work/ngspice.log")), true);
	assert.equal(readsOutputs(bash("python3 -c 'print(1)' run.raw")), true);
	assert.equal(readsOutputs({ toolName: "read", input: { path: "simra/experiments/x/work/out.dat" } } as any), true);
	assert.equal(readsOutputs(bash("cat lna.spice")), false);
});

test("end guard: one re-entry with the missing items, recorded; none when the deliverables are complete", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "simra-guard-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), "{}");
	writeFileSync(join(root, "requirements.json"), JSON.stringify({ gates: { netlist: { file: "vco.spice" } } }));
	writeFileSync(join(root, "vco.spice"), ".subckt vco a b\n.ends\n");
	const deliverables = ["vco.spice", "answer.json"];
	assert.deepEqual(endGuardItems(root, deliverables), ["answer.json does not exist.", "No check_requirements run is recorded for requirements.json."]);

	// A last check with an aborted run, older than the design file.
	const check = join(root, "simra", "checks", "c1");
	mkdirSync(check, { recursive: true });
	const verdict = (at: number, status: string) => JSON.stringify({ id: "c1", created_at: new Date(at).toISOString(), experiments: [{ experiment: "osc_low", condition: "tt", status }] });
	writeFileSync(join(check, "verdict.json"), verdict(Date.now() - 60_000, "failed"));
	const items = endGuardItems(root, deliverables);
	assert.equal(items.length, 3);
	assert.match(items[1], /The last check \(c1\) has 1 run that did not complete: osc_low at tt \(failed\)/);
	assert.match(items[2], /vco\.spice changed after the last check \(c1\)/);
	assert.match(endGuardMessage(items, 53), /1\. answer\.json does not exist\.[\s\S]*Session time left: 53 min\.[\s\S]*comes once/);

	// A stub session: the handlers of the extension with SIMRA_DELIVERABLES set.
	const handlers = new Map<string, any[]>();
	const stub = { registerTool: () => {}, registerCommand: () => {}, on: (name: string, h: any) => handlers.set(name, [...(handlers.get(name) ?? []), h]) };
	process.env.SIMRA_DELIVERABLES = JSON.stringify(deliverables);
	t.after(() => delete process.env.SIMRA_DELIVERABLES);
	extension(stub as any);
	const [beforeSettle] = handlers.get("agent_before_settle") ?? [];
	const [settled] = handlers.get("agent_settled") ?? [];
	assert.ok(beforeSettle && settled, "the end guard handlers are registered");
	const ctx = { cwd: root };
	const first = await beforeSettle({ type: "agent_before_settle", entries: [], continue: false }, ctx);
	assert.equal(first.continue, true);
	assert.equal(first.entries.length, 1);
	assert.equal(first.entries[0].customType, END_GUARD_TYPE);
	assert.match(first.entries[0].content, /answer\.json does not exist/);
	// The agent writes the file and a complete check; a second end gets no re-entry (bounded), and the trace has both.
	writeFileSync(join(root, "answer.json"), "{}");
	writeFileSync(join(check, "verdict.json"), verdict(Date.now() + 60_000, "completed"));
	assert.equal(await beforeSettle({ type: "agent_before_settle", entries: [], continue: false }, ctx), undefined);
	await settled({ type: "agent_settled", aborted: false }, ctx);
	const trace = JSON.parse(readFileSync(join(root, "simra", "end_guard.json"), "utf8"));
	assert.equal(trace.reentry.items.length, 3);
	assert.deepEqual(trace.settled.items, []);
	assert.equal(trace.settled.reentries, 1);

	// Still incomplete at the second end: no second re-entry.
	rmSync(join(root, "answer.json"));
	assert.equal(await beforeSettle({ type: "agent_before_settle", entries: [], continue: false }, ctx), undefined);

	// Without SIMRA_DELIVERABLES the guard is off.
	delete process.env.SIMRA_DELIVERABLES;
	const off = new Map<string, any>();
	extension({ registerTool: () => {}, registerCommand: () => {}, on: (name: string, h: any) => off.set(name, h) } as any);
	assert.equal(off.has("agent_before_settle"), false);
});
