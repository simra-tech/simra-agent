// Heavy-job lock, recovery cases: a supervisor that is killed while its adapter still runs, a process that is killed
// while it takes or gives back the lock, and several jobs that take over the lock of a dead owner at the same time.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireHeavyLock, heavyQueue, readStatus, removeContainers, type ResultRecord, runExperiment } from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const heavySource = new URL("../src/heavy.ts", import.meta.url).href;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(t: { after: (fn: () => void) => void }): { root: string; lock: string } {
	const root = mkdtempSync(join(tmpdir(), "simra-heavy-rec-"));
	const lock = join(root, "locks", "heavy.lock");
	const before = process.env.SIMRA_HEAVY_LOCK;
	process.env.SIMRA_HEAVY_LOCK = lock;
	t.after(() => {
		if (before === undefined) delete process.env.SIMRA_HEAVY_LOCK;
		else process.env.SIMRA_HEAVY_LOCK = before;
		rmSync(root, { recursive: true, force: true });
	});
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")] }));
	return { root, lock };
}

async function until(what: string, check: () => boolean, ms = 20_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timeout: ${what}`);
		await sleep(25);
	}
}

/** A process that runs a script with acquireHeavyLock in scope. */
function worker(lock: string, body: string, env: Record<string, string> = {}): ChildProcess {
	const script = `import { acquireHeavyLock } from ${JSON.stringify(heavySource)};\nconst lock = ${JSON.stringify(lock)};\n${body}`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } });
	workers.push(child);
	return child;
}
const workers: ChildProcess[] = [];
process.on("exit", () => workers.forEach((w) => w.kill("SIGKILL")));
const ended = (child: ChildProcess) => new Promise<void>((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done())));

test("a supervisor that is killed while its adapter runs keeps the lock until the adapter ends", { timeout: 90_000 }, async (t) => {
	const { root, lock } = setup(t);
	const start = (seconds: number) => runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "slow", seconds }, purpose: "recovery test", heavy: true, detached: true });
	const a = await start(4);
	await until("the adapter of the first run started", () => readStatus(root, a.id)?.status === "running" && existsSync(join(a.dir, "adapter.stdout.log")));
	await sleep(300);
	process.kill(readStatus(root, a.id)?.pid as number, "SIGKILL");
	const b = await start(0.1);
	const response = join(a.dir, "response.json");
	await until("the second run ended", () => existsSync(join(b.dir, "result.json")), 40_000);
	await until("the adapter of the first run wrote its response", () => existsSync(response), 15_000);
	const rb = JSON.parse(readFileSync(join(b.dir, "result.json"), "utf8")) as ResultRecord;
	assert.equal(rb.status, "completed");
	const firstEnded = statSync(response).mtimeMs;
	assert.ok(Date.parse(rb.started_at) >= firstEnded - 50, `the second heavy job started at ${rb.started_at}; the adapter of the first job wrote its response ${((firstEnded - Date.parse(rb.started_at)) / 1000).toFixed(2)} s later`);
	assert.equal(heavyQueue(lock).holder, null);
});

test("a process that is killed while it takes or gives back the lock does not block the queue", { timeout: 90_000 }, async (t) => {
	const { lock } = setup(t);
	t.after(() => workers.forEach((w) => w.kill("SIGKILL")));
	const loop = "for (;;) { const held = await acquireHeavyLock({ lock, experiment: 'loop', pollMs: 1 }); held.release(); }";
	const blocked: string[] = [];
	for (let round = 0; round < 40 && blocked.length === 0; round++) {
		const child = worker(lock, `process.stdout.write('go\\n');\n${loop}`);
		await new Promise((done) => child.stdout?.once("data", done));
		await sleep(5 + Math.random() * 60);
		child.kill("SIGKILL");
		await ended(child);
		if (heavyQueue(lock).holder === "foreign") {
			let inside = "a link without a target";
			try {
				inside = readdirSync(lock).join(", ") || "empty";
			} catch {}
			blocked.push(`round ${round}: the lock has no owner record (${inside})`);
		}
	}
	assert.deepEqual(blocked, []);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	const mine = await acquireHeavyLock({ lock, experiment: "next", pollMs: 10, signal: controller.signal });
	clearTimeout(timer);
	assert.ok(mine, "the next job gets the lock");
	mine.release();
	assert.equal(heavyQueue(lock).holder, null);
});

test("several jobs that take over the lock of a dead owner at the same time do not overlap", { timeout: 90_000 }, async (t) => {
	const { root, lock } = setup(t);
	t.after(() => workers.forEach((w) => w.kill("SIGKILL")));
	const marker = join(root, "inside");
	const overlap = join(root, "overlap");
	const body = `import { mkdirSync, rmdirSync, writeFileSync } from "node:fs";
const held = await acquireHeavyLock({ lock, experiment: process.env.NAME, pollMs: 2 });
try { mkdirSync(${JSON.stringify(marker)}); } catch { writeFileSync(${JSON.stringify(overlap)}, process.env.NAME); }
await new Promise((r) => setTimeout(r, 30));
try { rmdirSync(${JSON.stringify(marker)}); } catch {}
held.release();`;
	for (let round = 0; round < 8; round++) {
		const dead = worker(lock, "const held = await acquireHeavyLock({ lock, experiment: 'dead', pollMs: 2 }); process.stdout.write('held\\n'); await new Promise(() => {});");
		await new Promise((done) => dead.stdout?.once("data", done));
		dead.kill("SIGKILL");
		await ended(dead);
		const jobs = [0, 1, 2, 3].map((k) => worker(lock, body, { NAME: `job${round}-${k}` }));
		await Promise.all(jobs.map(ended));
		assert.equal(existsSync(overlap), false, `round ${round}: two jobs held the lock at the same time`);
		assert.deepEqual(jobs.map((j) => j.exitCode), [0, 0, 0, 0]);
		assert.equal(heavyQueue(lock).holder, null);
	}
});

/** A fake container engine: `ps` prints the lines of the file `containers`, or fails when the file `fail` exists; `rm` fails the same way. */
function fakeEngine(root: string): { engine: string; set: (state: "fail" | "running" | "none") => void } {
	const engine = join(root, "engine.sh");
	writeFileSync(engine, `#!/bin/sh\nd=$(dirname "$0")\n[ -f "$d/fail" ] && exit 1\n[ "$1" = ps ] && cat "$d/containers"\nexit 0\n`);
	chmodSync(engine, 0o755);
	const set = (state: "fail" | "running" | "none") => {
		rmSync(join(root, "fail"), { force: true });
		writeFileSync(join(root, "containers"), state === "running" ? "abc123\n" : "");
		if (state === "fail") writeFileSync(join(root, "fail"), "");
	};
	set("none");
	return { engine, set };
}

/** Try to take the lock for ms milliseconds. */
async function tryLock(lock: string, ms: number) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	const held = await acquireHeavyLock({ lock, experiment: "next", pollMs: 20, signal: controller.signal });
	clearTimeout(timer);
	return held;
}

test("a dead owner with a container engine that does not answer keeps the lock; an answer of no container frees it", { timeout: 60_000 }, async (t) => {
	const { root, lock } = setup(t);
	t.after(() => workers.forEach((w) => w.kill("SIGKILL")));
	const { engine, set } = fakeEngine(root);
	const dead = worker(lock, `const held = await acquireHeavyLock({ lock, experiment: 'exp1', pollMs: 2 }); held.track({ engine: ${JSON.stringify(engine)} }); process.stdout.write('held\\n'); await new Promise(() => {});`);
	await new Promise((done) => dead.stdout?.once("data", done));
	dead.kill("SIGKILL");
	await ended(dead);
	set("fail");
	assert.equal(removeContainers(engine, "exp1"), false, "a failed removal is reported");
	assert.equal(await tryLock(lock, 600), null, "the state of the container is not known: the lock stays");
	assert.match(JSON.stringify(heavyQueue(lock).holder), /exp1/);
	set("running");
	assert.equal(await tryLock(lock, 600), null, "the container runs: the lock stays");
	set("none");
	assert.equal(removeContainers(engine, "exp1"), true);
	const mine = await tryLock(lock, 5000);
	assert.ok(mine, "no container: the lock is taken over");
	mine.release();
});

test("a release that leaves the container: the lock stays with a live owner until the container is gone", { timeout: 60_000 }, async (t) => {
	const { root, lock } = setup(t);
	const { engine, set } = fakeEngine(root);
	const held = await acquireHeavyLock({ lock, experiment: "exp2", pollMs: 20 });
	assert.ok(held);
	held.track({ engine });
	set("fail");
	held.release({ jobMayRun: true });
	assert.equal(await tryLock(lock, 600), null, "the cleanup failed: the lock is not given back");
	set("none");
	const next = await tryLock(lock, 5000);
	assert.ok(next, "the container is gone: the next job takes the lock");
	next.release();
	assert.equal(heavyQueue(lock).holder, null);
});

test("a lock directory of the earlier format (a directory with owner.json) of a dead process is taken over", { timeout: 60_000 }, async (t) => {
	const { lock } = setup(t);
	mkdirSync(lock, { recursive: true });
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ schema: "simra.heavy_lock/0", pid: 2 ** 22 + 12345, host: hostname(), experiment: "old", root: null, since: "2026-01-01T00:00:00.000Z" }));
	const mine = await tryLock(lock, 5000);
	assert.ok(mine, "the lock of the dead owner is taken over");
	mine.release();
	// Negative control: a directory with a file that is not an owner record of this code is never removed.
	mkdirSync(lock, { recursive: true });
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname() }));
	assert.equal(await tryLock(lock, 600), null);
	assert.equal(existsSync(join(lock, "owner.json")), true);
});

test("a relative lock path is made absolute: the link of the lock has a target", { timeout: 60_000 }, async (t) => {
	const { root } = setup(t);
	const cwd = process.cwd();
	process.chdir(root);
	t.after(() => process.chdir(cwd));
	const mine = await acquireHeavyLock({ lock: "rel/heavy.lock", experiment: "relative", pollMs: 20 });
	assert.ok(mine);
	const holder = heavyQueue("rel/heavy.lock").holder;
	assert.equal(holder !== null && holder !== "foreign" && holder.experiment, "relative");
	assert.equal(existsSync(join(root, "rel", "heavy.lock", "owner.json")), true);
	mine.release();
	assert.equal(heavyQueue(join(root, "rel", "heavy.lock")).holder, null);
});
