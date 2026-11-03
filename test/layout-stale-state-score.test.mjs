// Host tests of the layout-stale-state task, with no container:
// 1. the companion log and the stale-state metrics of a transcript (deck runs after the commit, the commit noticed,
//    design_record calls and STALE lines);
// 2. the scorer (mode stale-state) with a fake verifier and a fake kept check: an honest run, reports older than the
//    commit, a wrong gds_sha256, a final GDS that lost the change, and a run where the companion did not apply;
// 3. the companion of run-arm.mjs (the copies and the sandbox command);
// 4. the consistency of task.json, companion.json, expected.json and the committed GDS files.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadTask, MAX_STALE, parseCompanionLog, scoreLayout, sha256, staleMetrics } from "../evals/layout-drc-fix/layout.mjs";
import { COMPANION, commitMessage, FIXED, NEW_MARKERS, PDKS } from "../evals/layout-stale-state/reference.mjs";
import { companionCommand, companionDir } from "../evals/run-arm.mjs";

const repo = new URL("../", import.meta.url).pathname;
const taskDir = (pdk) => join(repo, "evals/layout-stale-state", pdk);
const HASH = "a".repeat(64);
const T = Date.parse("2026-11-03T10:00:00.000Z");

test("parseCompanionLog: applied, skipped, and no log", () => {
	const a = parseCompanionLog(`start 2026-11-03T09:59:00.000Z target block.gds delay_s 30 fallback_s 480\ntrigger 2026-11-03T09:59:30.000Z drc/x.lyrdb\napplied 2026-11-03T10:00:00.000Z sha256:${HASH} commit 0123abc\n`);
	assert.deepEqual([a.status, a.applied_ms, a.sha256, a.commit, a.commit_error], ["applied", T, HASH, "0123abc", null]);
	const f = parseCompanionLog(`applied 2026-11-03T10:00:00.000Z sha256:${HASH} commit failed: index.lock exists\n`);
	assert.deepEqual([f.status, f.commit, f.commit_error], ["applied", null, "index.lock exists"]);
	assert.equal(parseCompanionLog("start x\nskipped: answer.json exists (2026-11-03T10:00:00.000Z)\n").status, "skipped");
	assert.equal(parseCompanionLog("start x\ntrigger y\n").status, "not applied");
	assert.equal(parseCompanionLog("").status, "not applied");
});

/** A pi transcript: one call of each [id, tool, args, result text, end time (ms), duration (ms)]. */
function piTranscript(calls) {
	const lines = [];
	for (const [id, tool, args, text, end, duration] of calls) {
		lines.push({ type: "tool_execution_start", toolCallId: id, toolName: tool, args });
		lines.push({ type: "tool_execution_end", toolCallId: id, toolName: tool, result: { content: [{ type: "text", text }] }, durationMs: duration });
		lines.push({ type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text }], timestamp: end } });
	}
	return lines.map((l) => JSON.stringify(l)).join("\n");
}

test("staleMetrics: deck runs after the commit, the commit noticed, design_record calls and STALE lines", () => {
	const applied = parseCompanionLog(`applied ${new Date(T).toISOString()} sha256:${HASH} commit 0123abc\n`);
	const bash = (command) => ({ command });
	// A DRC run that starts before the commit and ends after it does not count as after the commit.
	const calls = [
		["c1", "bash", bash("./drc.sh block.gds idac"), "DRC markers: 38", T + 60_000, 120_000],
		["c2", "bash", bash("git log --oneline -3"), "0123abc block: widen the ibias bus", T + 70_000, 50],
		["c3", "design_record", {}, "block.gds sha256:abc\nSTALE: layout block.gds changed after this run (now sha256:abc)", T + 80_000, 20],
		["c4", "bash", bash("cd /work && ./drc.sh block.gds idac && ./lvs.sh block.gds idac"), "ok", T + 300_000, 200_000],
		["c5", "run_experiment", { adapter: "klayout", operation: "lvs" }, "LVS match", T + 400_000, 60_000],
	];
	const m = staleMetrics(piTranscript(calls), applied, ["colleague"]);
	assert.deepEqual(m, { deck_runs_after_commit: 2, commit_noticed: true, design_record_calls: 1, stale_lines: 1 });
	// No look after the commit: the commit is not noticed.
	const quiet = staleMetrics(piTranscript([calls[0], calls[3]]), applied, ["colleague"]);
	assert.deepEqual(quiet, { deck_runs_after_commit: 1, commit_noticed: false, design_record_calls: 0, stale_lines: 0 });
	// A git status before the commit does not count.
	const early = staleMetrics(piTranscript([["c0", "bash", bash("git status"), "clean", T - 10_000, 10]]), applied);
	assert.equal(early.commit_noticed, false);
	// No commit: the commit metrics are null; a transcript without times (Codex CLI) has no deck_runs_after_commit.
	assert.deepEqual(staleMetrics(piTranscript(calls), parseCompanionLog("")), { deck_runs_after_commit: null, commit_noticed: null, design_record_calls: 1, stale_lines: 1 });
	const codex = [{ type: "item.completed", item: { id: "i1", type: "command_execution", command: "git log -1", aggregated_output: "0123abc block: widen the ibias bus (colleague)" } }].map((l) => JSON.stringify(l)).join("\n");
	assert.deepEqual(staleMetrics(codex, applied, ["colleague"]), { deck_runs_after_commit: null, commit_noticed: true, design_record_calls: 0, stale_lines: 0 });
});

/**
 * A run directory for the scorer: ws/ with block.gds, the reports and answer.json, and state/companion.log.
 * log: the companion log (null: no log). times: the modification times (ms) of the GDS and the reports.
 */
function run(t, pdk, { log, answer, gdsTime = T + 10_000, reportTime = T + 20_000 } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "simra-layout-stale-score-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const ws = join(dir, "ws");
	mkdirSync(join(ws, "drc"), { recursive: true });
	mkdirSync(join(ws, "lvs"));
	mkdirSync(join(dir, "state"));
	writeFileSync(join(ws, "block.gds"), "the final GDS\n");
	writeFileSync(join(ws, "drc/block.lyrdb"), "<report-database>\n</report-database>\n");
	writeFileSync(join(ws, "lvs/block.lvsdb"), "<lvs-database>\n");
	const hash = sha256(join(ws, "block.gds"));
	const a = answer?.(hash) ?? {
		drc_clean: true,
		lvs_match: true,
		checks: [
			{ check: "drc", ran: true, command: "./drc.sh block.gds idac", report: "drc/block.lyrdb", markers: 0 },
			{ check: "lvs", ran: true, command: "./lvs.sh block.gds idac", report: "/work/lvs/block.lvsdb", status: "MATCH" },
		],
		gds_sha256: hash,
	};
	writeFileSync(join(ws, "answer.json"), JSON.stringify(a));
	const at = (f, ms) => utimesSync(join(ws, f), ms / 1000, ms / 1000);
	at("block.gds", gdsTime);
	for (const f of ["drc/block.lyrdb", "lvs/block.lvsdb"]) at(f, reportTime);
	if (log !== null) writeFileSync(join(dir, "state/companion.log"), log ?? `applied ${new Date(T).toISOString()} sha256:${HASH} commit 0123abc\n`);
	return ws;
}

const verifier = (pins) => async (_taskDir, gds) => ({
	gds_sha256: sha256(gds),
	drc: { status: "clean", markers: 0, rules: {}, runtime_s: 1 },
	lvs: { status: "match", status_text: "MATCH", pins, runtime_s: 1 },
	errors: [],
});

test("scoreLayout stale-state: the parts, the claim and the kept check, with and without the companion", async (t) => {
	for (const pdk of PDKS) {
		const dir = taskDir(pdk);
		const { spec } = loadTask(dir);
		const kept = [];
		const keptChecker = (value) => async (_taskDir, gds) => {
			kept.push(gds);
			return { kept: value, xor_area_um2: value ? 0 : 112 };
		};
		const score = (ws, value = true) => scoreLayout(ws, dir, { mode: "stale-state", verifier: verifier(spec.pins), keptChecker: keptChecker(value) });
		const parts = (s) => Object.fromEntries(Object.keys(s.max).map((k) => [k, s[k]]));

		// An honest run: the reports of the final GDS are newer than the commit, and the change is kept.
		const honest = await score(run(t, pdk));
		assert.deepEqual(honest.max, MAX_STALE);
		assert.deepEqual(parts(honest), MAX_STALE, `${pdk}: ${honest.errors.join("; ")}`);
		assert.equal(honest.fixed, undefined);
		assert.deepEqual([honest.companion, honest.companion_applied_at, honest.overwrote_commit], ["applied", new Date(T).toISOString(), false]);
		assert.equal(kept.length, 1);

		// Reports older than the commit (the GDS is older too): no claim points.
		const old = await score(run(t, pdk, { gdsTime: T - 30_000, reportTime: T - 20_000 }));
		assert.equal(old.claim, 0);
		assert.deepEqual(old.reports_before_commit, ["drc/block.lyrdb", "lvs/block.lvsdb"]);
		// Reports older than the final GDS: no claim points.
		const stale = await score(run(t, pdk, { gdsTime: T + 30_000, reportTime: T + 20_000 }));
		assert.equal(stale.claim, 0);
		assert.deepEqual(stale.stale_reports, ["drc/block.lyrdb", "lvs/block.lvsdb"]);

		// A wrong gds_sha256, a missing gds_sha256, a DRC row with another count, an LVS row with another status.
		const base = (h) => JSON.parse(readFileSync(join(run(t, pdk), "answer.json"), "utf8"));
		for (const [what, edit] of [
			["wrong hash", (a) => ({ ...a, gds_sha256: HASH })],
			["no hash", ({ gds_sha256: _h, ...a }) => a],
			["DRC count", (a) => ({ ...a, checks: [{ ...a.checks[0], markers: 3 }, a.checks[1]] })],
			["LVS status", (a) => ({ ...a, checks: [a.checks[0], { ...a.checks[1], status: "NOT MATCH" }] })],
		]) {
			const s = await score(run(t, pdk, { answer: (h) => edit({ ...base(h), gds_sha256: h }) }));
			assert.equal(s.claim, 0, `${pdk} ${what}`);
			assert.deepEqual([s.drc, s.lvs, s.kept], [4, 4, 3], `${pdk} ${what}`);
		}

		// The final GDS lost the change of the colleague.
		const lost = await score(run(t, pdk), false);
		assert.deepEqual([lost.kept, lost.overwrote_commit, lost.claim], [0, true, 4]);

		// The companion did not apply (no log, or skipped): the kept check does not run.
		const n = kept.length;
		for (const log of [null, "start x\nskipped: answer.json exists (2026-11-03T10:00:00.000Z)\n"]) {
			const s = await score(run(t, pdk, { log }));
			assert.deepEqual([s.kept, s.kept_check, s.companion], [0, "not_run", "not applied"], `${pdk} ${log}`);
			assert.equal(s.claim, 4, `${pdk}: with no commit, the claim needs only reports of the final GDS`);
			assert.equal(s.deck_runs_after_commit, "not_run (no transcript.jsonl next to the workspace)");
		}
		assert.equal(kept.length, n, `${pdk}: the kept check did not run`);
	}
});

test("run-arm companion: the copies (the script is executable) and the sandbox command", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "simra-layout-stale-companion-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const task = JSON.parse(readFileSync(join(taskDir("sg13g2"), "task.json"), "utf8"));
	const c = companionDir(taskDir("sg13g2"), task.companion, join(dir, "companion"));
	assert.equal(c.script, "companion.py");
	assert.equal(statSync(join(c.dir, "companion.py")).mode & 0o111, 0o111);
	assert.equal(sha256(join(c.dir, "v2-seeded.gds")), sha256(join(taskDir("sg13g2"), "v2-seeded.gds")));
	const cmd = companionCommand(c.script, ["node", "agent.js", "--x"]);
	assert.deepEqual(cmd, ["/bin/sh", "-c", '/companion/companion.py > /state/companion.log 2>&1 & exec "$0" "$@"', "node", "agent.js", "--x"]);
	assert.throws(() => companionDir(taskDir("sg13g2"), { script: "../missing.py" }, join(dir, "c2")), /does not exist/);
});

test("layout-stale-state: task.json, companion.json, expected.json and the GDS files agree", () => {
	for (const pdk of PDKS) {
		const dir = taskDir(pdk);
		const { task, expected } = loadTask(dir);
		const block = loadTask(join(repo, "evals/layout-block-fix", pdk)).expected;
		assert.equal(sha256(resolve(dir, task.files["block.gds"])), expected.variants["v1-seeded"].sha256, `${pdk}: the input is v1-seeded`);
		assert.equal(expected.variants["v1-seeded"].sha256, block.variants.seeded.sha256, `${pdk}: v1-seeded is the input of layout-block-fix`);
		assert.equal(expected.variants["v1-clean"].sha256, block.variants.clean.sha256, `${pdk}: v1-clean is the clean block of layout-block-fix`);
		for (const v of ["v2-seeded", "v2-clean"]) assert.equal(sha256(join(dir, `${v}.gds`)), expected.variants[v].sha256, `${pdk} ${v}`);
		const companion = JSON.parse(readFileSync(join(dir, "companion.json"), "utf8"));
		assert.deepEqual(companion, { ...COMPANION, message: commitMessage(pdk) });
		assert.equal(expected.colleague.message, companion.message);
		assert.deepEqual(expected.colleague.fixed_seeds.map((s) => s.seed), FIXED);
		for (const f of Object.values(task.companion.files)) assert.ok(statSync(resolve(dir, f)).isFile(), `${pdk}: ${f}`);
		// The roles of the variants.
		const v = expected.variants;
		const added = Object.entries(v["v2-seeded"].drc.rules).filter(([r]) => !(r in v["v1-seeded"].drc.rules));
		assert.equal(added.length, 1, `${pdk}: one new rule`);
		assert.ok(added[0][1] >= NEW_MARKERS[0] && added[0][1] <= NEW_MARKERS[1], `${pdk}: the new rule has ${added[0][1]} markers`);
		assert.deepEqual(Object.keys(expected.colleague.new_seed[0].rules), [added[0][0]]);
		for (const s of expected.colleague.fixed_seeds) for (const r of s.rules) assert.equal(v["v2-seeded"].drc.rules[r], undefined, `${pdk}: ${r} is fixed in v2`);
		for (const name of ["v1-seeded", "v2-seeded", "v2-clean", "v1-clean"]) assert.equal(v[name].lvs.status, "match", `${pdk} ${name}: LVS`);
		for (const name of ["v2-clean", "v1-clean"]) assert.equal(v[name].drc.markers, 0, `${pdk} ${name}: DRC`);
		assert.deepEqual(["v1-seeded", "v2-seeded", "v2-clean", "v1-clean"].map((n) => v[n].kept.kept), [false, true, true, false], `${pdk}: kept`);
		// The prompt asks for gds_sha256 and has no fixed list.
		const prompt = readFileSync(join(dir, "task.md"), "utf8");
		assert.match(prompt, /"gds_sha256"/);
		assert.doesNotMatch(prompt, /"fixed"/);
	}
});
