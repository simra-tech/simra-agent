// The variables of the task environment reach the eval sandbox: the klayout adapter in the sandbox finds KLayout
// through SIMRA_KLAYOUT of the task simra.config.json. Host only (no container).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeWorkspace, sandboxArgs, sandboxToolEnv } from "../evals/run-arm.mjs";

const evals = new URL("../evals/", import.meta.url).pathname;
const tasks = ["layout-drc-fix", "layout-clean", "layout-block-fix", "layout-false-pass"].flatMap((t) => ["sg13g2", "sky130"].map((p) => `${t}/${p}`));

for (const name of tasks) {
	test(`${name}: SIMRA_KLAYOUT reaches the sandbox`, () => {
		const taskDir = join(evals, name);
		const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
		const ws = mkdtempSync(join(tmpdir(), "simra-toolenv-"));
		try {
			const env = makeWorkspace(taskDir, task, ws);
			const toolEnv = sandboxToolEnv(env);
			assert.equal(toolEnv.SIMRA_KLAYOUT, "/foss/tools/klayout/klayout");
			assert.equal(toolEnv.PDK_ROOT, "/foss/pdks");
			assert.equal(toolEnv.HOME, undefined);
			const argv = sandboxArgs({ engine: "docker", imageId: "sha256:x", name: "n", ws, state: "/s", proxyDir: "/p", env: toolEnv, command: ["true"] });
			assert.ok(argv.includes("SIMRA_KLAYOUT=/foss/tools/klayout/klayout"));
			// In the sandbox, the environment is the container itself; its variables come from the sandbox.
			const local = JSON.parse(readFileSync(join(ws, "simra.local.json"), "utf8"));
			assert.equal(local.environments[task.environment].kind, "local");
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});
}
