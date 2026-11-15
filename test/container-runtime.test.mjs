// The environment image holds only the runtime list of container/build.sh. Each built-in directory that the kernel
// reads at run time must be in that list, or the tool that reads it is empty in the container (the det-cell pilot
// found the workaround registry empty for this reason).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { test } from "node:test";
import { BUILTIN_ADAPTER_DIR, BUILTIN_TECHNOLOGY_DIR, BUILTIN_WORKAROUND_DIR } from "@simra-tech/kernel";

test("image runtime list: each built-in directory of the kernel is in the image", () => {
	const script = readFileSync(new URL("../container/build.sh", import.meta.url), "utf8");
	const m = /^runtime="([^"]*)"/m.exec(script);
	assert.ok(m, "container/build.sh has no runtime list");
	const runtime = m[1].split(/\s+/);
	for (const dir of [BUILTIN_ADAPTER_DIR, BUILTIN_TECHNOLOGY_DIR, BUILTIN_WORKAROUND_DIR]) {
		assert.ok(runtime.includes(basename(dir)), `${basename(dir)} is not in the runtime list of container/build.sh`);
	}
	assert.ok(!runtime.includes("evals"), "evals/ holds the answers and must not be in the image");
});
