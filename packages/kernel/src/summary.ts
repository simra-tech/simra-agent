// Short text summary of one experiment, for a terminal or for a model.
// It always names the records, so every number can be traced to its run.

import { join, relative } from "node:path";
import { experimentDir, type ExperimentRecord, type ResultRecord } from "./records.ts";
import { checksDir, type Limit, NOT_SELECTED, type VerdictRecord, type VerdictRow } from "./requirements.ts";

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
	for (const d of result.diagnostics.filter((d) => d.severity !== "info")) lines.push(formatDiagnostic(d));
	for (const e of result.errors) lines.push(`error: ${e}`);
	return lines.join("\n");
}

const num = (x: number) => Number(x.toPrecision(4)).toString();
const limitText = (op: VerdictRow["op"], limit: Limit) =>
	op === "between" ? `${num((limit as [number, number])[0])}..${num((limit as [number, number])[1])}` : `${op} ${num(limit as number)}`;

/** One line per row, failures first, so that the model sees what to fix before what already passes. */
export function formatVerdict(root: string, verdict: VerdictRecord): string {
	const c = verdict.counts;
	const lines: string[] = [];
	lines.push(
		`check ${verdict.id}: ${verdict.status.toUpperCase()} (${c.pass} pass, ${c.fail} fail, ${c.not_measured} not measured, ${c.not_run} not run; ${verdict.experiments.length} experiment${verdict.experiments.length === 1 ? "" : "s"})`,
	);
	lines.push(`record: ${relative(root, join(checksDir(root), verdict.id))}/verdict.json`);
	if (verdict.status === "incomplete") lines.push("Not every row passed or ran, so this check does not show that the design meets its requirements.");
	const order: Record<VerdictRow["status"], number> = { fail: 0, not_measured: 1, not_run: 2, pass: 3 };
	const rows = verdict.rows.filter((r) => r.reason !== NOT_SELECTED).sort((a, b) => order[a.status] - order[b.status]);
	for (const r of rows) {
		const unit = r.unit ? ` ${r.unit}` : "";
		const value = r.value === null ? "-" : `${num(r.value)}${unit}`;
		const margin = r.margin_rel === null ? (r.margin === null ? "" : ` margin ${num(r.margin)}${unit}`) : ` margin ${(r.margin_rel * 100).toFixed(1)}%`;
		const source = r.experiment ? ` [${r.experiment}]` : "";
		const reason = r.reason ? ` (${r.reason})` : "";
		lines.push(`  ${r.status.toUpperCase().padEnd(12)} ${r.requirement} @ ${r.condition}: ${value}, limit ${limitText(r.op, r.limit)}${margin}${source}${reason}`);
	}
	const unselected = verdict.rows.length - rows.length;
	if (unselected) lines.push(`  NOT_RUN      ${unselected} more row${unselected === 1 ? "" : "s"}: ${NOT_SELECTED} (listed in verdict.json)`);
	return lines.join("\n");
}

/** One diagnostic line: the severity, the file and line when the adapter gives them, and the message. */
export function formatDiagnostic(d: ResultRecord["diagnostics"][number]): string {
	return d.source && d.source !== "adapter" ? `${d.severity} (${d.source}): ${d.message}` : `${d.severity}: ${d.message}`;
}
