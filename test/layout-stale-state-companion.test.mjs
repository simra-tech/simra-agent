// The colleague of layout-stale-state (evals/layout-stale-state/companion.py) on a fake workspace: it waits for the
// first complete marker database and the delay (or the fallback), then commits the new version of block.gds as the
// colleague; it does nothing when a final answer.json exists, and acts over a preliminary one. Host (python3 and git), and one case in the sandbox of
// run-arm.mjs (container).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../evals/layout-stale-state/companion.py", import.meta.url).pathname;
const sha = (text) => createHash("sha256").update(text).digest("hex");
const MESSAGE = "block: widen the ibias bus; fix M2.b and M3.b";

/** A workspace with block.gds ("v1") in one commit, and a companion directory with companion.json and v2-seeded.gds ("v2"). */
function setup(t) {
	const root = mkdtempSync(join(tmpdir(), "simra-companion-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const work = join(root, "work");
	const dir = join(root, "companion");
	mkdirSync(work);
	mkdirSync(dir);
	copyFileSync(script, join(dir, "companion.py"));
	writeFileSync(join(dir, "companion.json"), JSON.stringify({ gds: "v2-seeded.gds", target: "block.gds", message: MESSAGE, delay_s: 30, fallback_s: 480 }));
	writeFileSync(join(dir, "v2-seeded.gds"), "v2");
	writeFileSync(join(work, "block.gds"), "v1");
	git(work, "init", "-q");
	git(work, "add", "block.gds");
	git(work, "commit", "-q", "-m", "design");
	return { work, dir };
}

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@localhost", ...args], { cwd, encoding: "utf8" }).trim();

function run({ work, dir }, ...args) {
	const r = spawnSync("python3", [join(dir, "companion.py"), "--work", work, "--dir", dir, ...args], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
}

/** Write a marker database under work, complete or not, with a modification time ago_s seconds in the past. */
function report(work, path, { complete = true, ago_s = 0 } = {}) {
	const full = join(work, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, `<?xml version="1.0" encoding="utf-8"?>\n<report-database>\n <items/>\n${complete ? "</report-database>\n" : ""}`);
	const t = Date.now() / 1000 - ago_s;
	utimesSync(full, t, t);
}

test("the companion waits while there is no complete report, and while the delay runs", (t) => {
	const ws = setup(t);
	assert.match(run(ws, "--once"), /^waiting \S+Z$/m);
	report(ws.work, "drc/block_idac_full.lyrdb", { complete: false, ago_s: 120 });
	report(ws.work, ".git/x.lyrdb", { ago_s: 120 });
	assert.doesNotMatch(run(ws, "--once"), /trigger|applied/);
	report(ws.work, "simra/experiments/e1/block_idac_full.lyrdb", { ago_s: 5 });
	const out = run(ws, "--once");
	assert.match(out, /^trigger \S+Z simra\/experiments\/e1\/block_idac_full\.lyrdb$/m);
	assert.match(out, /^waiting /m);
	assert.equal(readFileSync(join(ws.work, "block.gds"), "utf8"), "v1");
	assert.equal(git(ws.work, "rev-list", "--count", "HEAD"), "1");
});

test("the companion commits the new version as the colleague after the first complete report and the delay", (t) => {
	const ws = setup(t);
	report(ws.work, "drc/block_idac_full.lyrdb", { ago_s: 60 });
	// The agent has its own change to the file and another uncommitted file: only block.gds goes into the commit.
	writeFileSync(join(ws.work, "block.gds"), "agent edit");
	writeFileSync(join(ws.work, "fix.py"), "print()");
	git(ws.work, "add", "fix.py");
	const out = run(ws, "--once");
	const head = git(ws.work, "rev-parse", "HEAD");
	assert.match(out, new RegExp(`^applied (\\S+Z) sha256:${sha("v2")} commit ${head}$`, "m"));
	assert.equal(readFileSync(join(ws.work, "block.gds"), "utf8"), "v2");
	assert.equal(git(ws.work, "log", "-1", "--format=%an <%ae> %s"), `colleague <colleague@localhost> ${MESSAGE}`);
	assert.deepEqual(git(ws.work, "show", "--name-only", "--format=", "HEAD").split("\n"), ["block.gds"]);
	assert.equal(git(ws.work, "diff", "--cached", "--name-only"), "fix.py");
	const at = Date.parse(out.match(/^applied (\S+Z)/m)[1]);
	assert.ok(Math.abs(at - Date.now()) < 10_000);
});

test("the companion acts after the fallback time without a report", (t) => {
	const ws = setup(t);
	const out = run(ws, "--once", "--started", String(Date.now() / 1000 - 500));
	assert.match(out, /^fallback \S+Z no complete report after 480 s$/m);
	assert.match(out, new RegExp(`^applied \\S+Z sha256:${sha("v2")} commit [0-9a-f]{40}$`, "m"));
});

test("the companion does nothing when a final answer.json exists", (t) => {
	for (const answer of [
		'{ "drc_clean": true, "lvs_match": true, "checks": [] }',
		'{ "drc_clean": false, "checks": [ { "check": "drc", "ran": true }, { "check": "lvs", "ran": true } ] }',
	]) {
		const ws = setup(t);
		report(ws.work, "drc/block_idac_full.lyrdb", { ago_s: 60 });
		writeFileSync(join(ws.work, "answer.json"), answer);
		assert.match(run(ws, "--once"), /^skipped: final answer\.json exists \(\S+Z\)$/m);
		assert.equal(readFileSync(join(ws.work, "block.gds"), "utf8"), "v1");
		assert.equal(git(ws.work, "rev-list", "--count", "HEAD"), "1");
	}
});

test("the companion applies over a preliminary answer.json", (t) => {
	for (const answer of ['{ "drc_clean": false, "checks": [ { "check": "drc", "ran": false } ] }', "{}", "not json"]) {
		const ws = setup(t);
		report(ws.work, "drc/block_idac_full.lyrdb", { ago_s: 60 });
		writeFileSync(join(ws.work, "answer.json"), answer);
		const out = run(ws, "--once");
		assert.match(out, new RegExp(`^applied \\S+Z sha256:${sha("v2")} commit [0-9a-f]{40} \\(preliminary answer\\.json present\\)$`, "m"));
		assert.equal(readFileSync(join(ws.work, "block.gds"), "utf8"), "v2");
		assert.equal(git(ws.work, "rev-list", "--count", "HEAD"), "2");
	}
});

test("the companion loop starts, sees the report and applies after the delay", (t) => {
	const ws = setup(t);
	report(ws.work, "drc/block_idac_full.lyrdb");
	const out = run(ws, "--delay", "1", "--fallback", "60");
	const lines = out.trim().split("\n").map((l) => l.split(" ")[0]);
	assert.deepEqual(lines, ["start", "trigger", "applied"]);
	assert.equal(readFileSync(join(ws.work, "block.gds"), "utf8"), "v2");
});

// The companion in the sandbox of run-arm.mjs (container; SIMRA_TEST_IMAGE, optional SIMRA_TEST_ENGINE podman or
// docker, default podman): the wrapper of companionCommand starts the script before a fake agent. The fake agent
// writes a complete marker database, waits, and prints the git log and the hash of block.gds.
const image = process.env.SIMRA_TEST_IMAGE;
test("the companion in the sandbox commits the new version during the run of the agent (container)", { skip: !image && "SIMRA_TEST_IMAGE is not set", timeout: 300_000 }, async (t) => {
	const { realpathSync } = await import("node:fs");
	const { containerImageId } = await import("../packages/kernel/src/environments.ts");
	const { companionCommand, companionDir, engineEnv, sandboxArgs } = await import("../evals/run-arm.mjs");
	const engine = process.env.SIMRA_TEST_ENGINE ?? "podman";
	const root = mkdtempSync(join(realpathSync(tmpdir()), "simra-companion-sandbox-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ws = join(root, "ws");
	const state = join(root, "state");
	const proxy = join(root, "proxy");
	for (const d of [ws, join(state, "home"), proxy, join(root, "task")]) mkdirSync(d, { recursive: true });
	writeFileSync(join(ws, "block.gds"), "v1");
	git(ws, "init", "-q");
	git(ws, "add", ".");
	git(ws, "commit", "-q", "-m", "design");
	const task = join(root, "task");
	writeFileSync(join(task, "companion.json"), JSON.stringify({ gds: "v2-seeded.gds", target: "block.gds", message: MESSAGE, delay_s: 1, fallback_s: 60 }));
	writeFileSync(join(task, "v2-seeded.gds"), "v2");
	const c = companionDir(task, { script: script, files: { "companion.json": "companion.json", "v2-seeded.gds": "v2-seeded.gds" } }, join(root, "companion"));
	const agent = 'mkdir -p drc && printf "<report-database>\\n</report-database>\\n" > drc/x.lyrdb && sleep 12 && git -c safe.directory="*" log --format="%an|%s" -2 && sha256sum block.gds';
	const imageId = containerImageId(engine, image);
	const args = sandboxArgs({ engine, imageId, name: `simra-test-companion-${Date.now()}`, ws, state, proxyDir: proxy, readOnly: { [c.dir]: "/companion" }, command: companionCommand(c.script, ["sh", "-c", agent]) });
	const r = spawnSync(engine, args, { env: engineEnv(), encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	const lines = r.stdout.trim().split("\n");
	assert.equal(lines[0], `colleague|${MESSAGE}`);
	assert.match(lines[1], /\|design$/);
	assert.match(r.stdout, new RegExp(`^${sha("v2")}\\s+block.gds$`, "m"));
	const log = readFileSync(join(state, "companion.log"), "utf8");
	assert.match(log, /^start \S+ target block\.gds delay_s 1 fallback_s 60$/m);
	assert.match(log, /^trigger \S+ drc\/x\.lyrdb$/m);
	assert.match(log, new RegExp(`^applied \\S+Z sha256:${sha("v2")} commit [0-9a-f]{40}$`, "m"));
});
