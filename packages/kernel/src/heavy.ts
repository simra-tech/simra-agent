// Heavy jobs: one at a time on a machine. A heavy job (a place and route step, a large DRC deck, a container that
// uses most of the memory) runs only while its process holds the heavy-job lock.
//
//   <lock>                   the lock. Default ~/.simra/heavy.lock; the variable SIMRA_HEAVY_LOCK gives another path,
//                            so that all tools of a machine use one lock. This code takes the lock with a symbolic
//                            link to its owner directory: the link and the owner record appear in one atomic step.
//                            Another tool can take the same lock with mkdir: both fail when the path exists.
//   <lock>/owner.json        who holds it: pid, host, experiment, design root, and the processes of the job
//   <lock>.owners/<name>/    the owner directory that the link names
//   <lock>.queue/<ticket>    one file per waiting job; the ticket names sort by arrival time
//   <lock>.takeover          a short lock for the removal of the lock of a dead owner (a link that names host and pid)
//
// - Only the first live ticket of the queue tries to take the lock: the jobs start in the order of arrival.
// - A lock is taken over when its owner is a process of this host that is gone, and the processes of its job (the
//   adapter, its process group, the container with the label of the experiment) are gone too. A supervisor that is
//   killed leaves its adapter running: the lock stays until the adapter ends.
// - A process that is killed while it takes or gives back the lock leaves no lock without an owner record.
// - A lock directory that is not a link of this code belongs to another tool (a script that made it with mkdir). It
//   is never removed: the queue waits until the directory is gone.
// - The files are plain: any tool can read the queue without this code.
// - The code needs symbolic links (Linux, macOS).

import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readJson, writeJsonAtomic } from "./records.ts";

export const HEAVY_LOCK_SCHEMA = "simra.heavy_lock/0";

export interface HeavyOwner {
	schema: typeof HEAVY_LOCK_SCHEMA;
	pid: number;
	host: string;
	experiment: string | null;
	root: string | null;
	/** Owner: when it took the lock. Ticket: when it joined the queue. */
	since: string;
	/** Owner: the processes of the job (the adapter). The lock is not taken over while one of them runs. */
	job_pids?: number[];
	/** Owner: the container engine of the job. The lock is not taken over while a container with the label of the experiment runs. */
	engine?: string;
}

export interface HeavyTicket extends HeavyOwner {
	/** The file name of the ticket in the queue directory. */
	ticket: string;
}

export interface HeavyQueue {
	lock: string;
	/** null: the lock is free. "foreign": the lock exists without an owner record (another tool holds it). */
	holder: HeavyOwner | "foreign" | null;
	/** The waiting jobs, in the order of arrival. */
	waiting: HeavyTicket[];
}

/** The lock path: SIMRA_HEAVY_LOCK, else ~/.simra/heavy.lock. */
export function heavyLockDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.SIMRA_HEAVY_LOCK ? resolve(env.SIMRA_HEAVY_LOCK) : join(homedir(), ".simra", "heavy.lock");
}

const queueDir = (lock: string) => `${lock}.queue`;
const ownersDir = (lock: string) => `${lock}.owners`;
const takeoverLink = (lock: string) => `${lock}.takeover`;

/** true when the process (or, for a negative number, a process of the group) exists, also when it belongs to another user. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A process of another host cannot be checked from here: it counts as alive. */
const gone = (o: Pick<HeavyOwner, "pid" | "host">) => o.host === hostname() && !alive(o.pid);

/** The containers that run with the label of the experiment. An engine that does not answer has none. */
function containersOf(engine: string, experiment: string): string[] {
	try {
		return execFileSync(engine, ["ps", "-q", "--filter", `label=simra.experiment=${experiment}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 })
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * What still runs of the job of an owner whose process is gone: null when nothing runs (the lock can be taken over),
 * else a text such as "its adapter (pid 123)".
 */
function leftOf(owner: HeavyOwner): string | null {
	const pids = (owner.job_pids ?? []).filter((p) => Number.isInteger(p) && p > 1 && alive(p));
	if (pids.length) return `its adapter (pid ${pids.join(", ")})`;
	// The adapter of a supervisor is in the process group of the supervisor.
	if (owner.pid > 1 && alive(-owner.pid)) return `a process of its process group ${owner.pid}`;
	if (owner.engine && owner.experiment && containersOf(owner.engine, owner.experiment).length) return `its container (${owner.engine}, label simra.experiment=${owner.experiment})`;
	return null;
}

/** "free", "link" (a lock of this code) or "other" (a directory or a file of another tool). */
function kind(lock: string): "free" | "link" | "other" {
	try {
		return lstatSync(lock).isSymbolicLink() ? "link" : "other";
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "other";
	}
}

function linkTarget(path: string): string | null {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}

function readOwner(lock: string): HeavyOwner | null {
	try {
		const owner = readJson<HeavyOwner>(join(lock, "owner.json"));
		return owner && typeof owner.pid === "number" && typeof owner.host === "string" ? owner : null;
	} catch {
		return null;
	}
}

/** The tickets of the queue in the order of arrival. With clean, the tickets of processes of this host that are gone are removed. */
function tickets(lock: string, clean: boolean): HeavyTicket[] {
	let names: string[];
	try {
		names = readdirSync(queueDir(lock)).filter((n) => n.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const out: HeavyTicket[] = [];
	for (const name of names) {
		let ticket: HeavyOwner;
		try {
			ticket = readJson<HeavyOwner>(join(queueDir(lock), name));
		} catch {
			continue; // the ticket was removed
		}
		if (gone(ticket)) {
			if (clean) rmSync(join(queueDir(lock), name), { force: true });
			continue;
		}
		out.push({ ...ticket, ticket: name });
	}
	return out;
}

/** The state of the lock and its queue. It changes nothing. */
export function heavyQueue(lock: string = heavyLockDir()): HeavyQueue {
	const holder = kind(lock) === "free" ? null : (readOwner(lock) ?? "foreign");
	return { lock, holder, waiting: tickets(lock, false) };
}

/** `experiment <id> of <root> (pid <n>)`, or the text for a lock of another tool. */
export function formatHolder(holder: HeavyQueue["holder"]): string {
	if (holder === null) return "nobody";
	if (holder === "foreign") return "another tool (the lock has no owner.json)";
	const what = holder.experiment ? `experiment ${holder.experiment}${holder.root ? ` of ${holder.root}` : ""}` : "a job";
	const left = gone(holder) ? leftOf(holder) : null;
	return `${what} (pid ${holder.pid} on ${holder.host}, since ${holder.since})${left ? `; its supervisor is gone, ${left} still runs` : ""}`;
}

/** One line for the lock, then one line per waiting job. */
export function formatHeavyQueue(q: HeavyQueue): string {
	const lines = [`heavy-job lock ${q.lock}: ${q.holder === null ? "free" : `held by ${formatHolder(q.holder)}`}`];
	q.waiting.forEach((t, k) => lines.push(`  waiting ${k + 1}: ${t.experiment ? `experiment ${t.experiment}${t.root ? ` of ${t.root}` : ""}` : "a job"} (pid ${t.pid}, since ${t.since})`));
	return lines.join("\n");
}

/** Take the short lock for a takeover. A short lock of a process of this host that is gone is removed (the next try takes it). */
function takeTakeover(lock: string): boolean {
	const link = takeoverLink(lock);
	try {
		symlinkSync(`${hostname()}:${process.pid}`, link);
		return true;
	} catch {}
	const seen = linkTarget(link);
	const m = seen?.match(/^(.*):(\d+)$/);
	if (!seen || !m || !gone({ host: m[1], pid: Number(m[2]) })) return false;
	// Move it away first, then look again: another process can have replaced it in between.
	const aside = `${link}.dead-${process.pid}`;
	try {
		renameSync(link, aside);
	} catch {
		return false;
	}
	const moved = linkTarget(aside);
	rmSync(aside, { force: true });
	if (moved !== seen && moved !== null) {
		try {
			symlinkSync(moved, link);
		} catch {}
	}
	return false;
}

/**
 * Remove a lock of this code whose owner is a process of this host that is gone, when no process of its job runs.
 * Only the first ticket of the queue calls it, and it holds the short takeover lock while it looks again and removes.
 */
function removeDeadLock(lock: string): void {
	const dead = (): string | null => {
		if (kind(lock) !== "link") return null;
		const target = linkTarget(lock);
		const owner = readOwner(lock);
		// A link without an owner record: its owner directory was removed by hand. Nobody can hold it.
		if (target !== null && owner === null) return kind(target) === "free" ? target : null;
		return target !== null && owner !== null && gone(owner) && leftOf(owner) === null ? target : null;
	};
	const target = dead();
	if (target === null || !takeTakeover(lock)) return;
	try {
		// The owner is gone, so only a takeover can change the link, and this process holds the takeover lock.
		if (dead() === target) {
			unlinkSync(lock);
			rmSync(target, { recursive: true, force: true });
		}
	} catch {
		// the next try looks again
	} finally {
		if (linkTarget(takeoverLink(lock)) === `${hostname()}:${process.pid}`) rmSync(takeoverLink(lock), { force: true });
	}
}

/** Remove the owner directories of processes of this host that are gone and that the lock does not name. */
function sweepOwners(lock: string): void {
	let names: string[];
	try {
		names = readdirSync(ownersDir(lock));
	} catch {
		return;
	}
	const current = linkTarget(lock);
	for (const name of names) {
		const dir = join(ownersDir(lock), name);
		if (dir === current) continue;
		const owner = readOwner(dir);
		const pid = Number(name.split("-")[1]);
		if (owner ? gone(owner) : Number.isInteger(pid) && pid > 1 && !alive(pid)) rmSync(dir, { recursive: true, force: true });
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((done) => {
		const end = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", end);
			done();
		};
		const timer = setTimeout(end, ms);
		signal?.addEventListener("abort", end, { once: true });
	});
}

export interface HeavyLockOptions {
	experiment?: string | null;
	root?: string | null;
	/** The lock path (default heavyLockDir()). */
	lock?: string;
	/** Abort ends the wait: the call returns null and the ticket is removed. */
	signal?: AbortSignal;
	/** The time between two tries in ms (default 1000). */
	pollMs?: number;
	/** Called when the job starts to wait and each time the holder changes, with the text of the holder. */
	onWait?: (holder: string) => void;
}

export interface HeavyLock {
	lock: string;
	/** The seconds that the call waited for the lock. */
	waited_s: number;
	/**
	 * Record a process or the container engine of the job in the owner record. When the owner process is killed, the
	 * lock is not taken over while that process, or a container with the label of the experiment, runs.
	 */
	track: (job: { pid?: number; engine?: string }) => void;
	/** Give the lock back. A second call does nothing. */
	release: () => void;
}

/**
 * Take the heavy-job lock, or wait for it in the queue. The call returns when this process holds the lock, or with
 * null when the signal aborts. The caller must call release() when the job ends.
 */
export async function acquireHeavyLock(opts: HeavyLockOptions = {}): Promise<HeavyLock | null> {
	const lock = opts.lock ?? heavyLockDir();
	const start = Date.now();
	const me: HeavyOwner = { schema: HEAVY_LOCK_SCHEMA, pid: process.pid, host: hostname(), experiment: opts.experiment ?? null, root: opts.root ?? null, since: new Date(start).toISOString() };
	mkdirSync(dirname(lock), { recursive: true });
	mkdirSync(queueDir(lock), { recursive: true });
	mkdirSync(ownersDir(lock), { recursive: true });
	sweepOwners(lock);
	const name = `${String(start).padStart(15, "0")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const ticket = `${name}-${opts.experiment ?? "job"}.json`;
	const mine = join(ownersDir(lock), name);
	writeJsonAtomic(join(queueDir(lock), ticket), me);
	const leave = () => rmSync(join(queueDir(lock), ticket), { force: true });
	let told: string | null = null;
	let held = false;
	try {
		for (;;) {
			if (opts.signal?.aborted) return null;
			const first = tickets(lock, true)[0];
			if (first?.ticket === ticket) {
				removeDeadLock(lock);
				if (kind(lock) === "free") {
					// The owner record is complete before the lock exists: the link appears with it, or not at all.
					const owner: HeavyOwner = { ...me, since: new Date().toISOString() };
					mkdirSync(mine, { recursive: true });
					writeJsonAtomic(join(mine, "owner.json"), owner);
					try {
						symlinkSync(mine, lock);
						held = true;
					} catch (e) {
						if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
					}
					if (held) {
						let released = false;
						return {
							lock,
							waited_s: (Date.now() - start) / 1000,
							track: (job) => {
								if (released) return;
								if (job.pid !== undefined && !(owner.job_pids ?? []).includes(job.pid)) owner.job_pids = [...(owner.job_pids ?? []), job.pid];
								if (job.engine) owner.engine = job.engine;
								try {
									writeJsonAtomic(join(mine, "owner.json"), owner);
								} catch {
									// the record is a help for a takeover; the job goes on
								}
							},
							release: () => {
								if (released) return;
								released = true;
								// The link goes first (one step): a process that is killed here leaves a free lock.
								if (linkTarget(lock) === mine) rmSync(lock, { force: true });
								rmSync(mine, { recursive: true, force: true });
							},
						};
					}
				}
			}
			const holder = first && first.ticket !== ticket && kind(lock) === "free" ? `the job before it in the queue (${first.experiment ?? `pid ${first.pid}`})` : formatHolder(heavyQueue(lock).holder);
			if (holder !== told) {
				told = holder;
				opts.onWait?.(holder);
			}
			await sleep(opts.pollMs ?? 1000, opts.signal);
		}
	} finally {
		leave();
		if (!held) rmSync(mine, { recursive: true, force: true });
	}
}

/** true when the configuration names the operation as heavy: an entry "adapter.operation" or "adapter.*". */
export function isHeavyOperation(list: string[] | undefined, adapter: string, operation: string): boolean {
	return (list ?? []).some((entry) => entry === `${adapter}.${operation}` || entry === `${adapter}.*`);
}
