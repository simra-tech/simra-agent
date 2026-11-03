import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN_TECHNOLOGY_DIR, loadConfig, runExperiment, technologySearchPath } from "../src/index.ts";

// The packs of a configured technology directory reach the adapter through SIMRA_TECHNOLOGY_DIR, before the built-in
// packs. The adapter is the ngspice adapter, operation check_design: it reads the pack and runs no simulator.

const fixturePacks = new URL("./fixtures/technologies", import.meta.url).pathname;

function designRoot(t: { after: (fn: () => void) => void }): string {
	const parent = mkdtempSync(join(tmpdir(), "simra-technology-dirs-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "design");
	mkdirSync(root);
	// The extra directory is outside the design root, next to it, as a separate repository would be.
	cpSync(fixturePacks, join(parent, "packs"), { recursive: true });
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ technology_dirs: ["../packs"] }));
	writeFileSync(join(root, "amp.spice"), "* fixture design\n.subckt amp in out vss\nXn out in vss vss tn w=1 l=1\n.ends\n");
	return root;
}

const checkDesign = (root: string, technology: string, file = "amp.spice") =>
	runExperiment({
		root,
		adapter: "ngspice",
		operation: "check_design",
		inputs: { file, subckt: "amp", pins: ["in", "out", "vss"], technology },
		purpose: `technology ${technology}`,
	});

test("technology_dirs is resolved against the design root, and the built-in directory comes last", (t) => {
	const root = designRoot(t);
	const config = loadConfig(root);
	assert.deepEqual(config.technology_dirs, [join(root, "..", "packs")]);
	assert.deepEqual(technologySearchPath(config.technology_dirs ?? []), [join(root, "..", "packs"), BUILTIN_TECHNOLOGY_DIR]);
	assert.throws(() => technologySearchPath([join(root, "missing")]), /technology_dirs: directory not found/);
});

test("run_experiment finds a pack of a configured technology directory", async (t) => {
	const root = designRoot(t);
	const { result } = await checkDesign(root, "test-pack");
	assert.equal(result.status, "completed", JSON.stringify(result.diagnostics ?? result.errors));
	assert.equal(result.measurements.design_errors.value, 0);
	assert.equal(result.measurements.mos_count.value, 1);
	const pack = result.input_files.files.find((f: { role?: string }) => f.role === "technology");
	assert.equal(pack?.path, join(root, "..", "packs", "test-pack", "technology.json"));
	// The PDK name of the pack selects it too.
	assert.equal((await checkDesign(root, "test-pdk")).result.status, "completed");
});

test("the built-in packs are still found when a configured directory comes first", async (t) => {
	const root = designRoot(t);
	writeFileSync(
		join(root, "inv.spice"),
		"* fixture design\n.subckt amp in out vss\nXn out in vss vss sky130_fd_pr__nfet_01v8 w=1 l=1\n.ends\n",
	);
	const { result } = await checkDesign(root, "sky130", "inv.spice");
	assert.equal(result.status, "completed", JSON.stringify(result.diagnostics ?? result.errors));
	const pack = result.input_files.files.find((f: { role?: string }) => f.role === "technology");
	assert.equal(pack?.path, join(BUILTIN_TECHNOLOGY_DIR, "sky130", "technology.json"));
});

test("a configured directory that does not exist stops the run before an experiment is made", async (t) => {
	const root = designRoot(t);
	writeFileSync(join(root, "simra.local.json"), JSON.stringify({ technology_dirs: ["../nowhere"] }));
	await assert.rejects(checkDesign(root, "test-pack"), /technology_dirs: directory not found/);
});
