// The extension against a fake pi API: it registers run_experiment and check_requirements, and both tools run and record.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../index.ts";

const fakeAdapters = new URL("../../kernel/test/fixtures/adapters", import.meta.url).pathname;

test("run_experiment runs the adapter and names the records", async (t) => {
	const tools = new Map<string, any>();
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {} } as any);
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
	extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {} } as any);
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
