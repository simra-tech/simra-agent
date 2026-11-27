// Heavy jobs: one at a time on a machine. A heavy job (a place and route step, a large DRC deck, a container that
// uses most of the memory) runs only while its process holds the heavy-job lock.
//
//   <lock>/                  the lock: a directory, made with mkdir (atomic). Default ~/.simra/heavy.lock; the
//                            variable SIMRA_HEAVY_LOCK gives another path, so that all tools of a machine use one lock.
//   <lock>/owner.json        who holds it: pid, host, experiment, design root
//   <lock>.queue/<ticket>    one file per waiting job; the ticket names sort by arrival time
//
// - Only the first live ticket of the queue tries to take the lock: the jobs start in the order of arrival.
// - A lock whose owner.json names a process of this host that is gone is removed by the first ticket.
// - A lock directory without owner.json belongs to another tool (a script that made it with mkdir). It is never
//   removed: the queue waits until the directory is gone.
// - The files are plain: any tool can read the queue without this code.

import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
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
}

export interface HeavyTicket extends HeavyOwner {
	/** The file name of the ticket in the queue directory. */
	ticket: string;
}

export interface HeavyQueue {
	lock: string;
	/** null: the lock is free. "foreign": the lock directory exists without owner.json (another tool holds it). */
	holder: HeavyOwner | "foreign" | null;
	/** The waiting jobs, in the order of arrival. */
	waiting: HeavyTicket[];
}

/** The lock directory: SIMRA_HEAVY_LOCK, else ~/.simra/heavy.lock. */
export function heavyLockDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.SIMRA_HEAVY_LOCK ? resolve(env.SIMRA_HEAVY_LOCK) : join(homedir(), ".simra", "heavy.lock");
}

const queueDir = (lock: string) => `${lock}.queue`;

/** true when the process exists (also when it belongs to another user). */
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

function exists(path: string): boolean {
	try {
		readdirSync(path);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== "ENOENT";
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
			continue; // the ticket is being written, or it was removed
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
	const holder = exists(lock) ? (readOwner(lock) ?? "foreign") : null;
	return { lock, holder, waiting: tickets(lock, false) };
}

/** `experiment <id> of <root> (pid <n>)`, or the text for a lock of another tool. */
export function formatHolder(holder: HeavyQueue["holder"]): string {
	if (holder === null) return "nobody";
	if (holder === "foreign") return "another tool (the lock directory has no owner.json)";
	const what = holder.experiment ? `experiment ${holder.experiment}${holder.root ? ` of ${holder.root}` : ""}` : "a job";
	return `${what} (pid ${holder.pid} on ${holder.host}, since ${holder.since})`;
}

/** One line for the lock, then one line per waiting job. */
export function formatHeavyQueue(q: HeavyQueue): string {
	const lines = [`heavy-job lock ${q.lock}: ${q.holder === null ? "free" : `held by ${formatHolder(q.holder)}`}`];
	q.waiting.forEach((t, k) => lines.push(`  waiting ${k + 1}: ${t.experiment ? `experiment ${t.experiment}${t.root ? ` of ${t.root}` : ""}` : "a job"} (pid ${t.pid}, since ${t.since})`));
	return lines.join("\n");
}

/** Remove a lock whose owner is a process of this host that is gone. Only the first ticket of the queue calls it. */
function removeDeadLock(lock: string): void {
	const owner = readOwner(lock);
	if (!owner || !gone(owner)) return;
	// Move the directory away first, then look again: another process can have taken the lock in between.
	const aside = `${lock}.dead-${process.pid}`;
	try {
		renameSync(lock, aside);
	} catch {
		return;
	}
	const moved = readOwner(aside);
	if (moved && moved.pid === owner.pid && moved.since === owner.since) {
		rmSync(aside, { recursive: true, force: true });
		return;
	}
	try {
		renameSync(aside, lock);
	} catch {
		rmSync(aside, { recursive: true, force: true });
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
	/** The lock directory (default heavyLockDir()). */
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
	const ticket = `${String(start).padStart(15, "0")}-${process.pid}-${opts.experiment ?? "job"}.json`;
	writeJsonAtomic(join(queueDir(lock), ticket), me);
	const leave = () => rmSync(join(queueDir(lock), ticket), { force: true });
	let told: string | null = null;
	try {
		for (;;) {
			if (opts.signal?.aborted) return null;
			const first = tickets(lock, true)[0];
			if (first?.ticket === ticket) {
				removeDeadLock(lock);
				let made = false;
				try {
					mkdirSync(lock);
					made = true;
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
				}
				if (made) {
					const owner: HeavyOwner = { ...me, since: new Date().toISOString() };
					writeJsonAtomic(join(lock, "owner.json"), owner);
					let released = false;
					return {
						lock,
						waited_s: (Date.now() - start) / 1000,
						release: () => {
							if (released) return;
							released = true;
							const now = readOwner(lock);
							if (now && now.pid === owner.pid && now.host === owner.host && now.since === owner.since) rmSync(lock, { recursive: true, force: true });
						},
					};
				}
			}
			const holder = first && first.ticket !== ticket && !exists(lock) ? `the job before it in the queue (${first.experiment ?? `pid ${first.pid}`})` : formatHolder(heavyQueue(lock).holder);
			if (holder !== told) {
				told = holder;
				opts.onWait?.(holder);
			}
			await sleep(opts.pollMs ?? 1000, opts.signal);
		}
	} finally {
		leave();
	}
}

/** true when the configuration names the operation as heavy: an entry "adapter.operation" or "adapter.*". */
export function isHeavyOperation(list: string[] | undefined, adapter: string, operation: string): boolean {
	return (list ?? []).some((entry) => entry === `${adapter}.${operation}` || entry === `${adapter}.*`);
}
