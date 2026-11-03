import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findPack, listPacks, loadExperiment, packCheck, packClashes, packInit } from "../src/index.ts";

// PDK onboarding with the fake adapter (operations pack_propose and pack_check): the CLI writes a pack only with
// --write, the pack lookup reports the directory of a pack, and two packs for one PDK are an error with both paths.

const fixtures = new URL("./fixtures", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

function design(t: { after: (fn: () => void) => void }, technologyDirs?: string[]): { root: string; parent: string } {
	const parent = mkdtempSync(join(tmpdir(), "simra-packs-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "design");
	mkdirSync(root);
	mkdirSync(join(parent, "kit"));
	const config: Record<string, unknown> = { adapter_dirs: [join(fixtures, "adapters")] };
	if (technologyDirs) {
		for (const d of technologyDirs) mkdirSync(join(parent, d), { recursive: true });
		config.technology_dirs = technologyDirs.map((d) => `../${d}`);
	}
	writeFileSync(join(root, "simra.config.json"), JSON.stringify(config));
	return { root, parent };
}

function simra(root: string, args: string[], env: Record<string, string> = {}) {
	return spawnSync(process.execPath, [cli, ...args, "--root", root], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
}

test("simra pack init proposes through the runner and writes the pack only with --write", (t) => {
	const { root, parent } = design(t, ["packs"]);
	const target = join(parent, "packs", "MYPDK", "technology.json");

	const dry = simra(root, ["pack", "init", "--pdk", "MYPDK", "--pdk-root", join(parent, "kit")]);
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /pack_propose completed/);
	assert.match(dry.stdout, /pack mypdk for PDK MYPDK from .*\/kit/);
	assert.match(dry.stdout, /answer these questions before you use the pack \(1\):\n {2}1\. Is the corner list right\?/);
	assert.match(dry.stdout, /not written\. To write it to .*\/packs\/MYPDK\/technology\.json, run the command again with --write/);
	assert.equal(existsSync(target), false);

	const wet = simra(root, ["pack", "init", "--pdk", "MYPDK", "--pdk-root", join(parent, "kit"), "--write", "--inputs", '{"corners":["tt","ff"]}']);
	assert.equal(wet.status, 0, wet.stderr);
	assert.match(wet.stdout, /wrote .*\/packs\/MYPDK\/technology\.json/);
	assert.doesNotMatch(wet.stdout, /add .* to technology_dirs/);
	const pack = JSON.parse(readFileSync(target, "utf8"));
	assert.deepEqual(pack.pdks, ["MYPDK"]);
	assert.deepEqual(pack.fake.MYPDK.corners, ["tt", "ff"]);

	// The run is a normal experiment record with the inputs of the request.
	const id = wet.stdout.match(/experiment (\S+): pack_propose/)?.[1] ?? "";
	const { experiment, result } = loadExperiment(root, id);
	assert.equal(experiment.operation, "pack_propose");
	assert.deepEqual(experiment.inputs, { corners: ["tt", "ff"], pdk: "MYPDK", pdk_root: join(parent, "kit") });
	assert.equal(result?.status, "completed");

	// A second write never overwrites the pack.
	const again = simra(root, ["pack", "init", "--pdk", "MYPDK", "--write"]);
	assert.equal(again.status, 1);
	assert.match(again.stderr, /the pack file exists: .*MYPDK\/technology\.json/);
});

test("simra pack check runs pack_check on the pack and prints pass, fail or not run per item", (t) => {
	const { root, parent } = design(t, ["packs"]);
	assert.equal(simra(root, ["pack", "init", "--pdk", "MYPDK", "--write"]).status, 0);
	const out = simra(root, ["pack", "check", "--pdk", "MYPDK"]);
	assert.equal(out.status, 0, out.stderr);
	assert.match(out.stdout, /pack_check completed\npack mypdk from .*\/packs\n {2}simulate tt: pass \(0\.4\)\n {2}simulate ss: pass \(0\.4\)\n {2}reference_build: not run: the fake pack has no facts for this step/);

	// A failed item gives the class and exit code 1.
	const path = join(parent, "packs", "MYPDK", "technology.json");
	const pack = JSON.parse(readFileSync(path, "utf8"));
	pack.fake.MYPDK.corners = ["tt", "bad"];
	writeFileSync(path, JSON.stringify(pack));
	const failed = simra(root, ["pack", "check", "--pdk", "MYPDK"]);
	assert.equal(failed.status, 1);
	assert.match(failed.stdout, / {2}simulate bad: fail \(simulator\): invented failure/);
});

test("without technology_dirs the pack goes to the data directory of the user, and the CLI says to add it", (t) => {
	const { root, parent } = design(t);
	const out = simra(root, ["pack", "init", "--pdk", "MYPDK", "--write"], { XDG_DATA_HOME: join(parent, "data") });
	assert.equal(out.status, 0, out.stderr);
	const dir = join(parent, "data", "simra", "technologies");
	assert.ok(existsSync(join(dir, "MYPDK", "technology.json")));
	assert.ok(out.stdout.includes(`add ${dir} to technology_dirs`), out.stdout);
});

test("a proposal without a pack writes nothing and exits with 1", (t) => {
	const { root, parent } = design(t, ["packs"]);
	const out = simra(root, ["pack", "init", "--pdk", "MYPDK", "--write", "--inputs", '{"mode":"nopack"}']);
	assert.equal(out.status, 1);
	assert.match(out.stdout, /pack_propose failed[\s\S]*error: no pack proposed: no kit[\s\S]*no pack proposed/);
	assert.equal(existsSync(join(parent, "packs", "MYPDK")), false);
});

test("the pack lookup names the directory of a pack; two packs for one PDK are an error with both paths", async (t) => {
	const { root, parent } = design(t, ["first", "second"]);
	cpSync(join(fixtures, "technologies", "test-pack"), join(parent, "second", "test-pack"), { recursive: true });
	const dirs = [join(parent, "first"), join(parent, "second")];
	const found = findPack(dirs, "test-pdk");
	assert.equal(found.dir, join(parent, "second"));
	assert.equal(found.name, "test-pack");
	assert.deepEqual(listPacks(dirs).map((p) => p.name), ["test-pack"]);
	assert.throws(() => findPack(dirs, "other"), /no technology pack for "other" in .*first, .*second; known: test-pack \(test-pdk\)/);

	// A pack with another name but the same PDK name in an earlier directory.
	mkdirSync(join(parent, "first", "copy"));
	writeFileSync(join(parent, "first", "copy", "technology.json"), JSON.stringify({ schema: "simra.technology/0", name: "copy", pdks: ["test-pdk"] }));
	assert.equal(packClashes(listPacks(dirs)).length, 1);
	const both = `${join(parent, "first", "copy", "technology.json")} and ${join(parent, "second", "test-pack", "technology.json")}`;
	assert.throws(() => findPack(dirs, "test-pdk"), (e: Error) => e.message.includes(`technology pack "test-pdk" is ambiguous: ${both}`));
	assert.throws(() => findPack(dirs, "test-pack"), /is ambiguous/);
	await assert.rejects(packCheck({ root, pdk: "test-pdk" }), /is ambiguous/);

	// pack init refuses to write a second pack for a PDK that has one.
	await assert.rejects(packInit({ root, pdk: "test-pdk", write: true }), /a pack for this PDK exists already: .*technology\.json/);
});

test("pack init and pack check need an adapter with the operation", (t) => {
	const { root } = design(t, ["packs"]);
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ technology_dirs: ["../packs"] }));
	const out = simra(root, ["pack", "init", "--pdk", "MYPDK"]);
	assert.equal(out.status, 1);
	assert.match(out.stderr, /no adapter of this design has the operation pack_propose; give --adapter/);
});
