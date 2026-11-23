import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adapterSearchPath, BUILTIN_ADAPTER_DIR, runExperiment, technologySearchPath, userDir } from "../src/index.ts";

// Adapters and technology packs in the user's directory (<XDG_DATA_HOME>/simra/{adapters,technologies}) reach every
// design without a configuration, after the configured directories and before the built-in ones.

const fixtures = new URL("./fixtures", import.meta.url).pathname;

function setup(t: { after: (fn: () => void) => void }) {
	const parent = mkdtempSync(join(tmpdir(), "simra-user-dir-"));
	const saved = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = join(parent, "data");
	t.after(() => {
		if (saved === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = saved;
		rmSync(parent, { recursive: true, force: true });
	});
	const design = (name: string) => {
		const root = join(parent, name);
		mkdirSync(root);
		writeFileSync(join(root, "amp.spice"), "* fixture design\n.subckt amp in out vss\nXn out in vss vss tn w=1 l=1\n.ends\n");
		return root;
	};
	return { parent, design };
}

test("the user's directories come after the configured ones; a missing technology directory is left out", (t) => {
	const { parent } = setup(t);
	assert.deepEqual(adapterSearchPath(["/x"]), ["/x", userDir("adapters"), BUILTIN_ADAPTER_DIR]);
	assert.ok(!technologySearchPath([]).includes(userDir("technologies")));
	mkdirSync(userDir("technologies"), { recursive: true });
	assert.deepEqual(technologySearchPath([parent]).slice(0, 2), [parent, userDir("technologies")]);
});

test("two designs without a configuration run an adapter and find a pack of the user's directory", async (t) => {
	const { parent, design } = setup(t);
	cpSync(join(fixtures, "adapters", "fake"), join(parent, "data", "simra", "adapters", "fake"), { recursive: true });
	cpSync(join(fixtures, "technologies"), join(parent, "data", "simra", "technologies"), { recursive: true });
	for (const root of [design("a"), design("b")]) {
		const run = await runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" }, purpose: "user adapter" });
		assert.equal(run.result.status, "completed");
		const pack = await runExperiment({
			root,
			adapter: "ngspice",
			operation: "check_design",
			inputs: { file: "amp.spice", subckt: "amp", pins: ["in", "out", "vss"], technology: "test-pack" },
			purpose: "user pack",
		});
		assert.equal(pack.result.status, "completed", JSON.stringify(pack.result.diagnostics ?? pack.result.errors));
		const used = pack.result.input_files.files.find((f: { role?: string }) => f.role === "technology");
		assert.equal(used?.path, join(userDir("technologies"), "test-pack", "technology.json"));
	}
});

test("a configured adapter directory comes before the user's directory", async (t) => {
	const { parent, design } = setup(t);
	cpSync(join(fixtures, "adapters", "fake"), join(parent, "data", "simra", "adapters", "fake"), { recursive: true });
	cpSync(join(fixtures, "adapters", "fake"), join(parent, "own", "fake"), { recursive: true });
	const root = design("a");
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: ["../own"] }));
	const run = await runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" }, purpose: "precedence" });
	assert.equal(run.experiment.adapter.dir, join(parent, "own", "fake"));
});
