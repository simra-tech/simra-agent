#!/usr/bin/env node
// simra: plain command line for the kernel. It does not need pi.
//
//   simra run <spec.json>     run one experiment; spec = { adapter, operation, inputs, environment?, purpose?, timeout_s? }
//   simra run --detach <spec.json>
//                             start the experiment in a supervisor process, print its id and return at once
//   simra wait <id> [<id>...] [--timeout-s <n>]
//                             wait until the experiments end (default timeout 3600 s); print one summary per id, or
//                             "still running" for a run that did not end. Exit code 0 only when every run completed.
//   simra show <id> [--json]  print the summary of the experiment (with a STALE line for each input file that changed
//                             after the run); with --json, the experiment and result records
//   simra record [<path>...]  print the design record: each file of record, its hash, and the checks that ran on it
//                             (current or stale). Paths are relative to the current directory.
//   simra list                list experiments, oldest first
//   simra check               check requirements.json; options --file <path>, --only <id,...>, --conditions <name,...>,
//                             --parallel <n> (experiments at the same time, default 4)
//
// Option: --root <dir> (default: the nearest directory upward with simra.config.json, else the current directory)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRoot } from "./config.ts";
import { runCheck } from "./requirements.ts";
import { runtimeEstimate } from "./estimate.ts";
import { designRecord, formatDesignRecord } from "./record.ts";
import { listExperiments, loadExperiment, readStatus } from "./records.ts";
import { runDetachedWorker, runExperiment } from "./runner.ts";
import { formatOutcome, formatStarted, formatVerdict, formatWait } from "./summary.ts";
import { waitExperiments } from "./wait.ts";

function usage(): never {
	console.error(
		"usage: simra run [--detach] <spec.json> | simra wait <id> [<id>...] [--timeout-s <n>] | simra show <id> [--json] | simra record [<path>...] | simra list | simra check [--file <path>] [--only <id,...>] [--conditions <name,...>] [--parallel <n>]   [--root <dir>]",
	);
	process.exit(2);
}

async function main(argv: string[]): Promise<number> {
	let root: string | null = null;
	const args: string[] = [];
	const options: Record<string, string> = {};
	let detach = false;
	let json = false;
	const list = (value?: string) => value?.split(",").filter(Boolean);
	const positive = (value: string) => (/^[1-9]\d*$/.test(value) ? Number(value) : usage());
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root") root = resolve(argv[++i] ?? usage());
		else if (argv[i] === "--detach") detach = true;
		else if (argv[i] === "--json") json = true;
		else if (argv[i] === "--detached-worker") {
			// Internal: the supervisor of a detached run (see runExperiment). The argument is the experiment directory.
			const result = await runDetachedWorker(argv[++i] ?? usage());
			return result.status === "completed" ? 0 : 1;
		} else if (["--file", "--only", "--conditions", "--parallel", "--timeout-s"].includes(argv[i])) options[argv[i].slice(2)] = argv[++i] ?? usage();
		else args.push(argv[i]);
	}
	root ??= findRoot(process.cwd()) ?? process.cwd();
	const [command, arg] = args;

	if (command === "run" && arg) {
		const spec = JSON.parse(readFileSync(arg, "utf8"));
		const opts = {
			root,
			adapter: spec.adapter,
			operation: spec.operation,
			inputs: spec.inputs ?? {},
			environment: spec.environment,
			purpose: spec.purpose,
			timeoutS: spec.timeout_s,
		};
		if (detach) {
			const started = await runExperiment({ ...opts, detached: true });
			console.log(`${formatStarted(root, started.experiment, started.estimate)}\nwait: simra wait ${started.id}`);
			return 0;
		}
		const outcome = await runExperiment(opts);
		console.log(formatOutcome(root, outcome.experiment, outcome.result, outcome.estimate));
		return outcome.result.status === "completed" ? 0 : 1;
	}
	if (command === "wait" && arg) {
		const timeoutS = options["timeout-s"] === undefined ? undefined : /^\d+$/.test(options["timeout-s"]) ? Number(options["timeout-s"]) : usage();
		const start = Date.now();
		const outcomes = await waitExperiments(root, args.slice(1), { timeoutS });
		const r = root;
		console.log(formatWait(r, outcomes, (Date.now() - start) / 1000, (e) => runtimeEstimate(r, e)));
		return outcomes.every((o) => o.status === "completed") ? 0 : 1;
	}
	if (command === "show" && arg) {
		const { experiment, result } = loadExperiment(root, arg);
		if (json) console.log(JSON.stringify({ experiment, result }, null, 2));
		else if (result) console.log(formatOutcome(root, experiment, result, runtimeEstimate(root, experiment)));
		else console.log(formatStarted(root, experiment, runtimeEstimate(root, experiment)).replace(": running (detached)", `: ${readStatus(root, arg)?.status ?? "no result"}`));
		return 0;
	}
	if (command === "record") {
		const r = root;
		console.log(formatDesignRecord(designRecord(r, args.slice(1).map((p) => resolve(p)))));
		return 0;
	}
	if (command === "check") {
		const { verdict } = await runCheck({
			root,
			file: options.file,
			requirements: list(options.only),
			conditions: list(options.conditions),
			parallel: options.parallel === undefined ? undefined : positive(options.parallel),
		});
		console.log(formatVerdict(root, verdict));
		return verdict.status === "pass" ? 0 : 1;
	}
	if (command === "list") {
		for (const { id, experiment, result } of listExperiments(root)) {
			console.log(`${id}  ${result?.status ?? readStatus(root, id)?.status ?? "no result"}  ${experiment.adapter.name}.${experiment.operation}  ${experiment.purpose ?? ""}`);
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
