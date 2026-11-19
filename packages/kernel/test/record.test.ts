// The design record on fixture experiments: current, stale and missing files, the STALE line of the summary, the
// formatter, the CLI (simra record, simra show) and the design_record tool of the extension.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	designRecord,
	type ExperimentRecord,
	formatDesignRecord,
	formatOutcome,
	type ResultRecord,
	staleInputs,
} from "../src/index.ts";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function designRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "simra-record-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), "{}");
	return root;
}

let serial = 0;

/** Write the records of one finished experiment that read the given files (path, role, content at the time of the run). */
function record(
	root: string,
	o: { operation: string; files: { path: string; role: string; content: string }[]; measurements: Record<string, number | null>; rule_set?: string; status?: ResultRecord["status"] },
): { experiment: ExperimentRecord; result: ResultRecord } {
	const id = `20261103-1000${String(serial++).padStart(2, "0")}-aaaaaa`;
	const dir = join(root, "simra", "experiments", id);
	mkdirSync(dir, { recursive: true });
	const experiment = {
		schema: "simra.experiment/0",
		id,
		created_at: `2026-11-03T10:00:${String(serial).padStart(2, "0")}Z`,
		purpose: `${o.operation} test`,
		adapter: { name: "klayout", version: "0.2.0", dir: "/adapters/klayout", files: [] },
		operation: o.operation,
		inputs: o.rule_set ? { gds: "block.gds", rule_set: o.rule_set } : { gds: "block.gds" },
		environment: { name: "local" },
		design: { root, git_commit: null, git_dirty: null },
		simra: { kernel_version: "0" },
	} as ExperimentRecord;
	const measurements: ResultRecord["measurements"] = {};
	for (const [k, v] of Object.entries(o.measurements)) measurements[k] = v === null ? { value: null, unit: null, status: "failed" } : { value: v, unit: k === "runtime_s" ? "s" : null, status: "measured" };
	const result: ResultRecord = {
		schema: "simra.result/0",
		experiment: id,
		status: o.status ?? "completed",
		started_at: experiment.created_at,
		finished_at: experiment.created_at,
		duration_s: 1,
		exit_code: 0,
		signal: null,
		errors: [],
		tool: { name: "klayout", version: "0.30" },
		input_files: {
			complete: true,
			files: [
				...o.files.map((f) => ({ path: f.path, sha256: sha(f.content), bytes: f.content.length, role: f.role })),
				{ path: "/pdk/drc/deck.lydrc", sha256: "d".repeat(64), bytes: 1, role: "deck" },
				{ path: "technologies/ihp-sg13/pack.json", sha256: "e".repeat(64), bytes: 1, role: "technology" },
			],
		},
		outputs: [],
		measurements,
		diagnostics: [],
		logs: { adapter_stdout: "adapter.stdout.log", adapter_stderr: "adapter.stderr.log" },
	};
	writeFileSync(join(dir, "experiment.json"), JSON.stringify(experiment));
	writeFileSync(join(dir, "result.json"), JSON.stringify(result));
	return { experiment, result };
}

const git = (root: string, ...args: string[]) =>
	execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

/** A design with a v1 layout (2 runs), then a commit of v2 (1 DRC run on v2), and a netlist that did not change. */
function fixture(root: string) {
	writeFileSync(join(root, "block.gds"), "v1");
	writeFileSync(join(root, "block.spice"), "netlist");
	git(root, "init", "-q");
	git(root, "add", "block.gds", "block.spice");
	git(root, "commit", "-q", "-m", "block: first version");
	const drc1 = record(root, { operation: "drc", rule_set: "full", files: [{ path: "block.gds", role: "layout", content: "v1" }], measurements: { markers: 38, rules_violated: 11, runtime_s: 12 } });
	const lvs1 = record(root, {
		operation: "lvs",
		files: [{ path: "block.gds", role: "layout", content: "v1" }, { path: "block.spice", role: "netlist", content: "netlist" }],
		measurements: { match: 1, unmatched_devices: 0, unmatched_nets: 0, unmatched_pins: null, runtime_s: 20 },
	});
	writeFileSync(join(root, "block.gds"), "v2");
	git(root, "commit", "-q", "-am", "block: widen the vdd bus");
	const drc2 = record(root, { operation: "drc", rule_set: "full", files: [{ path: "block.gds", role: "layout", content: "v2" }], measurements: { markers: 5, rules_violated: 1, runtime_s: 12 } });
	return { drc1, lvs1, drc2 };
}

test("the design record gives each file of record with its current and stale experiments", (t) => {
	const root = designRoot(t);
	const { drc1, lvs1, drc2 } = fixture(root);
	const record = designRecord(root);
	// The deck (absolute path) and the technology pack are not files of record.
	assert.deepEqual(record.files.map((f) => f.path), ["block.gds", "block.spice"]);
	const [gds, spice] = record.files;
	assert.equal(gds.sha256, sha("v2"));
	assert.equal(gds.role, "layout");
	assert.equal(gds.git?.subject, "block: widen the vdd bus");
	assert.equal(gds.git?.dirty, false);
	// Current first, then stale; the most recent first in each group.
	assert.deepEqual(gds.experiments.map((e) => [e.id, e.current]), [[drc2.experiment.id, true], [lvs1.experiment.id, false], [drc1.experiment.id, false]]);
	assert.deepEqual(gds.experiments[0].measurements, { markers: 5, rules_violated: 1 });
	assert.equal(gds.experiments[0].rule_set, "full");
	assert.deepEqual(gds.experiments[1].measurements, { match: 1, unmatched_devices: 0, unmatched_nets: 0 });
	assert.equal(gds.experiments[2].sha256, sha("v1"));
	// The netlist did not change: its LVS run is current for it.
	assert.equal(spice.sha256, sha("netlist"));
	assert.deepEqual(spice.experiments.map((e) => [e.id, e.current]), [[lvs1.experiment.id, true]]);
	assert.equal(spice.git?.subject, "block: first version");
});

test("staleInputs and the summary give a STALE line for a changed file, and none for a current one", (t) => {
	const root = designRoot(t);
	const { lvs1, drc2 } = fixture(root);
	assert.deepEqual(staleInputs(root, drc2.experiment, drc2.result), []);
	assert.doesNotMatch(formatOutcome(root, drc2.experiment, drc2.result), /STALE/);
	const stale = staleInputs(root, lvs1.experiment, lvs1.result);
	assert.deepEqual(stale.map((s) => [s.path, s.role, s.recorded, s.current]), [["block.gds", "layout", sha("v1"), sha("v2")]]);
	const lines = formatOutcome(root, lvs1.experiment, lvs1.result).split("\n");
	const at = lines.indexOf(`STALE: layout block.gds changed after this run (now sha256:${sha("v2").slice(0, 12)})`);
	// After the input files, before the measurements.
	assert.ok(at > lines.findIndex((l) => l.startsWith("  netlist block.spice")), lines.join("\n"));
	assert.ok(at < lines.indexOf("measurements:"), lines.join("\n"));
	assert.equal(lines.filter((l) => l.startsWith("STALE")).length, 1);
});

test("a missing file of record is stale, and has no check on the current file", (t) => {
	const root = designRoot(t);
	const { drc1 } = fixture(root);
	unlinkSync(join(root, "block.gds"));
	assert.match(formatOutcome(root, drc1.experiment, drc1.result), /^STALE: layout block\.gds changed after this run \(now missing\)$/m);
	const gds = designRecord(root).files[0];
	assert.equal(gds.sha256, "missing");
	assert.ok(gds.experiments.every((e) => !e.current));
	const text = formatDesignRecord(designRecord(root, ["block.gds"]));
	assert.match(text, /^layout block\.gds missing\n/);
	assert.match(text, /\n {2}git \S+ block: widen the vdd bus \(the file has changes after this commit\)\n {2}no check on the current file\n/);
});

test("the formatter gives one block per file, the stale note, and stays short for 10 experiments", (t) => {
	const root = designRoot(t);
	const { drc1, lvs1, drc2 } = fixture(root);
	const text = formatDesignRecord(designRecord(root));
	const id = (e: { experiment: ExperimentRecord }) => e.experiment.id;
	assert.equal(
		text,
		[
			`layout block.gds sha256:${sha("v2").slice(0, 12)}`,
			`  git ${git(root, "rev-parse", "HEAD").slice(0, 12)} block: widen the vdd bus`,
			`  ${id(drc2)} klayout drc [full] completed markers=5 rules_violated=1`,
			`  ${id(lvs1)} klayout lvs completed match=1 unmatched_devices=0 unmatched_nets=0 (stale: ran on sha256:${sha("v1").slice(0, 12)})`,
			`  ${id(drc1)} klayout drc [full] completed markers=38 rules_violated=11 (stale: ran on sha256:${sha("v1").slice(0, 12)})`,
			`netlist block.spice sha256:${sha("netlist").slice(0, 12)}`,
			`  git ${git(root, "rev-parse", "HEAD~1").slice(0, 12)} block: first version`,
			`  ${id(lvs1)} klayout lvs completed match=1 unmatched_devices=0 unmatched_nets=0`,
		].join("\n"),
	);
	// 7 more runs on v2 (10 experiments in total): at most 6 lines per file, and one line for the rest.
	for (let i = 0; i < 7; i++) record(root, { operation: "drc", rule_set: "full", files: [{ path: "block.gds", role: "layout", content: "v2" }], measurements: { markers: 0, rules_violated: 0 } });
	const long = formatDesignRecord(designRecord(root)).split("\n");
	assert.ok(long.length <= 20, long.join("\n"));
	assert.ok(long.includes("  ... 4 more runs (2 current, 2 stale)"), long.join("\n"));
});

test("simra record prints the design record, and simra show prints the summary with the STALE line", (t) => {
	const root = designRoot(t);
	const { lvs1 } = fixture(root);
	const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
	const all = run("record");
	assert.equal(all.status, 0, all.stderr);
	assert.match(all.stdout, /^layout block\.gds sha256:/m);
	assert.match(all.stdout, /^netlist block\.spice sha256:/m);
	const one = run("record", "block.spice");
	assert.doesNotMatch(one.stdout, /block\.gds/);
	assert.match(one.stdout, /^netlist block\.spice/);
	const show = run("show", lvs1.experiment.id);
	assert.equal(show.status, 0, show.stderr);
	assert.match(show.stdout, new RegExp(`^experiment ${lvs1.experiment.id}: completed`));
	assert.match(show.stdout, /^STALE: layout block\.gds changed after this run/m);
	const json = run("show", "--json", lvs1.experiment.id);
	assert.equal(JSON.parse(json.stdout).result.experiment, lvs1.experiment.id);
});

test("a design without experiments gives a one-line record", (t) => {
	const root = designRoot(t);
	assert.equal(formatDesignRecord(designRecord(root)), "design record: no experiment with input files in simra/experiments");
});
