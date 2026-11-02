// The klayout adapter in the container, on the hierarchical block of layout-block-fix (both PDKs):
// 1. drc: the marker count and the count of each rule on the clean and the seeded block are the ones of
//    expected.json (the default rule set of the technology pack).
// 2. lvs: the clean block matches, with the pins of spec.md in order; the cheat block does not match.
// 3. the files that the broken lvs.sh of layout-false-pass leaves (a printed match, a truncated LVS database,
//    exit code 139) give "not run".
// 4. `simra run` (the CLI) runs the adapter with the eda environment of a design (examples/ota-sg13g2 for IHP, the
//    task configuration for SKY130). The request names the technology by its PDK name. The summary of a DRC of the
//    seeded block gives the deck command after the tool line, lists the outputs, gives every marker box and the
//    paths of the full table, and is under 6 kB for IHP. The test prints its size, its command line, and the size of
//    the output of drc.sh on the same block.
// It runs only with SIMRA_TEST_IMAGE, an image with KLayout and both PDKs (optional: SIMRA_TEST_ENGINE podman or
// docker, default podman). A skipped case is reported by the test runner as skipped: that check did not run.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runExperiment } from "@simra-tech/kernel";
import { loadTask, runContainer, taskEnvironment } from "../evals/layout-drc-fix/layout.mjs";
import { brokenLvs, PDKS } from "../evals/layout-block-fix/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
const engine = process.env.SIMRA_TEST_ENGINE ?? "podman";
// The test image replaces the image of the configuration; the environment variables of the configuration stay.
const local = { environments: { eda: { engine, image: process.env.SIMRA_TEST_IMAGE } } };
const CONFIG = { sg13g2: "examples/ota-sg13g2/simra.config.json", sky130: "evals/layout-block-fix/sky130/simra.config.json" };

/** A design root with the block files of layout-block-fix/<pdk>, the cheat block and the configuration. */
async function designRoot(t, pdk) {
	// The real path: on macOS, tmpdir() is under the /var link, which a container engine VM may not have.
	const root = mkdtempSync(join(realpathSync(tmpdir()), `simra-klayout-${pdk}-`));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const taskDir = join(repo, "evals/layout-block-fix", pdk);
	for (const f of ["block-clean.gds", "block-seeded.gds", "block.spice", "drc.sh"]) copyFileSync(join(taskDir, f), join(root, f));
	copyFileSync(join(repo, CONFIG[pdk]), join(root, "simra.config.json"));
	writeFileSync(join(root, "simra.local.json"), JSON.stringify(local));
	// The cheat block is not committed: the generator makes it.
	const env = taskEnvironment(root, { environment: "eda" });
	const gen = `python3 ${join(taskDir, "generate.py")} --variant cheat --out ${join(root, "block-cheat.gds")}`;
	const r = await runContainer({ ...env, env: { ...env.env, PYTHONDONTWRITEBYTECODE: "1" } }, root, gen, { [join(repo, "evals")]: join(repo, "evals") });
	assert.equal(r.code, 0, `the generator failed: ${r.stderr}`);
	return root;
}

const run = (root, operation, inputs) => runExperiment({ root, adapter: "klayout", operation, environment: "eda", inputs, purpose: "container test" });
const values = (result) => Object.fromEntries(Object.entries(result.measurements).map(([k, m]) => [k, m.value]));
const why = (result) => JSON.stringify([...result.errors, ...result.diagnostics.filter((d) => d.severity !== "info").map((d) => d.message)]).slice(0, 2000);

for (const pdk of PDKS) {
	test(`klayout ${pdk}: drc and lvs on the block give the recorded results (container)`, { skip, timeout: 900_000 }, async (t) => {
		const { spec, expected } = loadTask(join(repo, "evals/layout-block-fix", pdk));
		const root = await designRoot(t, pdk);
		for (const variant of ["clean", "seeded"]) {
			const e = expected.variants[variant].drc;
			const { id, result } = await run(root, "drc", { gds: `block-${variant}.gds`, cell: spec.cell });
			assert.equal(result.status, "completed", why(result));
			const m = values(result);
			assert.deepEqual([m.markers, m.rules_violated], [e.markers, Object.keys(e.rules).length], `${pdk} ${variant}`);
			const table = JSON.parse(readFileSync(join(root, "simra/experiments", id, "work/drc.json"), "utf8"));
			assert.deepEqual(Object.fromEntries(table.rules.map((r) => [r.rule, r.count])), e.rules, `${pdk} ${variant}: the count of each rule`);
			t.diagnostic(`${pdk} drc ${variant}: ${m.markers} markers, ${m.rules_violated} rules, ${m.runtime_s} s`);
		}
		const clean = (await run(root, "lvs", { gds: "block-clean.gds", cell: spec.cell, netlist: "block.spice", pins: spec.pins })).result;
		assert.equal(clean.status, "completed", why(clean));
		assert.deepEqual([values(clean).match, values(clean).unmatched_devices, values(clean).unmatched_nets, values(clean).unmatched_pins], [1, 0, 0, 0], why(clean));
		const cheat = (await run(root, "lvs", { gds: "block-cheat.gds", cell: spec.cell, netlist: "block.spice", pins: spec.pins })).result;
		assert.equal(cheat.status, "completed", why(cheat));
		assert.equal(values(cheat).match, 0);
		assert.ok(cheat.diagnostics.some((d) => d.severity === "error" && /^the netlists do not match/.test(d.message)));
		t.diagnostic(`${pdk} lvs: clean match ${values(clean).match} (${values(clean).runtime_s} s); cheat match ${values(cheat).match}, devices ${values(cheat).unmatched_devices}, nets ${values(cheat).unmatched_nets}, pins ${values(cheat).unmatched_pins}`);
	});

	test(`klayout ${pdk}: the files of the broken lvs.sh give not run (container)`, { skip, timeout: 600_000 }, async (t) => {
		const fpDir = join(repo, "evals/layout-false-pass", pdk);
		const { task, spec } = loadTask(fpDir);
		const work = mkdtempSync(join(realpathSync(tmpdir()), `simra-klayout-broken-${pdk}-`));
		t.after(() => rmSync(work, { recursive: true, force: true }));
		const blockDir = join(repo, "evals/layout-block-fix", pdk);
		const broken = await brokenLvs(pdk, resolve(fpDir, task.files["block.gds"]), join(work, "broken"), local, join(blockDir, "block.spice"));
		assert.notEqual(broken.exit, 0);
		assert.match(broken.printed, /^LVS status: MATCH$/m);
		// The database and the log that lvs.sh leaves, read as the adapter reads them.
		const db = join(work, "broken", `lvs/${pdk === "sg13g2" ? "block" : spec.cell}.lvsdb`);
		const log = join(work, "broken", "lvs/lvs.log");
		const env = taskEnvironment(join(work, "broken"), task);
		const probe = `"$SIMRA_KLAYOUT" -b -r ${join(repo, "adapters/klayout/lvsdb_probe.py")} -rd lvsdb=${db} -rd result=${join(work, "probe.json")} -rd top_cell=${spec.cell}`;
		const r = await runContainer(env, work, probe, { [join(repo, "adapters/klayout")]: join(repo, "adapters/klayout") });
		assert.equal(r.code, 0, r.stderr);
		const p = JSON.parse(readFileSync(join(work, "probe.json"), "utf8"));
		assert.equal(p.loaded, false);
		const pack = { sg13g2: ["ihp-sg13", "ihp-sg13g2"], sky130: ["sky130", "sky130A"] }[pdk];
		const py = [
			"import json, sys",
			`sys.path.insert(0, ${JSON.stringify(join(repo, "adapters/klayout"))})`,
			"import klayout_adapter as ka",
			`facts = json.load(open(${JSON.stringify(join(repo, "technologies", pack[0], "technology.json"))}))["klayout"][${JSON.stringify(pack[1])}]["lvs"]`,
			`text = open(${JSON.stringify(log)}).read() + open(${JSON.stringify(join(work, "broken/broken.out"))}).read()`,
			`print(json.dumps(ka.lvs_verdict(${broken.exit}, text, True, json.load(open(${JSON.stringify(join(work, "probe.json"))})), facts)))`,
		].join("\n");
		const v = spawnSync("python3", ["-c", py], { encoding: "utf8" });
		assert.equal(v.status, 0, v.stderr);
		const [verdict, reason] = JSON.parse(v.stdout);
		assert.equal(verdict, "not run");
		assert.match(reason, /does not load/);
		t.diagnostic(`${pdk}: broken lvs.sh exit ${broken.exit}; verdict ${verdict}: ${reason.slice(0, 200)}`);
	});

	test(`klayout ${pdk}: simra run (CLI) runs the adapter in the eda environment (container)`, { skip, timeout: 600_000 }, async (t) => {
		const { spec } = loadTask(join(repo, "evals/layout-block-fix", pdk));
		const root = await designRoot(t, pdk);
		const technology = { sg13g2: "ihp-sg13g2", sky130: "sky130A" }[pdk];
		writeFileSync(join(root, "drc.json"), JSON.stringify({ adapter: "klayout", operation: "drc", environment: "eda", purpose: "DRC of the seeded block", inputs: { gds: "block-seeded.gds", cell: spec.cell, technology } }));
		const cli = spawnSync(process.execPath, [join(repo, "packages/kernel/src/cli.ts"), "run", "drc.json", "--root", root], { cwd: root, encoding: "utf8" });
		assert.equal(cli.status, 0, cli.stderr);
		assert.match(cli.stdout, /^\s+markers = \d+$/m);
		assert.match(cli.stdout, /^tool: klayout /m);
		// The line after the tool line is the deck command, with its exit code and runtime.
		const lines = cli.stdout.split("\n");
		const command = lines[lines.findIndex((l) => l.startsWith("tool: klayout ")) + 1];
		assert.match(command, /^command: \S+ .*block-seeded\.gds.* \(exit \d+, [\d.]+ s\)$/);
		t.diagnostic(`${pdk}: ${command}`);
		// The summary lists the outputs, gives every box of each rule (at most 8 markers per rule on this block) and
		// ends the DRC diagnostics with the paths of the full table and the marker database.
		assert.match(cli.stdout, /^outputs:\n(  simra\/experiments\/\S+ \(\d+ bytes\)\n)+/m);
		assert.match(cli.stdout, /^  simra\/experiments\/\S+\/work\/drc\.json \(\d+ bytes\)$/m);
		assert.doesNotMatch(cli.stdout, /more in work\/drc\.json/);
		assert.match(cli.stdout, /^warning: Full table: simra\/experiments\/\S+\/work\/drc\.json \(all markers of each rule, by cell\)\. Marker database: simra\/experiments\/\S+\.lyrdb$/m);
		if (pdk === "sg13g2") assert.ok(Buffer.byteLength(cli.stdout) < 6000, `the IHP summary has ${Buffer.byteLength(cli.stdout)} bytes`);
		// The output of drc.sh on the same block, for the comparison of the sizes.
		mkdirSync(join(root, "sh"));
		copyFileSync(join(root, "block-seeded.gds"), join(root, "sh/block.gds"));
		copyFileSync(join(root, "drc.sh"), join(root, "sh/drc.sh"));
		const env = taskEnvironment(root, { environment: "eda" });
		const sh = await runContainer(env, join(root, "sh"), `sh ./drc.sh block.gds ${spec.cell} > drc.out 2>&1`);
		assert.ok([0, 1].includes(sh.code), sh.stderr);
		const shBytes = Buffer.byteLength(readFileSync(join(root, "sh/drc.out"), "utf8"));
		t.diagnostic(`${pdk}: summary of simra run (klayout drc, seeded block) ${Buffer.byteLength(cli.stdout)} bytes; drc.sh output ${shBytes} bytes`);
	});
}
