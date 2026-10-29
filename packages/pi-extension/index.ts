// Simra Agent extension for pi.
// It registers the tools run_experiment (kernel runner + adapters) and check_requirements (requirements.json
// against the design), and the command /simra-version.
// All logic lives in @simra-tech/kernel, which works without pi.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_ADAPTER_DIR,
	findRoot,
	formatOutcome,
	formatVerdict,
	runCheck,
	runExperiment,
	type AdapterManifest,
} from "@simra-tech/kernel";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/** One line per built-in adapter operation, for the tool description. */
function adapterCatalog(): string {
	const lines: string[] = [];
	for (const name of existsSync(BUILTIN_ADAPTER_DIR) ? readdirSync(BUILTIN_ADAPTER_DIR).sort() : []) {
		const path = join(BUILTIN_ADAPTER_DIR, name, "adapter.json");
		if (!existsSync(path)) continue;
		const manifest = JSON.parse(readFileSync(path, "utf8")) as AdapterManifest;
		for (const [op, { description }] of Object.entries(manifest.operations)) {
			lines.push(`- adapter "${manifest.name}", operation "${op}": ${description}`);
		}
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("simra-version", {
		description: "Show the Simra Agent and pi versions",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`simra-agent ${pkg.version} (pi ${PI_VERSION})`, "info");
		},
	});

	pi.registerTool({
		name: "run_experiment",
		label: "Run experiment",
		description: [
			"Run one experiment (for example one simulation) through a Simra adapter and record it.",
			"Each call writes simra/experiments/<id>/experiment.json (what was asked, adapter and environment, design git state)",
			"and result.json (execution status, measurements, hashes of every input and output file) in the design root.",
			"The call waits until the run ends. The status is the execution status only; it does not say that a requirement passed.",
			"Environments are defined in simra.config.json in the design root ('local' always exists).",
			"Available adapters:",
			adapterCatalog(),
		].join("\n"),
		promptSnippet: "run_experiment: run and record one simulation through a Simra adapter",
		promptGuidelines: [
			"Run simulations with run_experiment, not with a direct shell command, so that each run is recorded.",
			"When you report a simulated number, give the experiment id that produced it.",
		],
		parameters: Type.Object({
			adapter: Type.String({ description: 'Adapter name, for example "ngspice"' }),
			operation: Type.String({ description: 'Adapter operation, for example "simulate"' }),
			inputs: Type.Record(Type.String(), Type.Unknown(), { description: "Adapter inputs (see the adapter list)" }),
			purpose: Type.String({ description: "Why you run this experiment, in one sentence" }),
			environment: Type.Optional(Type.String({ description: 'Environment name from simra.config.json (default "local")' })),
			timeout_s: Type.Optional(Type.Number({ description: "Stop the run after this many seconds (default 3600)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			const outcome = await runExperiment({
				root,
				adapter: params.adapter,
				operation: params.operation,
				inputs: params.inputs,
				purpose: params.purpose,
				environment: params.environment,
				timeoutS: params.timeout_s,
				signal,
			});
			return {
				content: [{ type: "text", text: formatOutcome(root, outcome.experiment, outcome.result) }],
				details: { id: outcome.id, status: outcome.result.status, measurements: outcome.result.measurements },
			};
		},
	});
	pi.registerTool({
		name: "check_requirements",
		label: "Check requirements",
		description: [
			"The test runner of the design. requirements.json is its test suite: one requirement per spec row, with the spec",
			"limit and the conditions (for example corners). The file is in the design root (the nearest directory upward with",
			"simra.config.json, else the working directory). If it does not exist, write it from the spec; the error shows an example.",
			"The check runs each experiment of the file once per condition with the same runner as run_experiment, compares",
			"every measurement with its limit, and writes simra/checks/<id>/verdict.json. Each row is pass, fail, not measured",
			"or not run, with its margin and experiment id. The status is pass only when every row passes; a check of a",
			"selection is never a pass.",
		].join("\n"),
		promptSnippet: "check_requirements: run the design's test suite (requirements.json) and compare each measurement with its limit",
		promptGuidelines: [
			"Treat requirements.json like a test suite: write it from the spec before you change the design, if it does not exist.",
			"Work like test-driven development: run check_requirements, fix the failing rows, and run it again.",
			"Use the requirements and conditions parameters to check one row quickly while you work; that result is not a pass.",
			"Before you say that the design meets its requirements, run check_requirements without a selection and give its check id.",
			"Report rows that are not measured or not run as such. Do not replace them with your own estimate.",
		],
		parameters: Type.Object({
			requirements: Type.Optional(Type.Array(Type.String(), { description: "Check only these requirement ids" })),
			conditions: Type.Optional(Type.Array(Type.String(), { description: "Check only these conditions" })),
			file: Type.Optional(Type.String({ description: "Requirements file relative to the design root (default requirements.json)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			const { id, verdict } = await runCheck({
				root,
				file: params.file,
				requirements: params.requirements,
				conditions: params.conditions,
				signal,
			});
			return {
				content: [{ type: "text", text: formatVerdict(root, verdict) }],
				details: { id, status: verdict.status, counts: verdict.counts },
			};
		},
	});
}
