// The runtime estimate of an experiment, from the records only: the shortest and the longest runtime of the earlier
// completed runs of the same kind in the design root. There is no model and no other heuristic.

import { readdirSync } from "node:fs";
import { type ExperimentRecord, experimentsDir, loadExperiment } from "./records.ts";

export interface RuntimeEstimate {
	adapter: string;
	operation: string;
	/** The input rule_set of the runs (for example a DRC rule set of the klayout adapter), or null when it is not set. */
	rule_set: string | null;
	min_s: number;
	max_s: number;
	runs: number;
}

const ruleSet = (inputs: Record<string, unknown>): string | null => (inputs.rule_set === undefined || inputs.rule_set === null ? null : String(inputs.rule_set));

/**
 * The runtimes of the earlier runs of the same kind: the same adapter, the same operation and the same input rule_set
 * (not set counts as one value), with the result status "completed", that ended before this experiment was created.
 * null when there is no such run. A record that cannot be read is not used.
 */
export function runtimeEstimate(root: string, experiment: ExperimentRecord): RuntimeEstimate | null {
	let ids: string[];
	try {
		ids = readdirSync(experimentsDir(root));
	} catch {
		return null;
	}
	const kind = ruleSet(experiment.inputs);
	const durations: number[] = [];
	for (const id of ids) {
		if (id === experiment.id) continue;
		try {
			const { experiment: e, result: r } = loadExperiment(root, id);
			if (e.adapter.name !== experiment.adapter.name || e.operation !== experiment.operation || ruleSet(e.inputs) !== kind) continue;
			if (r?.status !== "completed" || !(r.finished_at <= experiment.created_at) || !Number.isFinite(r.duration_s)) continue;
			durations.push(r.duration_s);
		} catch {}
	}
	if (durations.length === 0) return null;
	return {
		adapter: experiment.adapter.name,
		operation: experiment.operation,
		rule_set: kind,
		min_s: Math.min(...durations),
		max_s: Math.max(...durations),
		runs: durations.length,
	};
}
