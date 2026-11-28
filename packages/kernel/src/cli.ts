#!/usr/bin/env node
// simra: plain command line for the kernel. It does not need pi.
//
//   simra run <spec.json>     run one experiment; spec = { adapter, operation, inputs, environment?, purpose?, timeout_s?,
//                             pass_rule?, heavy?, decisions? }. pass_rule = { text | file, id? }: the rule that decides pass or fail,
//                             recorded before the run. heavy: true makes the run wait for the heavy-job lock of the machine.
//                             decisions: the ids of the decisions that the run rests on; the run does not start when one
//                             of them is a class A decision that waits for the owner.
//   simra run --detach <spec.json>
//                             start the experiment in a supervisor process, print its id and return at once
//   simra wait <id> [<id>...] [--timeout-s <n>]
//                             wait until the experiments end (default timeout 3600 s); print one summary per id, or
//                             "still running" for a run that did not end. Exit code 0 only when every run completed.
//   simra jobs <jobs.json> [--cpus <list>] [--parallel <n>] [--timeout-s <n>]
//                             run N jobs and wait: jobs.json is a list of run specs (each may have timeout_s, the
//                             watchdog of the job). The CPU pool is split into one slot per job at a time. Print one
//                             line per job (status, exit code, runtime, logs). Exit code 0 only when every job completed.
//   simra inbox               the detached runs that ended and whose result nobody has read, and the heavy-job lock with
//                             its queue. A wait or a show of a run takes it out of the inbox.
//   simra decide <decision.json>
//                             record a decision; decision.json = { class, statement, alternative, why, reverse, evidence?,
//                             affects?, decided_by? }. Class A (scope, cost, schedule, an external claim or a number for a
//                             third party) waits for the owner: exit code 3. Class B (a technical direction that is costly
//                             to reverse) and class C (routine): exit code 0.
//   simra decision list [--class <A,B,C>] [--status <status>] [--since <time>]
//   simra decision show <id>  one decision with the results that rest on it (the id, or the start or end of the id)
//   simra decision answer <id> confirmed|changed|reversed --by <name> [--note <text>] [--statement <text>]
//                             the answer of the owner; changed needs --statement. A changed or reversed decision marks
//                             the results that depended on it.
//   simra digest [--since <time>] [--json]
//                             the owner digest since a time (default 24h; an ISO time, or 90m, 24h, 3d, 2w): the class A
//                             and B decisions, the results whose pass rule failed or changed, the checks that did not run
//   simra show <id> [--json]  print the summary of the experiment (with a STALE line for each input file that changed
//                             after the run); with --json, the experiment and result records
//   simra record [<path>...]  print the design record: each file of record, its hash, and the checks that ran on it
//                             (current or stale). Paths are relative to the current directory.
//   simra list                list experiments, oldest first
//   simra check               check requirements.json; options --file <path>, --only <id,...>, --conditions <name,...>,
//                             --parallel <n> (experiments at the same time, default 4)
//   simra assumptions [<id>] [--file <path>]
//                             list each assumption of requirements.json (or the one given), the requirements that depend
//                             on it, and the rows of the newest check that depend on it
//   simra probe --pdk <name> [--environment <env>] [--cpus <list>] [--json]
//                             device-class probe: one small deck per device class of the technology pack in ngspice and
//                             in Xyce (two jobs); print the table class x simulator (simulates, parses, fails, not run)
//   simra em <inputs.json> [--environment <env>] [--cpus <list>] [--parallel <n>] [--timeout-s <n>]
//                             EM S-parameters with openEMS: one job per port (inputs of the operation simulate), then
//                             the merge to a Touchstone file; --timeout-s is the wall time of each port job
//   simra connections --table <file> [--block <name> --interface <file>]
//                             check a connection table (bias needs without a provider, undefined controls), and with
//                             --block the block interface record against it (pins, supplies, bias values, encodings)
//   simra snp-diff <a.sNp> <b.sNp> [--band <lo,hi>]
//                             the largest difference per S_ij in dB, degrees and |dS| at the common frequencies
//   simra workarounds [--simulator <name>] [--pdk <name>]
//                             the known gaps of the simulators (all, or one) with the PDK-independent ones, and the
//                             stated workaround of each (registry workarounds/<simulator>/<pdk>.json)
//   simra pdf <file>          print the text of a PDF with a [page N] marker before each page; option --pages <a-b>,
//                             or --render <N> (render page N to a PNG in the cache and print its path)
//   simra pack init --pdk <name> [--adapter <name>] [--pdk-root <dir>] [--dir <technology dir>] [--inputs <json>]
//                             [--write]
//                             run the adapter operation pack_propose, print its report and open questions; with
//                             --write (or a yes in a terminal), write the pack to <dir>/<pdk>/technology.json
//   simra pack check --pdk <name> [--adapter <name>] [--inputs <json>]
//                             run the adapter operation pack_check on the pack; print pass, fail or not run per item
//
// Option: --root <dir> (default: the nearest directory upward with simra.config.json, else the current directory)

import { getAnalyticsConsent, setAnalyticsConsent, telemetry } from "./telemetry.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRoot } from "./config.ts";
import { createInterface } from "node:readline/promises";
import { formatPackCheck, formatPackInit, packCheck, packInit, writeProposed } from "./packs.ts";
import { extractPdf, pdfPages, renderPage } from "./pdf.ts";
import { probeDevices } from "./probe.ts";
import { compareTouchstone, emSParameters, formatSnpDiff } from "./em.ts";
import { formatWorkarounds, workaroundsFor } from "./workarounds.ts";
import { checkTable, connectionGate, formatConnectionRows, loadConnectionTable } from "./connections.ts";
import { formatJobs, runJobs } from "./jobs.ts";
import { formatHeavyQueue, formatHolder, heavyQueue } from "./heavy.ts";
import { ackInbox, formatDecisionInbox, formatInbox, readInbox } from "./inbox.ts";
import { ackAnswers, answerDecision, DECISION_CLASSES, decisionInbox, findDecision, formatDecision, formatDecisionList, formatRecorded, OWNER_ANSWERS, type OwnerAnswer, readDecisions, recordDecision, waitsForOwner } from "./decisions.ts";
import { buildDigest, formatDigest, parseSince } from "./digest.ts";
import { assumptionUses, latestVerdict, loadRequirements, runCheck } from "./requirements.ts";
import { runtimeEstimate } from "./estimate.ts";
import { designRecord, formatDesignRecord } from "./record.ts";
import { listExperiments, loadExperiment, readStatus } from "./records.ts";
import { runDetachedWorker, runExperiment, sha256File } from "./runner.ts";
import { formatAssumptionUses, formatOutcome, formatStarted, formatVerdict, formatWait } from "./summary.ts";
import { waitExperiments } from "./wait.ts";
import { formatQuery, queryRecords } from "./query.ts";

class CliUsageError extends Error {}

function usage(): never {
	console.error(
		"usage: simra run [--detach] <spec.json> | simra jobs <jobs.json> [--cpus <list>] [--parallel <n>] [--timeout-s <n>] | simra wait <id> [<id>...] [--timeout-s <n>] | simra inbox | simra decide <decision.json> | simra decision list [--class <A,B,C>] [--status <status>] [--since <time>] | simra decision show <id> | simra decision answer <id> confirmed|changed|reversed --by <name> [--note <text>] [--statement <text>] | simra digest [--since <time>] [--json] | simra show <id> [--json] | simra record [<path>...] | simra probe --pdk <name> [--environment <env>] [--cpus <list>] [--json] | simra em <inputs.json> [--environment <env>] [--cpus <list>] [--parallel <n>] [--timeout-s <n>] | simra workarounds [--simulator <name>] [--pdk <name>] | simra query [--source experiments|checks] [--check <id|latest>] [--experiment <id or text>] [--condition <name>] [--measurement <text or /re/>] [--requirement <text>] [--status <s>] [--operation <op>] [--limit <n>] | simra snp-diff <a.sNp> <b.sNp> [--band <lo,hi>] | simra connections --table <file> [--block <name> --interface <file>] | simra list | simra assumptions [<id>] [--file <path>] | simra check [--file <path>] [--only <id,...>] [--conditions <name,...>] [--parallel <n>] | simra pdf <file> [--pages <a-b> | --render <N>] | simra pack init --pdk <name> [--adapter <name>] [--pdk-root <dir>] [--dir <dir>] [--inputs <json>] [--write] | simra pack check --pdk <name> [--adapter <name>] [--inputs <json>] | simra analytics <on|off|status>   [--root <dir>]",
	);
	throw new CliUsageError();
}

/** The options that take a value, and the options that take none. */
const VALUE_OPTIONS = ["--cpus", "--environment", "--file", "--only", "--conditions", "--parallel", "--timeout-s", "--pages", "--render", "--pdk", "--simulator", "--band", "--table", "--block", "--interface", "--adapter", "--pdk-root", "--dir", "--inputs", "--source", "--check", "--experiment", "--condition", "--measurement", "--requirement", "--status", "--operation", "--limit", "--since", "--by", "--note", "--statement", "--class"];
const FLAG_OPTIONS = ["--root", "--detach", "--json", "--write", "--detached-worker"];

async function main(argv: string[]): Promise<number> {
	let root: string | null = null;
	const args: string[] = [];
	const options: Record<string, string> = {};
	let detach = false;
	let json = false;
	let write = false;
	const list = (value?: string) => value?.split(",").filter(Boolean);
	const positive = (value: string) => (/^[1-9]\d*$/.test(value) ? Number(value) : usage());
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root") root = resolve(argv[++i] ?? usage());
		else if (argv[i] === "--detach") detach = true;
		else if (argv[i] === "--json") json = true;
		else if (argv[i] === "--write") write = true;
		else if (argv[i] === "--detached-worker") {
			// Internal: the supervisor of a detached run (see runExperiment). The argument is the experiment directory.
			const result = await runDetachedWorker(argv[++i] ?? usage());
			return result.status === "completed" ? 0 : 1;
		} else if (VALUE_OPTIONS.includes(argv[i])) {
			const name = argv[i];
			const value = argv[++i];
			// The next word is another option: the value is missing. It must not become the value (for example the name of who answers).
			if (value === undefined) usage();
			if (VALUE_OPTIONS.includes(value) || FLAG_OPTIONS.includes(value)) throw new Error(`the option ${name} needs a value`);
			options[name.slice(2)] = value;
		} else args.push(argv[i]);
	}
	root ??= findRoot(process.cwd()) ?? process.cwd();
	const [command, arg] = args;
	cliCommand = command;
	if (command === "analytics") {
		if (args.length !== 2 || !["on", "off", "status"].includes(arg)) usage();
		if (arg !== "status") setAnalyticsConsent(arg === "on");
		const consent = getAnalyticsConsent();
		console.log(`Analytics preference: ${consent === undefined ? "unset (off by default)" : consent ? "on" : "off"}.`);
		console.log(`Analytics active: ${telemetry.enabled() ? "yes" : "no"}. Requires opt-in and PostHog settings; environment opt-outs take precedence.`);
		return 0;
	}
	if (!internal) telemetry.capture("cli_started", { command, headless: !process.stdin.isTTY || !process.stdout.isTTY });

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
			passRule: spec.pass_rule,
			heavy: spec.heavy,
			decisions: spec.decisions,
		};
		if (detach) {
			const started = await runExperiment({ ...opts, detached: true });
			console.log(`${formatStarted(root, started.experiment, started.estimate, started.status.status === "queued" ? (started.status.waiting_for ?? "nobody") : null)}\nwait: simra wait ${started.id}`);
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
	if (command === "jobs" && arg) {
		const file = JSON.parse(readFileSync(arg, "utf8"));
		const jobs = Array.isArray(file) ? file : file.jobs;
		if (!Array.isArray(jobs)) throw new Error(`${arg}: expected a list of jobs, or {"jobs": [...]}`);
		const outcome = await runJobs({
			root,
			jobs,
			cpus: options.cpus,
			parallel: options.parallel === undefined ? undefined : positive(options.parallel),
			waitTimeoutS: options["timeout-s"] === undefined ? undefined : positive(options["timeout-s"]),
			onEvent: ({ kind, job }) => console.error(`${kind} job ${job.index}${job.id ? ` (${job.id})` : ""}: ${job.status}`),
		});
		console.log(formatJobs(outcome));
		return outcome.jobs.every((o) => o.status === "completed") ? 0 : 1;
	}
	if (command === "inbox") {
		const decisions = formatDecisionInbox(decisionInbox(root));
		console.log(`${formatInbox(readInbox(root))}\n${decisions ? `${decisions}\n` : ""}${formatHeavyQueue(heavyQueue())}`);
		return 0;
	}
	if (command === "decide" && arg) {
		const decision = recordDecision(root, JSON.parse(readFileSync(arg, "utf8")));
		console.log(formatRecorded(root, decision));
		// Class A waits for the owner: the exit code stops a command chain that would continue.
		return waitsForOwner(decision) ? 3 : 0;
	}
	if (command === "decision" && arg === "list") {
		const classes = list(options.class)?.map((c) => c.toUpperCase());
		for (const c of classes ?? []) if (!(DECISION_CLASSES as string[]).includes(c)) throw new Error(`class "${c}": the classes are A, B and C`);
		const since = options.since === undefined ? null : parseSince(options.since);
		const status = options.status === "waiting" ? "waiting for owner" : options.status;
		const { decisions: all, unreadable } = readDecisions(root);
		const found = all.filter((d) => (!classes || classes.includes(d.class)) && (status === undefined || d.status === status) && (!since || Date.parse(d.created_at) >= since.getTime() || d.answers.some((a) => Date.parse(a.at) >= since.getTime())));
		console.log(formatDecisionList(found));
		// A record that cannot be read is named: it can be a decision that waits.
		for (const file of unreadable) console.log(`DECISION RECORD NOT READ: ${file} cannot be read.`);
		return 0;
	}
	if (command === "decision" && arg === "show") {
		const decision = findDecision(root, args[2] ?? usage());
		console.log(formatDecision(root, decision));
		// The answer that is printed is read: it leaves the inbox. A newer answer stays.
		ackAnswers(root, [decision]);
		return 0;
	}
	if (command === "decision" && arg === "answer") {
		const answer = args[3] ?? usage();
		if (!(OWNER_ANSWERS as string[]).includes(answer)) usage();
		if (options.by === undefined) throw new Error("decision answer: give who answers with --by <name>");
		const decision = answerDecision(root, args[2] ?? usage(), { answer: answer as OwnerAnswer, by: options.by, via: "cli", terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY), note: options.note, statement: options.statement });
		console.log(formatDecision(root, decision));
		return 0;
	}
	if (command === "digest") {
		const digest = buildDigest(root, parseSince(options.since ?? "24h"));
		console.log(json ? JSON.stringify(digest, null, 2) : formatDigest(digest));
		return 0;
	}
	if (command === "show" && arg) {
		const { experiment, result } = loadExperiment(root, arg);
		if (result) ackInbox(root, [arg]);
		if (json) console.log(JSON.stringify({ experiment, result }, null, 2));
		else if (result) console.log(formatOutcome(root, experiment, result, runtimeEstimate(root, experiment)));
		else {
			const status = readStatus(root, arg);
			const state = status?.status === "queued" ? `queued (a heavy job: it waits for the heavy-job lock, held by ${status.waiting_for ?? formatHolder(heavyQueue().holder)})` : (status?.status ?? "no result");
			console.log(formatStarted(root, experiment, runtimeEstimate(root, experiment)).replace(": running (detached)", `: ${state}`));
		}
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
	if (command === "assumptions") {
		const { file, path } = loadRequirements(root, options.file);
		if (arg !== undefined && !file.assumptions?.[arg]) throw new Error(`assumption "${arg}" is not defined in ${path}`);
		const verdict = latestVerdict(root);
		const current = verdict && verdict.requirements_file.sha256 === sha256File(path) ? verdict : null;
		console.log(formatAssumptionUses(assumptionUses(file, arg), current));
		if (verdict && !current) console.log(`the newest check ${verdict.id} used another version of the requirements file: its rows are not listed`);
		return 0;
	}
	if (command === "probe") {
		const { table, jobs, text } = await probeDevices({ root, pdk: options.pdk ?? usage(), environment: options.environment, cpus: options.cpus });
		console.log(json ? JSON.stringify(table, null, 2) : text);
		return jobs.every((j) => j.status === "completed") ? 0 : 1;
	}
	if (command === "snp-diff" && arg) {
		const other = args[2] ?? usage();
		const band = options.band === undefined ? undefined : (options.band.split(",").map(Number) as [number, number]);
		if (band && (band.length !== 2 || band.some((x) => !Number.isFinite(x)))) usage();
		console.log(formatSnpDiff(compareTouchstone(arg, other, band)));
		return 0;
	}
	if (command === "connections") {
		const table = options.table ?? usage();
		if ((options.block === undefined) !== (options.interface === undefined)) usage();
		const rows = options.block
			? connectionGate(root, table, options.block, options.interface as string)
			: checkTable(loadConnectionTable(resolve(root, table)));
		console.log(formatConnectionRows(rows));
		return rows.every((r) => r.status === "pass") ? 0 : 1;
	}
	if (command === "query") {
		const q = queryRecords(root, {
			source: options.source as "experiments" | "checks" | undefined,
			check: options.check,
			experiment: options.experiment,
			condition: options.condition,
			measurement: options.measurement,
			requirement: options.requirement,
			status: options.status,
			operation: options.operation,
			limit: options.limit === undefined ? undefined : positive(options.limit),
		});
		console.log(formatQuery(q));
		return 0;
	}
	if (command === "workarounds") {
		console.log(formatWorkarounds(workaroundsFor({ simulators: options.simulator ? [options.simulator] : undefined, pdk: options.pdk ?? null })));
		return 0;
	}
	if (command === "em" && arg) {
		const out = await emSParameters({
			root,
			inputs: JSON.parse(readFileSync(arg, "utf8")),
			environment: options.environment,
			cpus: options.cpus,
			parallel: options.parallel === undefined ? undefined : positive(options.parallel),
			timeoutS: options["timeout-s"] === undefined ? undefined : positive(options["timeout-s"]),
		});
		console.log(out.text);
		return out.touchstone ? 0 : 1;
	}
	if (command === "pdf" && arg) {
		const range = options.pages === undefined ? [] : (options.pages.match(/^(\d+)(?:-(\d+))?$/) ?? usage()).slice(1).filter(Boolean).map(Number);
		if (options.pages !== undefined && options.render !== undefined) usage();
		const page = options.render === undefined ? undefined : positive(options.render);
		if (page === undefined) process.stdout.write(pdfPages(await extractPdf(arg), range[0], range[1] ?? range[0]));
		else console.log(await renderPage(arg, page));
		return 0;
	}
	if (command === "pack" && (arg === "init" || arg === "check")) {
		const pdk = options.pdk ?? usage();
		const inputs = options.inputs === undefined ? {} : JSON.parse(options.inputs);
		if (arg === "check") {
			const outcome = await packCheck({ root, adapter: options.adapter, pdk, inputs });
			console.log(formatPackCheck(outcome));
			return outcome.run.result.status === "completed" ? 0 : 1;
		}
		const base = { root, adapter: options.adapter, pdk, pdkRoot: options["pdk-root"], dir: options.dir, inputs };
		let outcome = await packInit({ ...base, write });
		console.log(formatPackInit(outcome));
		if (!write && outcome.pack && process.stdin.isTTY && process.stdout.isTTY) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			const answer = await rl.question(`write the pack to ${outcome.target}? [y/N] `);
			rl.close();
			if (/^y(es)?$/i.test(answer.trim())) {
				// The proposal of this run is written; the adapter does not run again.
				outcome = { ...outcome, ...writeProposed(outcome) };
				console.log(`wrote ${outcome.target}`);
				if (outcome.outsideConfig) console.log(`add ${resolve(outcome.target, "..", "..")} to technology_dirs of simra.config.json or simra.local.json`);
			}
		}
		return outcome.pack ? 0 : 1;
	}
	if (command === "list") {
		for (const { id, experiment, result } of listExperiments(root)) {
			console.log(`${id}  ${result?.status ?? readStatus(root, id)?.status ?? "no result"}  ${experiment.adapter.name}.${experiment.operation}  ${experiment.purpose ?? ""}`);
		}
		return 0;
	}
	usage();
}

let cliCommand: string | undefined;
const internal = process.argv.includes("--detached-worker");
const started = Date.now();
async function finish(code: number): Promise<never> {
	if (!internal && cliCommand !== "analytics") telemetry.capture("cli_completed", { command: cliCommand, duration_ms: Date.now() - started, exit_code: code });
	await telemetry.shutdown();
	process.exit(code);
}
main(process.argv.slice(2)).then(
	(code) => finish(code),
	(e) => {
		if (!(e instanceof CliUsageError)) console.error(`simra: ${(e as Error).message}`);
		return finish(e instanceof CliUsageError ? 2 : 1);
	},
);
