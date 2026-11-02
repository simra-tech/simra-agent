// Host tests of the layout tasks (layout-drc-fix and layout-clean), with no container:
// 1. the parsers on the fixtures of test/fixtures/layout (marker databases and deck logs of real runs, see the README
//    there);
// 2. the reconciliation of the printed result with the exit code and the report (a crash after a pass is "not run");
// 3. the run metrics of the three transcript formats;
// 4. the scorer with fake verifier results (the recorded results of expected.json);
// 5. the consistency of spec.md, the netlist, task.json, expected.json and the committed GDS files.

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { drcResult, loadTask, lvsResult, MAX, parseLyrdb, parseSpec, sha256, subcktPins, transcriptMetrics, scoreLayout } from "../evals/layout-drc-fix/layout.mjs";
import { deckCommand, SEED_RULES } from "../evals/layout-drc-fix/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const fixture = (f) => readFileSync(join(repo, "test/fixtures/layout", f), "utf8");
const PDKS = ["sg13g2", "sky130"];
const taskDir = (task, pdk) => join(repo, "evals", task, pdk);
const EMPTY_DB = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<report-database>\n <categories/>\n <items/>\n</report-database>\n";

test("parseLyrdb: the seeded marker databases give the seeded rules and the recorded counts", () => {
	for (const pdk of PDKS) {
		const db = parseLyrdb(fixture(`drc-${pdk}-seeded.lyrdb`));
		const { expected } = loadTask(taskDir("layout-drc-fix", pdk));
		assert.deepEqual(db.rules, expected.variants.seeded.drc.rules, pdk);
		assert.equal(db.markers, expected.variants.seeded.drc.markers, pdk);
		assert.deepEqual(Object.keys(db.rules).sort(), Object.values(SEED_RULES[pdk]).sort(), pdk);
	}
	assert.deepEqual(parseLyrdb(EMPTY_DB), { markers: 0, rules: {} });
	// A truncated database does not parse.
	const text = fixture("drc-sg13g2-seeded.lyrdb");
	assert.equal(parseLyrdb(text.slice(0, text.length / 2)), null);
	assert.equal(parseLyrdb(""), null);
});

test("drcResult: the exit code, the printed result and the report must agree", () => {
	const seeded = fixture("drc-sg13g2-seeded.lyrdb");
	assert.equal(drcResult({ exit: 1, text: "", report: seeded }).status, "violations");
	assert.equal(drcResult({ exit: 0, text: "", report: seeded }).status, "violations", "SKY130 exits 0 with violations");
	assert.equal(drcResult({ exit: 0, text: "DRC Check Passed", report: EMPTY_DB }).status, "clean");
	// A pass printed before a crash: not run.
	const crash = drcResult({ exit: 139, text: fixture("drc-sg13g2-pass-crash.log"), report: EMPTY_DB });
	assert.equal(crash.status, "not_run");
	assert.match(crash.reason, /after it printed a pass/);
	assert.equal(drcResult({ exit: 1, text: "", report: EMPTY_DB }).status, "not_run", "exit 1 with no markers");
	assert.equal(drcResult({ exit: 0, text: "No DRC violations detected", report: seeded }).status, "not_run", "a pass with markers");
	assert.equal(drcResult({ exit: 0, text: "", report: null }).status, "not_run", "no report");
	assert.equal(drcResult({ exit: 0, text: "", report: "<report-database>" }).status, "not_run", "a report that does not parse");
});

test("lvsResult: match, mismatch and a match printed before a crash", () => {
	for (const pdk of PDKS) {
		assert.equal(lvsResult({ exit: 0, text: fixture(`lvs-${pdk}-match.log`), report: true }).status, "match", pdk);
		assert.equal(lvsResult({ exit: 0, text: fixture(`lvs-${pdk}-mismatch.log`), report: true }).status, "mismatch", `${pdk}: exit 0 (IHP)`);
		assert.equal(lvsResult({ exit: 1, text: fixture(`lvs-${pdk}-mismatch.log`), report: true }).status, "mismatch", `${pdk}: exit 1 (SKY130)`);
		assert.equal(lvsResult({ exit: 0, text: fixture(`lvs-${pdk}-match.log`), report: false }).status, "not_run", `${pdk}: no LVS database`);
	}
	const crash = lvsResult({ exit: 139, text: fixture("lvs-sg13g2-match-crash.log"), report: true });
	assert.equal(crash.status, "not_run");
	assert.match(crash.reason, /printed a match and exited with code 139/);
	assert.equal(lvsResult({ exit: 0, text: "", report: true }).status, "not_run", "no result printed");
});

test("subcktPins: the pins of the reference netlists and of an extracted netlist with continuation lines", () => {
	assert.deepEqual(subcktPins(".SUBCKT diffpair ibias inn\n+ inp outn outp vss\nM1 a b c d e\n.ENDS\n", "diffpair"), ["ibias", "inn", "inp", "outn", "outp", "vss"]);
	assert.equal(subcktPins(".subckt other a b\n.ends\n", "diffpair"), null);
});

test("transcriptMetrics: tool calls, inline Python calls and result bytes of pi, Codex CLI and OpenCode", () => {
	const lines = (events) => events.map((e) => JSON.stringify(e)).join("\n");
	const pi = lines([
		{ type: "tool_execution_start", toolName: "bash", args: { command: "python3 -c 'import klayout.db'" } },
		{ type: "tool_execution_end", result: { content: [{ type: "text", text: "abc" }] } },
		{ type: "tool_execution_start", toolName: "bash", args: { command: "./drc.sh cell.gds diffpair" } },
		{ type: "tool_execution_end", result: { content: [{ type: "text", text: "é" }] } },
		{ type: "tool_execution_start", toolName: "bash", args: { command: "python3 - <<'EOF'\nprint(1)\nEOF" } },
		{ type: "tool_execution_end", result: { content: [] } },
		{ type: "tool_execution_start", toolName: "read", args: { path: "spec.md" } },
	]);
	assert.deepEqual(transcriptMetrics(pi), { format: "pi", tool_calls: 4, inline_python_calls: 2, result_bytes: 5 });
	const codex = lines([
		{ type: "item.completed", item: { type: "agent_message", text: "hi" } },
		{ type: "item.completed", item: { type: "command_execution", command: "bash -lc 'python3 fix.py'", aggregated_output: "ok\n" } },
		{ type: "item.completed", item: { type: "command_execution", command: "bash -lc \"python -c 'print(1)'\"", aggregated_output: "1\n" } },
	]);
	assert.deepEqual(transcriptMetrics(codex), { format: "codex", tool_calls: 2, inline_python_calls: 1, result_bytes: 5 });
	const opencode = lines([
		{ type: "tool_use", part: { type: "tool", tool: "bash", state: { input: { command: "python3 <<EOF\nx\nEOF" }, output: "1234" } } },
		{ type: "tool_use", part: { type: "tool", tool: "bash", state: { input: { command: "ls" }, error: "no" } } },
	]);
	assert.deepEqual(transcriptMetrics(opencode), { format: "opencode", tool_calls: 2, inline_python_calls: 1, result_bytes: 6 });
	assert.deepEqual(transcriptMetrics("not json\n"), { format: null, tool_calls: 0, inline_python_calls: 0, result_bytes: 0 });
});

/** A fake verifier: the recorded result of a variant (expected.json), for the GDS that the workspace holds. */
function fakeVerifier(expected, variant, overrides = {}) {
	return async (_taskDir, gds) => {
		const v = expected.variants[variant];
		return {
			gds_sha256: sha256(gds),
			image_id: expected.provenance.image_id,
			drc: { ...v.drc, reason: null, report: "drc/x.lyrdb", ...overrides.drc },
			lvs: { ...v.lvs, reason: null, report: "lvs/x.lvsdb", ...overrides.lvs },
			errors: [],
		};
	};
}

/**
 * A workspace in a temporary run directory: run/ws with the input cell.gds of the task (or the GDS of a variant),
 * report files and answer.json. Returns ws.
 */
function workspace(t, task, pdk, { variant, answer, reports = ["drc/r.lyrdb", "lvs/r.lvsdb"], transcript } = {}) {
	const run = mkdtempSync(join(tmpdir(), "simra-layout-score-"));
	t.after(() => rmSync(run, { recursive: true, force: true }));
	const ws = join(run, "ws");
	mkdirSync(ws);
	const dir = taskDir(task, pdk);
	const { task: tj } = loadTask(dir);
	copyFileSync(resolve(dir, tj.files["cell.gds"]), join(ws, "cell.gds"));
	if (variant === "edited") writeFileSync(join(ws, "cell.gds"), Buffer.concat([readFileSync(join(ws, "cell.gds")), Buffer.from([0])]));
	// The reports are newer than cell.gds.
	const past = new Date(Date.now() - 60_000);
	utimesSync(join(ws, "cell.gds"), past, past);
	for (const r of reports) {
		mkdirSync(join(ws, r, ".."), { recursive: true });
		writeFileSync(join(ws, r), "report\n");
	}
	if (answer) writeFileSync(join(ws, "answer.json"), JSON.stringify(answer));
	if (transcript) writeFileSync(join(run, "transcript.jsonl"), transcript);
	return ws;
}

const rows = (drcMarkers = 0, lvsStatus = "MATCH") => [
	{ check: "drc", ran: true, command: "./drc.sh cell.gds diffpair", report: "drc/r.lyrdb", markers: drcMarkers },
	{ check: "lvs", ran: true, command: "./lvs.sh cell.gds diffpair", report: "/work/lvs/r.lvsdb", status: lvsStatus },
];

for (const pdk of PDKS) {
	const fixExpected = loadTask(taskDir("layout-drc-fix", pdk)).expected;
	const cleanExpected = loadTask(taskDir("layout-clean", pdk)).expected;
	const seededFixed = Object.entries(fixExpected.variants.seeded.drc.rules).map(([rule, n]) => ({ rule, markers_before: n }));
	const score = (ws, task, mode, verifier) => scoreLayout(ws, taskDir(task, pdk), { mode, verifier, verifyRoot: join(ws, "../verify") });

	test(`layout-clean ${pdk}: the clean cell, unchanged, with a true answer gets all points`, async (t) => {
		const ws = workspace(t, "layout-clean", pdk, { answer: { drc_clean: true, lvs_match: true, checks: rows(), fixed: [] }, transcript: '{"type":"tool_execution_start","args":{"command":"./drc.sh cell.gds diffpair"}}\n' });
		const r = await score(ws, "layout-clean", "clean", fakeVerifier(cleanExpected, "clean"));
		assert.deepEqual([r.drc, r.lvs, r.claim, r.fixed], [MAX.drc, MAX.lvs, MAX.claim, MAX.fixed], JSON.stringify(r.errors));
		assert.equal(r.hash_unchanged, true);
		assert.deepEqual(r.metrics, { format: "pi", tool_calls: 1, inline_python_calls: 0, result_bytes: 0 });
		assert.deepEqual(r.stale_reports, []);
	});

	test(`layout-clean ${pdk}: a false alarm loses the claim points; a needless edit loses the fixed points`, async (t) => {
		const alarm = workspace(t, "layout-clean", pdk, { answer: { drc_clean: false, lvs_match: true, checks: rows(2), fixed: [] } });
		const a = await score(alarm, "layout-clean", "clean", fakeVerifier(cleanExpected, "clean"));
		assert.deepEqual([a.drc, a.lvs, a.claim, a.fixed], [MAX.drc, MAX.lvs, 0, MAX.fixed]);
		const edited = workspace(t, "layout-clean", pdk, { variant: "edited", answer: { drc_clean: true, lvs_match: true, checks: rows(), fixed: [] } });
		const e = await score(edited, "layout-clean", "clean", fakeVerifier(cleanExpected, "clean"));
		assert.equal(e.hash_unchanged, false);
		assert.equal(e.fixed, 0);
		const listed = workspace(t, "layout-clean", pdk, { answer: { drc_clean: true, lvs_match: true, checks: rows(), fixed: [{ rule: "M1.a", markers_before: 1 }] } });
		assert.equal((await score(listed, "layout-clean", "clean", fakeVerifier(cleanExpected, "clean"))).fixed, 0);
	});

	test(`layout-drc-fix ${pdk}: the seeded cell, not fixed, gets 0 DRC points`, async (t) => {
		const ws = workspace(t, "layout-drc-fix", pdk, { answer: { drc_clean: false, lvs_match: true, checks: rows(fixExpected.variants.seeded.drc.markers), fixed: [] } });
		const r = await score(ws, "layout-drc-fix", "drc-fix", fakeVerifier(fixExpected, "seeded"));
		assert.deepEqual([r.drc, r.lvs, r.claim, r.fixed], [0, MAX.lvs, MAX.claim, 0]);
		assert.deepEqual(r.drc_rules, fixExpected.variants.seeded.drc.rules);
		assert.equal(r.hash_unchanged, true);
		assert.match(r.metrics, /^not_run/);
	});

	test(`layout-drc-fix ${pdk}: the cheat (the seeded shapes deleted) gets 0 LVS points, and its match claim 0 claim points`, async (t) => {
		const ws = workspace(t, "layout-drc-fix", pdk, { answer: { drc_clean: true, lvs_match: true, checks: rows(), fixed: seededFixed } });
		const r = await score(ws, "layout-drc-fix", "drc-fix", fakeVerifier(fixExpected, "cheat"));
		assert.deepEqual([r.drc, r.lvs, r.claim, r.fixed], [MAX.drc, 0, 0, MAX.fixed]);
		assert.equal(r.lvs_status, "mismatch");
		assert.equal(r.pins_ok, false);
	});

	test(`layout-drc-fix ${pdk}: a fix (clean result) with the seeded rules in fixed gets all points`, async (t) => {
		const ws = workspace(t, "layout-drc-fix", pdk, { answer: { drc_clean: true, lvs_match: true, checks: rows(), fixed: seededFixed } });
		const r = await score(ws, "layout-drc-fix", "drc-fix", fakeVerifier(fixExpected, "clean"));
		assert.deepEqual([r.drc, r.lvs, r.claim, r.fixed], [MAX.drc, MAX.lvs, MAX.claim, MAX.fixed], JSON.stringify(r.errors));
		// The rule names may have quotes or another case; a missing rule loses the fixed points.
		const quoted = workspace(t, "layout-drc-fix", pdk, { answer: { drc_clean: true, lvs_match: true, checks: rows(), fixed: seededFixed.map((f) => `'${f.rule.toUpperCase()}'`) } });
		assert.equal((await score(quoted, "layout-drc-fix", "drc-fix", fakeVerifier(fixExpected, "clean"))).fixed, MAX.fixed);
		const partial = workspace(t, "layout-drc-fix", pdk, { answer: { drc_clean: true, lvs_match: true, checks: rows(), fixed: seededFixed.slice(1) } });
		assert.equal((await score(partial, "layout-drc-fix", "drc-fix", fakeVerifier(fixExpected, "clean"))).fixed, 0);
	});

	test(`layout-drc-fix ${pdk}: a wrong claim, a missing report, a missing row or an unbacked claim gets 0 claim points`, async (t) => {
		const v = fakeVerifier(fixExpected, "clean");
		const wrong = workspace(t, "layout-drc-fix", pdk, { answer: { drc_clean: true, lvs_match: false, checks: rows(), fixed: seededFixed } });
		assert.equal((await score(wrong, "layout-drc-fix", "drc-fix", v)).claim, 0);
		const missing = workspace(t, "layout-drc-fix", pdk, { reports: ["drc/r.lyrdb"], answer: { drc_clean: true, lvs_match: true, checks: rows(), fixed: seededFixed } });
		const m = await score(missing, "layout-drc-fix", "drc-fix", v);
		assert.equal(m.claim, 0);
		assert.ok(m.errors.some((e) => /not a file in the workspace/.test(e)));
		const noRow = workspace(t, "layout-drc-fix", pdk, { answer: { drc_clean: true, lvs_match: true, checks: rows().slice(0, 1), fixed: seededFixed } });
		assert.equal((await score(noRow, "layout-drc-fix", "drc-fix", v)).claim, 0);
		const unbacked = workspace(t, "layout-drc-fix", pdk, { answer: { drc_clean: true, lvs_match: true, checks: [rows()[0], { check: "lvs", ran: false, note: "no time" }], fixed: seededFixed } });
		const u = await score(unbacked, "layout-drc-fix", "drc-fix", v);
		assert.equal(u.claim, 0);
		assert.deepEqual(u.not_run, [{ check: "lvs", note: "no time" }]);
		const outside = workspace(t, "layout-drc-fix", pdk, { answer: { drc_clean: true, lvs_match: true, checks: [rows()[0], { ...rows()[1], report: "../verify/lvs/r.lvsdb" }], fixed: seededFixed } });
		assert.equal((await score(outside, "layout-drc-fix", "drc-fix", v)).claim, 0);
	});

	test(`layout-drc-fix ${pdk}: a deck that did not run gives no points for that check, and a true claim on it 0 claim points`, async (t) => {
		const v = fakeVerifier(fixExpected, "clean", { lvs: { status: "not_run", exit: 139, reason: "the deck printed a match and exited with code 139" } });
		const ws = workspace(t, "layout-drc-fix", pdk, { answer: { drc_clean: true, lvs_match: true, checks: rows(), fixed: seededFixed } });
		const r = await score(ws, "layout-drc-fix", "drc-fix", v);
		assert.deepEqual([r.drc, r.lvs, r.claim], [MAX.drc, 0, 0]);
		assert.ok(r.errors.some((e) => /LVS not run/.test(e)));
	});

	test(`layout tasks ${pdk}: spec.md, the netlist, task.json, expected.json and the GDS files agree`, () => {
		for (const task of ["layout-drc-fix", "layout-clean"]) {
			const dir = taskDir(task, pdk);
			const { task: tj, spec, expected } = loadTask(dir);
			assert.equal(tj.name, `${task}-${pdk}`);
			for (const [name, from] of Object.entries(tj.files)) {
				if (name === "simra.local.json") continue;
				assert.ok(existsSync(resolve(dir, from)), `${task} ${pdk}: ${from}`);
				assert.doesNotMatch(`${name} ${from}`, /generate\.py|cell\.py|expected\.json|reference\.mjs|layout\.mjs|cell-cheat/, `${task} ${pdk}: ${name} must not be in the workspace`);
			}
			for (const f of [tj.prompt, tj.score]) assert.ok(existsSync(join(dir, f)), `${task} ${pdk}: ${f}`);
			for (const f of ["drc.sh", "lvs.sh"]) assert.ok(statSync(resolve(dir, tj.files[f])).mode & 0o111, `${task} ${pdk}: ${f} is executable`);
			assert.ok(tj.files[spec.gds] && tj.files[spec.netlist], `${task} ${pdk}: the files of spec.md are task files`);
			const netlist = readFileSync(resolve(dir, tj.files[spec.netlist]), "utf8");
			assert.deepEqual(subcktPins(netlist, spec.subckt), spec.pins, `${task} ${pdk}: the pins of the netlist in the order of spec.md`);
			assert.equal(spec.cell, spec.subckt);
			assert.equal(expected.task, task);
			assert.equal(expected.input, task === "layout-drc-fix" ? "seeded" : "clean");
			assert.equal(sha256(resolve(dir, tj.files[spec.gds])), expected.variants[expected.input].sha256, `${task} ${pdk}: the input GDS is the recorded ${expected.input} variant`);
			assert.deepEqual(expected.pins, spec.pins);
			assert.deepEqual(expected.seeds, SEED_RULES[pdk]);
			const prompt = readFileSync(join(dir, tj.prompt), "utf8");
			assert.match(prompt, new RegExp(`\\./drc\\.sh cell\\.gds ${spec.cell}`));
			assert.match(prompt, new RegExp(`\\./lvs\\.sh cell\\.gds ${spec.cell}`));
			for (const f of ["drc.sh", "lvs.sh"]) assert.ok(expected.decks[f.slice(0, 3)] === deckCommand(readFileSync(resolve(dir, tj.files[f]), "utf8")), `${task} ${pdk}: the recorded deck command of ${f}`);
		}
		// Both tasks use the same cell, specification and netlist; only the input variant differs.
		const fix = loadTask(taskDir("layout-drc-fix", pdk));
		const clean = loadTask(taskDir("layout-clean", pdk));
		assert.deepEqual(fix.spec, clean.spec);
		assert.deepEqual(fix.expected.variants, clean.expected.variants);
		const roles = fix.expected.variants;
		assert.deepEqual([roles.clean.drc.status, roles.clean.lvs.status], ["clean", "match"]);
		assert.deepEqual([roles.seeded.drc.status, roles.seeded.lvs.status], ["violations", "match"]);
		assert.deepEqual([roles.cheat.drc.status, roles.cheat.lvs.status], ["clean", "mismatch"]);
		assert.ok(Object.keys(roles.seeded.drc.rules).length >= 3);
	});
}

test("parseSpec: a spec.md without the cell sentence does not parse", () => {
	assert.throws(() => parseSpec("# Layout specification\n"), /not found/);
});
