// Host tests of the layout-long-job task (the flat block), with no container:
// 1. the scorer (mode block-fix) with fake verifier results (the recorded results of expected.json) for each role:
//    the seeded block not fixed, the cheat and a fix;
// 2. the job diagnostics of the score report (background_runs, log_reads, deck_wall_s) on fixture transcripts of pi
//    and Codex CLI, and "not run" with no transcript;
// 3. the consistency of spec.md, the netlist, task.json, expected.json and the prompt;
// 4. the hash of the generated GDS. The generated GDS is not committed: without it, that check is skipped (not run).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { deviceCount, PDKS, SEED_LIMITS, SEED_RULES } from "../evals/layout-block-fix/reference.mjs";
import { FIXED_SHARE, loadTask, MAX, scoreLayout, sha256, subcktPins } from "../evals/layout-drc-fix/layout.mjs";
import { deckCommand } from "../evals/layout-drc-fix/reference.mjs";
import { GENERATED, RUNTIME_TARGET_S, runtimeRecord } from "../evals/layout-long-job/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const taskDir = (pdk) => join(repo, "evals/layout-long-job", pdk);
const REPORTS = { sg13g2: { drc: "drc/block_idac_full.lyrdb", lvs: "lvs/block.lvsdb" }, sky130: { drc: "drc/idac.lyrdb", lvs: "lvs/idac.lvsdb" } };
const lines = (events) => events.map((e) => JSON.stringify(e)).join("\n");

/** A fake verifier: the recorded result of a variant (expected.json), with the recorded hash of that variant. */
function fakeVerifier(expected, variant) {
	return async () => {
		const v = expected.variants[variant];
		return { gds_sha256: v.sha256, image_id: expected.provenance.image_id, drc: { ...v.drc, reason: null, report: "drc/x.lyrdb" }, lvs: { ...v.lvs, reason: null, report: "lvs/x.lvsdb" }, errors: [] };
	};
}

/** A workspace in a temporary run directory: run/ws with a stand-in block.gds, report files and answer.json. */
function workspace(t, pdk, { answer, transcript } = {}) {
	const run = mkdtempSync(join(tmpdir(), "simra-layout-long-job-score-"));
	t.after(() => rmSync(run, { recursive: true, force: true }));
	const ws = join(run, "ws");
	mkdirSync(ws);
	// The fake verifier gives the hash; the scorer needs only a file.
	writeFileSync(join(ws, "block.gds"), "stand-in\n");
	for (const r of Object.values(REPORTS[pdk])) {
		mkdirSync(join(ws, r, ".."), { recursive: true });
		writeFileSync(join(ws, r), "report\n");
	}
	if (answer) writeFileSync(join(ws, "answer.json"), JSON.stringify(answer));
	if (transcript) writeFileSync(join(run, "transcript.jsonl"), transcript);
	return ws;
}

for (const pdk of PDKS) {
	const { expected } = loadTask(taskDir(pdk));
	const rep = REPORTS[pdk];
	const drcRow = (markers = 0) => ({ check: "drc", ran: true, command: "./drc.sh block.gds idac", report: rep.drc, markers });
	const lvsRow = (status = "MATCH") => ({ check: "lvs", ran: true, command: "./lvs.sh block.gds idac", report: rep.lvs, status });
	const seeded = Object.entries(expected.variants.seeded.drc.rules).map(([rule, n]) => ({ rule, markers_before: n }));
	const score = (ws, variant) => scoreLayout(ws, taskDir(pdk), { mode: "block-fix", verifier: fakeVerifier(expected, variant), verifyRoot: join(ws, "../verify") });

	test(`layout-long-job ${pdk}: the scorer of block-fix gives the points of each role`, async (t) => {
		// The seeded block, not fixed: 0 DRC points and 0 fixed points.
		const s = await score(workspace(t, pdk, { answer: { drc_clean: false, lvs_match: true, checks: [drcRow(expected.variants.seeded.drc.markers), lvsRow()], fixed: [] } }), "seeded");
		assert.deepEqual([s.drc, s.lvs, s.claim, s.fixed], [0, MAX.lvs, MAX.claim, 0], JSON.stringify(s.errors));
		assert.equal(s.hash_unchanged, true);
		assert.deepEqual(s.max, MAX);
		// The cheat (the seeded shapes removed): 0 LVS points and 0 claim points.
		const c = await score(workspace(t, pdk, { answer: { drc_clean: true, lvs_match: true, checks: [drcRow(), lvsRow()], fixed: seeded } }), "cheat");
		assert.deepEqual([c.drc, c.lvs, c.claim, c.fixed], [MAX.drc, 0, 0, MAX.fixed]);
		assert.equal(c.lvs_status, "mismatch");
		// A fix: all points; fixed needs the share of the seeded rules.
		const f = await score(workspace(t, pdk, { answer: { drc_clean: true, lvs_match: true, checks: [drcRow(), lvsRow()], fixed: seeded } }), "clean");
		assert.deepEqual([f.drc, f.lvs, f.claim, f.fixed], [MAX.drc, MAX.lvs, MAX.claim, MAX.fixed], JSON.stringify(f.errors));
		assert.equal(f.hash_unchanged, false);
		const few = seeded.slice(0, Math.ceil(FIXED_SHARE * seeded.length) - 1);
		const g = await score(workspace(t, pdk, { answer: { drc_clean: true, lvs_match: true, checks: [drcRow(), lvsRow()], fixed: few } }), "clean");
		assert.equal(g.fixed, 0);
		// No transcript: the job diagnostics are not run.
		for (const k of ["deck_runs", "wait_calls", "background_runs", "log_reads", "deck_wall_s"]) assert.match(String(f[k]), /^not_run/, k);
	});

	test(`layout-long-job ${pdk}: the score report gives the job diagnostics of the transcript`, async (t) => {
		const answer = { drc_clean: true, lvs_match: true, checks: [drcRow(), lvsRow()], fixed: seeded };
		// pi: the DRC in the background, two log reads, then the LVS in the foreground (with run times).
		const pi = lines([
			{ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: { command: "nohup ./drc.sh block.gds idac > drc.out 2>&1 &" } },
			{ type: "tool_execution_end", toolCallId: "1", result: { content: [] }, durationMs: 30 },
			{ type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: { command: "sleep 120; tail -5 drc/drc.log" } },
			{ type: "tool_execution_end", toolCallId: "2", result: { content: [] }, durationMs: 120_040 },
			{ type: "tool_execution_start", toolCallId: "3", toolName: "bash", args: { command: `grep -c '<item>' ${rep.drc}` } },
			{ type: "tool_execution_end", toolCallId: "3", result: { content: [] }, durationMs: 20 },
			{ type: "tool_execution_start", toolCallId: "4", toolName: "bash", args: { command: "./lvs.sh block.gds idac", timeout: 900 } },
			{ type: "tool_execution_end", toolCallId: "4", result: { content: [] }, durationMs: 75_000 },
		]);
		const p = await score(workspace(t, pdk, { answer, transcript: pi }), "clean");
		assert.deepEqual([p.deck_runs, p.wait_calls, p.background_runs, p.log_reads, p.deck_wall_s], [{ drc: 1, lvs: 1, run_experiment: { drc: 0, lvs: 0, query: 0, diff: 0 } }, 1, 1, 2, 75]);
		// Codex CLI: no run times in the event stream, so deck_wall_s is null.
		const codex = lines([
			{ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "/usr/bin/bash -lc './drc.sh block.gds idac'", aggregated_output: "" } },
			{ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/usr/bin/bash -lc './lvs.sh block.gds idac'", aggregated_output: "" } },
		]);
		const x = await score(workspace(t, pdk, { answer, transcript: codex }), "clean");
		assert.deepEqual([x.deck_runs, x.background_runs, x.log_reads, x.deck_wall_s], [{ drc: 1, lvs: 1, run_experiment: { drc: 0, lvs: 0, query: 0, diff: 0 } }, 0, 0, null]);
	});

	test(`layout-long-job ${pdk}: spec.md, the netlist, task.json, expected.json and the prompt agree`, () => {
		const dir = taskDir(pdk);
		const { task: tj, spec } = loadTask(dir);
		const fixDir = join(repo, "evals/layout-block-fix", pdk);
		const fix = loadTask(fixDir);
		assert.equal(tj.name, `layout-long-job-${pdk}`);
		for (const [name, from] of Object.entries(tj.files)) {
			if (name === "simra.local.json" || from === GENERATED) continue;
			assert.ok(existsSync(resolve(dir, from)), `${pdk}: ${from}`);
			assert.doesNotMatch(`${name} ${from}`, /generate\.py|block\.py|expected\.json|reference\.mjs|layout\.mjs|cheat/, `${pdk}: ${name} must not be in the workspace`);
		}
		// The wrappers and the configuration are the ones of layout-block-fix.
		for (const f of ["drc.sh", "lvs.sh", "simra.config.json"]) assert.equal(resolve(dir, tj.files[f]), join(fixDir, f), f);
		for (const f of ["drc.sh", "lvs.sh"]) assert.ok(statSync(resolve(dir, tj.files[f])).mode & 0o111, `${f} is executable`);
		// The GDS is generated: task.json gives its hash (the seeded variant) and the command that makes it.
		assert.equal(tj.files[spec.gds], GENERATED);
		assert.equal(tj.generated[GENERATED].sha256, expected.variants.seeded.sha256);
		assert.equal(tj.generated[GENERATED].command, `node evals/layout-long-job/reference.mjs ${pdk} --gds`);
		// The same cell, pins and netlist name as layout-block-fix; a flat netlist with the recorded device count.
		assert.deepEqual([spec.cell, spec.pins, spec.subckt, spec.netlist], [fix.spec.cell, fix.spec.pins, fix.spec.subckt, fix.spec.netlist]);
		const netlist = readFileSync(resolve(dir, tj.files[spec.netlist]), "utf8");
		assert.deepEqual(subcktPins(netlist, spec.subckt), spec.pins);
		assert.equal((netlist.match(/^\.subckt /gim) ?? []).length, 1, "a flat netlist: one subcircuit");
		assert.equal(deviceCount(netlist, spec.subckt), expected.block.devices);
		assert.ok(expected.block.devices >= 10_000 && expected.block.devices <= 40_000, `${expected.block.devices} devices`);
		const [a, b] = expected.block.scale;
		assert.equal(expected.block.devices, 255 * a * b + 832);
		const specText = readFileSync(resolve(dir, tj.files["spec.md"]), "utf8");
		assert.ok(specText.includes(`finger: ${expected.block.devices} devices.`), "the device count in spec.md");
		assert.ok(specText.includes(`| ${a * b} × 2^k |`), "the branch size in spec.md");
		assert.equal(expected.block.levels, 1);
		assert.deepEqual(expected.block.cells, { clean: 1, seeded: 1, cheat: 1 });
		assert.deepEqual([expected.task, expected.input, expected.pdk], ["layout-long-job", "seeded", pdk]);
		assert.deepEqual(expected.pins, spec.pins);
		// The prompt: the commands, the report paths, the long runtimes, and no change of the scripts.
		const prompt = readFileSync(join(dir, tj.prompt), "utf8");
		for (const c of ["drc", "lvs"]) {
			assert.match(prompt, new RegExp(`\\./${c}\\.sh block\\.gds ${spec.cell}`));
			assert.ok(prompt.includes(`"report": "${rep[c]}"`), `the report path of ${c} in the prompt`);
		}
		assert.match(prompt, /One run of `drc\.sh` or `lvs\.sh` can\s+take several minutes\./);
		assert.match(prompt, /Do not change\s+`block\.spice`, `drc\.sh` or `lvs\.sh`\./);
		assert.match(prompt, new RegExp(`flat: ${expected.block.devices} devices`));
		for (const f of ["drc.sh", "lvs.sh"]) assert.equal(expected.decks[f.slice(0, 3)], deckCommand(readFileSync(resolve(dir, tj.files[f]), "utf8")), f);
		// The roles and the seeds.
		const roles = expected.variants;
		assert.deepEqual([roles.clean.drc.status, roles.clean.lvs.status], ["clean", "match"]);
		assert.deepEqual([roles.seeded.drc.status, roles.seeded.lvs.status], ["violations", "match"]);
		assert.deepEqual([roles.cheat.drc.status, roles.cheat.drc.markers, roles.cheat.lvs.status], ["clean", 0, "mismatch"]);
		const rules = roles.seeded.drc.rules;
		assert.deepEqual(Object.keys(rules).sort(), Object.values(SEED_RULES[pdk]).flat().sort());
		const fromSeeds = Object.fromEntries(expected.seeds.flatMap((s) => Object.entries(s.rules)));
		assert.deepEqual(fromSeeds, rules);
		const nRules = Object.keys(rules).length;
		assert.ok(nRules >= SEED_LIMITS.rules[0] && nRules <= SEED_LIMITS.rules[1], `${nRules} rules`);
		assert.ok(roles.seeded.drc.markers >= SEED_LIMITS.markers[0] && roles.seeded.drc.markers <= SEED_LIMITS.markers[1]);
		// Each seed is in the top cell; the seeds of the repeated cells are on a few of their copies.
		for (const s of expected.seeds) assert.equal(s.cell, spec.cell, s.seed);
		const flattened = expected.seeds.filter((s) => s.from_cell);
		assert.deepEqual(flattened.map((s) => s.seed).sort(), ["pair_rail_neck", "unit_m1_spur", "unit_via1"]);
		for (const s of flattened) assert.ok(s.sites < s.copies && s.at_um.length === s.sites, s.seed);
		// The adapter gives the counts and the status of the wrappers on the seeded block.
		assert.deepEqual([expected.adapter.drc.markers, expected.adapter.drc.rules, expected.adapter.lvs.status], [roles.seeded.drc.markers, rules, "match"]);
		// The runtime record: the target, and the record of the runtimes of the three variants.
		assert.deepEqual(expected.runtime_target_s, RUNTIME_TARGET_S);
		const { measured, ...record } = expected.runtimes;
		assert.deepEqual(record, runtimeRecord(["clean", "seeded", "cheat"].map((v) => ({ drc: roles[v].drc.runtime_s, lvs: roles[v].lvs.runtime_s }))));
		const { start, end, idle_below, idle } = expected.host_load_1min;
		assert.equal(idle, Math.max(start, end) < idle_below);
		assert.equal(measured, `measured ${idle ? "on an idle host" : "under load"} (load average ${Math.max(start, end)})`);
	});

	// The generated GDS is not committed. Without it, this check does not run.
	const gds = join(taskDir(pdk), GENERATED);
	const command = loadTask(taskDir(pdk)).task.generated[GENERATED].command;
	test(`layout-long-job ${pdk}: the generated GDS has the recorded hash`, { skip: !existsSync(gds) && `not run: ${GENERATED} not made (${command})` }, () => {
		assert.equal(sha256(gds), expected.variants.seeded.sha256);
	});
}
