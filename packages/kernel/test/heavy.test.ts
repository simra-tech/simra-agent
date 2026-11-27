// Heavy jobs: the heavy-job lock of the machine (one heavy job at a time), its queue (order of arrival, a lock of
// another tool, a lock of a process that is gone), the status "queued" of a waiting run, and the inbox of the design
// root (a marker for each detached run that ended, removed by a read of the result). On the fake adapter.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	acquireHeavyLock,
	formatHeavyQueue,
	formatInbox,
	formatWait,
	heavyLockDir,
	heavyQueue,
	isHeavyOperation,
	readInbox,
	readStatus,
	type ResultRecord,
	runExperiment,
	waitExperiments,
} from "../src/index.ts";

const fixtures = new URL("./fixtures/", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A design root and a lock path of its own. SIMRA_HEAVY_LOCK is set for this process and the supervisors that it starts. */
function setup(t: { after: (fn: () => void) => void }, config: Record<string, unknown> = {}): { root: string; lock: string } {
	const root = mkdtempSync(join(tmpdir(), "simra-heavy-"));
	const lock = join(root, "locks", "heavy.lock");
	const before = process.env.SIMRA_HEAVY_LOCK;
	process.env.SIMRA_HEAVY_LOCK = lock;
	t.after(() => {
		if (before === undefined) delete process.env.SIMRA_HEAVY_LOCK;
		else process.env.SIMRA_HEAVY_LOCK = before;
		rmSync(root, { recursive: true, force: true });
	});
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ adapter_dirs: [join(fixtures, "adapters")], ...config }));
	return { root, lock };
}
const start = (root: string, inputs: Record<string, unknown>, heavy?: boolean) =>
	runExperiment({ root, adapter: "fake", operation: "run", inputs, purpose: "heavy test", heavy, detached: true });
const result = (root: string, id: string) => JSON.parse(readFileSync(join(root, "simra/experiments", id, "result.json"), "utf8")) as ResultRecord;
async function until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timeout: ${what}`);
		await sleep(50);
	}
}

test("the lock path: SIMRA_HEAVY_LOCK, else a directory in the home folder", () => {
	assert.equal(heavyLockDir({ SIMRA_HEAVY_LOCK: "/tmp/x/heavy.lock" }), "/tmp/x/heavy.lock");
	assert.match(heavyLockDir({}), /\.simra\/heavy\.lock$/);
});

test("one holder at a time, and the waiting jobs get the lock in the order of arrival", async (t) => {
	const { lock } = setup(t);
	const first = await acquireHeavyLock({ lock, experiment: "a", pollMs: 20 });
	assert.ok(first);
	assert.equal(first.waited_s < 1, true);
	const order: string[] = [];
	const told: string[] = [];
	const second = acquireHeavyLock({ lock, experiment: "b", pollMs: 20, onWait: (h) => told.push(h) }).then((l) => (order.push("b"), l));
	await sleep(30);
	const third = acquireHeavyLock({ lock, experiment: "c", pollMs: 20 }).then((l) => (order.push("c"), l));
	await sleep(150);
	assert.deepEqual(order, [], "nobody gets the lock while the first job holds it");
	const queue = heavyQueue(lock);
	assert.equal(queue.holder !== null && queue.holder !== "foreign" && queue.holder.experiment, "a");
	assert.deepEqual(queue.waiting.map((w) => w.experiment), ["b", "c"]);
	assert.match(formatHeavyQueue(queue), /held by experiment a \(pid \d+ on .*\n {2}waiting 1: experiment b .*\n {2}waiting 2: experiment c /);
	assert.match(told[0], /^experiment a \(pid/);
	first.release();
	const b = await second;
	await sleep(150);
	assert.deepEqual(order, ["b"], "the third job waits for the second");
	b?.release();
	b?.release();
	const c = await third;
	assert.deepEqual(order, ["b", "c"]);
	c?.release();
	assert.equal(heavyQueue(lock).holder, null);
	assert.deepEqual(heavyQueue(lock).waiting, []);
});

test("a lock directory of another tool (mkdir, no owner.json) is waited for and never removed", async (t) => {
	const { lock } = setup(t);
	mkdirSync(lock, { recursive: true });
	let got = false;
	const told: string[] = [];
	const waiting = acquireHeavyLock({ lock, pollMs: 20, onWait: (h) => told.push(h) }).then((l) => ((got = true), l));
	await sleep(200);
	assert.equal(got, false);
	assert.ok(existsSync(lock));
	assert.equal(heavyQueue(lock).holder, "foreign");
	assert.match(told[0], /another tool/);
	rmSync(lock, { recursive: true });
	(await waiting)?.release();
	assert.equal(got, true);
});

test("a lock of a process of this host that is gone is taken over; an abort ends the wait", async (t) => {
	const { lock } = setup(t);
	const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
	mkdirSync(lock, { recursive: true });
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ schema: "simra.heavy_lock/0", pid: Number(dead), host: hostname(), experiment: "gone", root: null, since: "2026-01-01T00:00:00.000Z" }));
	const mine = await acquireHeavyLock({ lock, experiment: "next", pollMs: 20 });
	assert.ok(mine);
	const holder = heavyQueue(lock).holder;
	assert.equal(holder !== null && holder !== "foreign" && holder.experiment, "next");
	// A second job waits; its abort returns null and removes its ticket.
	const controller = new AbortController();
	const second = acquireHeavyLock({ lock, experiment: "late", pollMs: 20, signal: controller.signal });
	await sleep(100);
	assert.deepEqual(heavyQueue(lock).waiting.map((w) => w.experiment), ["late"]);
	controller.abort();
	assert.equal(await second, null);
	assert.deepEqual(heavyQueue(lock).waiting, []);
	mine.release();
});

test("two heavy runs do not overlap: the second is queued, then runs; both end in the inbox, and a wait takes them out", async (t) => {
	const { root, lock } = setup(t);
	// The first run is long enough for the second to start and queue on a loaded machine.
	const a = await start(root, { mode: "slow", seconds: 5 }, true);
	await until("the first run holds the lock", () => {
		const h = heavyQueue(lock).holder;
		return h !== null && h !== "foreign" && h.experiment === a.id;
	});
	const b = await start(root, { mode: "slow", seconds: 1 }, true);
	assert.equal(b.experiment.heavy, true);
	await until("the second run is queued behind the first", () => readStatus(root, b.id)?.status === "queued" && (readStatus(root, b.id)?.waiting_for ?? "").includes(a.id));
	assert.equal(existsSync(join(b.dir, "adapter.stdout.log")), false, "the adapter of the queued run did not start");
	const early = await waitExperiments(root, [b.id], { timeoutS: 0 });
	assert.match(formatWait(root, early, 0), new RegExp(`^experiment ${b.id}: still queued after 0 s: a heavy job, it waits for the heavy-job lock, held by experiment ${a.id} `));
	// The agent does not wait here: the runs end on their own, and the inbox has a marker for each.
	await until("both markers are in the inbox", () => readInbox(root).length === 2, 30_000);
	const [ra, rb] = [result(root, a.id), result(root, b.id)];
	assert.equal(ra.status, "completed");
	assert.equal(rb.status, "completed");
	assert.ok(Date.parse(rb.started_at) >= Date.parse(ra.finished_at), `the second run started at ${rb.started_at}, before the first ended at ${ra.finished_at}`);
	assert.ok((rb.queued_s ?? 0) >= 1, `queued_s is ${rb.queued_s}`);
	assert.equal(heavyQueue(lock).holder, null);
	assert.deepEqual(readInbox(root).map((m) => [m.experiment, m.status, m.heavy]), [[a.id, "completed", true], [b.id, "completed", true]]);
	assert.match(formatInbox(readInbox(root)), new RegExp(`^inbox: 2 detached runs ended and their results were not read\\n {2}${a.id} fake\\.run: completed, ended .*, heavy job \\(heavy test\\)`));
	const cliOut = spawnSync(process.execPath, [cli, "--root", root, "inbox"], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	assert.match(cliOut.stdout, new RegExp(`${b.id} fake\\.run: completed`));
	assert.match(cliOut.stdout, /heavy-job lock .*: free/);
	await waitExperiments(root, [a.id], { timeoutS: 5 });
	assert.deepEqual(readInbox(root).map((m) => m.experiment), [b.id]);
	spawnSync(process.execPath, [cli, "--root", root, "show", b.id], { encoding: "utf8", env: { ...process.env, SIMRA_NO_ANALYTICS: "1" } });
	assert.deepEqual(readInbox(root), []);
	assert.equal(formatInbox(readInbox(root)), "inbox: no ended run waits for a read");
});

test("negative control: a run that is not heavy does not wait for the lock; a blocking run leaves no marker", async (t) => {
	const { root, lock } = setup(t);
	mkdirSync(lock, { recursive: true }); // another tool holds the lock for the whole test
	const light = await start(root, { mode: "ok" });
	const [outcome] = await waitExperiments(root, [light.id], { timeoutS: 20 });
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.result?.queued_s, undefined);
	const blocking = await runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" } });
	assert.equal(blocking.result.status, "completed");
	assert.deepEqual(readInbox(root), []);
});

test("heavy_operations of the configuration makes an operation heavy; a queued run that is stopped is cancelled", async (t) => {
	assert.equal(isHeavyOperation(["librelane.replay", "klayout.*"], "klayout", "drc"), true);
	assert.equal(isHeavyOperation(["librelane.replay"], "librelane", "read"), false);
	assert.equal(isHeavyOperation(undefined, "fake", "run"), false);
	const { root, lock } = setup(t, { heavy_operations: ["fake.run"] });
	mkdirSync(lock, { recursive: true });
	const queued = await start(root, { mode: "ok" });
	assert.equal(queued.experiment.heavy, true);
	assert.equal(queued.status.status, "queued");
	await until("the supervisor waits in the queue", () => heavyQueue(lock).waiting.some((w) => w.experiment === queued.id));
	process.kill(readStatus(root, queued.id)?.pid as number, "SIGTERM");
	const [outcome] = await waitExperiments(root, [queued.id], { timeoutS: 20 });
	assert.equal(outcome.status, "cancelled");
	assert.match(outcome.result?.errors[0] ?? "", /cancelled while it waited for the heavy-job lock: the adapter did not start/);
	assert.ok(existsSync(lock), "the lock of the other tool is still there");
	assert.deepEqual(heavyQueue(lock).waiting, []);
});
