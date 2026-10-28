// Simra Agent extension for pi.
// It registers the tool run_experiment (kernel runner + adapters) and the command /simra-version.
// All logic lives in @simra-tech/kernel, which works without pi.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { BUILTIN_ADAPTER_DIR, findRoot, formatOutcome, runExperiment, type AdapterManifest } from "@simra-tech/kernel";

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
}
