// Short text summary of one experiment, for a terminal or for a model.
// It always names the records, so every number can be traced to its run.

import { relative } from "node:path";
import { experimentDir, type ExperimentRecord, type ResultRecord } from "./records.ts";

export function formatOutcome(root: string, experiment: ExperimentRecord, result: ResultRecord): string {
	const lines: string[] = [];
	lines.push(`experiment ${experiment.id}: ${result.status} (${result.duration_s.toFixed(1)} s)`);
	lines.push(`records: ${relative(root, experimentDir(root, experiment.id))}/{experiment,result}.json`);
	lines.push(`adapter: ${experiment.adapter.name} ${experiment.adapter.version}, operation ${experiment.operation}`);
	const env = experiment.environment as { name?: string; image_id?: string };
	lines.push(`environment: ${env.name}${env.image_id ? ` (${env.image_id.slice(0, 19)})` : ""}`);
	if (result.tool) lines.push(`tool: ${result.tool.name} ${result.tool.version}`);
	const design = experiment.design;
	lines.push(`design: git ${design.git_commit?.slice(0, 12) ?? "none"}${design.git_dirty ? " (uncommitted changes)" : ""}`);
	if (result.input_files) {
		lines.push(
			`input files: ${result.input_files.files.length} hashed${result.input_files.complete ? "" : " (INCOMPLETE: some includes were not found)"}`,
		);
		for (const f of result.input_files.files.filter((f) => f.role !== "model")) {
			lines.push(`  ${f.role ?? "file"} ${f.path} sha256:${f.sha256.slice(0, 12)}`);
		}
	}
	const names = Object.keys(result.measurements);
	if (names.length) {
		lines.push("measurements:");
		for (const name of names) {
			const m = result.measurements[name];
			const value = m.status === "measured" ? `${m.value}${m.unit ? ` ${m.unit}` : ""}` : m.status.toUpperCase();
			lines.push(`  ${name} = ${value}`);
		}
	}
	for (const d of result.diagnostics.filter((d) => d.severity !== "info")) {
		lines.push(`${d.severity}: ${d.message}`);
	}
	for (const e of result.errors) lines.push(`error: ${e}`);
	return lines.join("\n");
}
