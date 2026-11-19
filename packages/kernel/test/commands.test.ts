// KERNEL_COMMANDS (the routing list of the simra binary) is the set of command branches of the kernel command line.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { KERNEL_COMMANDS } from "../src/index.ts";

test("KERNEL_COMMANDS is the set of commands of cli.ts", () => {
	const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
	const branches = [...source.matchAll(/^\tif \(command === "([a-z-]+)"/gm)].map((m) => m[1]);
	assert.ok(branches.length >= 16, `only ${branches.length} command branches found in cli.ts`);
	assert.deepEqual([...KERNEL_COMMANDS].sort(), [...new Set(branches)].sort());
	// Each command has a line in the usage text.
	const usage = source.match(/"usage: [^\n]*/)?.[0] ?? "";
	for (const c of KERNEL_COMMANDS) assert.match(usage, new RegExp(`simra ${c}\\b`), `no usage text for ${c}`);
});
