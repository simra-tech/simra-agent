#!/usr/bin/env node
// simra: plain command line for the kernel. It does not need pi.
//
//   simra run <spec.json>     run one experiment; spec = { adapter, operation, inputs, environment?, purpose?, timeout_s? }
//   simra show <id>           print the experiment and result records
//   simra list                list experiments, oldest first
//
// Option: --root <dir> (default: the nearest directory upward with simra.config.json, else the current directory)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRoot } from "./config.ts";
import { listExperiments, loadExperiment } from "./records.ts";
import { runExperiment } from "./runner.ts";
import { formatOutcome } from "./summary.ts";

function usage(): never {
	console.error("usage: simra run <spec.json> | simra show <id> | simra list   [--root <dir>]");
	process.exit(2);
}

async function main(argv: string[]): Promise<number> {
	let root: string | null = null;
	const args: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root") root = resolve(argv[++i] ?? usage());
		else args.push(argv[i]);
	}
	root ??= findRoot(process.cwd()) ?? process.cwd();
	const [command, arg] = args;

	if (command === "run" && arg) {
		const spec = JSON.parse(readFileSync(arg, "utf8"));
		const outcome = await runExperiment({
			root,
			adapter: spec.adapter,
			operation: spec.operation,
			inputs: spec.inputs ?? {},
			environment: spec.environment,
			purpose: spec.purpose,
			timeoutS: spec.timeout_s,
		});
		console.log(formatOutcome(root, outcome.experiment, outcome.result));
		return outcome.result.status === "completed" ? 0 : 1;
	}
	if (command === "show" && arg) {
		const { experiment, result } = loadExperiment(root, arg);
		console.log(JSON.stringify({ experiment, result }, null, 2));
		return 0;
	}
	if (command === "list") {
		for (const { id, experiment, result } of listExperiments(root)) {
			console.log(`${id}  ${result?.status ?? "no result"}  ${experiment.adapter.name}.${experiment.operation}  ${experiment.purpose ?? ""}`);
		}
		return 0;
	}
	usage();
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(e) => {
		console.error(`simra: ${(e as Error).message}`);
		process.exit(1);
	},
);
