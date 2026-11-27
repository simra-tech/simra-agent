// The inbox of a design root: one marker file for each detached run that ended and whose result nobody has read.
//
//   <root>/simra/inbox/<experiment id>.json
//
// The supervisor of a detached run writes the marker when the run ends. A read of the result removes it: a wait
// (waitExperiments, simra wait, wait_experiments) or simra show. A session that was idle, or a new session, finds the
// ended runs in the inbox (simra inbox; the pi extension adds them to the session).

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ExecutionStatus, type ExperimentRecord, readJson, type ResultRecord, writeJsonAtomic } from "./records.ts";

export const INBOX_SCHEMA = "simra.inbox/0";

export interface InboxMarker {
	schema: typeof INBOX_SCHEMA;
	experiment: string;
	status: ExecutionStatus;
	finished_at: string;
	adapter: string | null;
	operation: string | null;
	purpose: string | null;
	heavy: boolean;
}

export function inboxDir(root: string): string {
	return join(root, "simra", "inbox");
}

const VALID_ID = /^[\w.-]+$/;

/** Write the marker of an ended run. The experiment record can be missing (then the marker has the id and the status only). */
export function writeInboxMarker(root: string, id: string, result: Pick<ResultRecord, "status" | "finished_at">, experiment?: ExperimentRecord | null): void {
	mkdirSync(inboxDir(root), { recursive: true });
	const marker: InboxMarker = {
		schema: INBOX_SCHEMA,
		experiment: id,
		status: result.status,
		finished_at: result.finished_at,
		adapter: experiment?.adapter?.name ?? null,
		operation: experiment?.operation ?? null,
		purpose: experiment?.purpose ?? null,
		heavy: experiment?.heavy === true,
	};
	writeJsonAtomic(join(inboxDir(root), `${id}.json`), marker);
}

/** The markers of the design root, oldest end first. A file that cannot be read is not listed. */
export function readInbox(root: string): InboxMarker[] {
	let names: string[];
	try {
		names = readdirSync(inboxDir(root)).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
	const out: InboxMarker[] = [];
	for (const name of names) {
		try {
			const marker = readJson<InboxMarker>(join(inboxDir(root), name));
			if (marker.schema === INBOX_SCHEMA && typeof marker.experiment === "string") out.push(marker);
		} catch {}
	}
	return out.sort((a, b) => a.finished_at.localeCompare(b.finished_at) || a.experiment.localeCompare(b.experiment));
}

/** Remove the markers of these experiments: their results were read. It returns the ids that had a marker. */
export function ackInbox(root: string, ids: string[]): string[] {
	const done: string[] = [];
	for (const id of ids) {
		if (!VALID_ID.test(id)) continue;
		const path = join(inboxDir(root), `${id}.json`);
		if (!existsSync(path)) continue;
		rmSync(path, { force: true });
		done.push(id);
	}
	return done;
}

/** One line per ended run that nobody has read, then how to read them. An empty inbox gives one line. */
export function formatInbox(markers: InboxMarker[], read = "simra wait <id> [<id>...]"): string {
	if (markers.length === 0) return "inbox: no ended run waits for a read";
	const lines = [`inbox: ${markers.length} detached run${markers.length === 1 ? "" : "s"} ended and ${markers.length === 1 ? "its result was" : "their results were"} not read`];
	for (const m of markers) {
		const kind = m.adapter ? ` ${m.adapter}.${m.operation}` : "";
		lines.push(`  ${m.experiment}${kind}: ${m.status}, ended ${m.finished_at}${m.heavy ? ", heavy job" : ""}${m.purpose ? ` (${m.purpose})` : ""}`);
	}
	lines.push(`read: ${read}`);
	return lines.join("\n");
}
