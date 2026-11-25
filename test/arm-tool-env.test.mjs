// The variables of the task environment reach the eval sandbox: the klayout adapter in the sandbox finds KLayout
// through SIMRA_KLAYOUT of the task simra.config.json. Host only (no container).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeWorkspace, sandboxArgs, sandboxToolEnv } from "../evals/run-arm.mjs";

const evals = new URL("../evals/", import.meta.url).pathname;
const tasks = ["layout-drc-fix", "layout-clean", "layout-block-fix", "layout-false-pass"].flatMap((t) => ["sg13g2", "sky130"].map((p) => `${t}/${p}`));

test("eval sandboxes disable analytics even when caller environment tries to enable it", () => {
	const argv = sandboxArgs({ engine: "docker", imageId: "sha256:x", name: "n", ws: "/w", state: "/s", proxyDir: "/p",
		env: { SIMRA_NO_ANALYTICS: "0" }, command: ["true"] });
	assert.ok(argv.includes("SIMRA_NO_ANALYTICS=1"));
	assert.ok(!argv.includes("SIMRA_NO_ANALYTICS=0"));
});

test("the eval entry point disables host analytics before loading its scorer", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "simra-eval-analytics-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "task.json"), JSON.stringify({ score: "probe.mjs" }));
	writeFileSync(join(dir, "probe.mjs"), `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./policy.txt", import.meta.url), process.env.SIMRA_NO_ANALYTICS ?? "unset");
export const score = () => ({});
`);
	// Fail after the import, before any engine, model proxy, credentials or EDA tools are needed.
	const result = spawnSync(process.execPath, [join(evals, "run-arm.mjs"), dir, "simra", "--model", "invalid", "--runs", join(dir, "runs")], {
		env: { ...process.env, SIMRA_NO_ANALYTICS: "0" }, encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /unknown model "invalid"/);
	assert.equal(readFileSync(join(dir, "policy.txt"), "utf8"), "1");
});

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
