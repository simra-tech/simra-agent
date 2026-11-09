// Simra Agent extension for pi.
// It registers the tools run_experiment (kernel runner + adapters; blocking or detached), wait_experiments (wait for
// detached runs in one call), check_requirements (requirements.json against the design) and design_record (the checks
// that ran on each file of record, current or stale), and the command /simra-version. In the terminal UI, it sets a
// Simra header.
// After a read, write, edit or bash call that names a netlist, it adds the ngspice adapter's netlist check
// (operation "lint") to the tool result: for example a warning about ".option rshunt".
// Before a read call on a .pdf file, it extracts the PDF into the cache (kernel extractPdf) and points the call at the
// page-marked text, document.md. pi's read then applies offset and limit as for any text file. Before a read call on
// <file>.pdf#page=N, it renders page N to a PNG in the cache if the cache does not have it (kernel renderPage) and
// points the call at the image. If the model has no image input, it blocks that call and tells the agent why.
// When SIMRA_SESSION_DEADLINE (an ISO 8601 time) is set, it adds a time note to the first tool result after 50 %
// and after 80 % of the session time: the agent must write its output files before the session ends.
// It replaces pi's coding-assistant preamble with a chip-design preamble (SIMRA_PREAMBLE) and leaves out pi's own
// documentation section; the tool list and the rules stay, and a rule for PDFs is added (see chipDesignPrompt).
// All logic lives in @simra-tech/kernel, which works without pi.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import {
	type BeforeAgentStartEvent,
	createReadToolDefinition,
	type ExtensionAPI,
	type ToolResultEvent,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_ADAPTER_DIR,
	designRecord,
	extractPdf,
	findRoot,
	formatDesignRecord,
	formatDiagnostic,
	formatOutcome,
	formatStarted,
	formatVerdict,
	formatWait,
	renderPage,
	type ResultRecord,
	runCheck,
	queryAdapter,
	runExperiment,
	runtimeEstimate,
	waitExperiments,
	type AdapterManifest,
} from "@simra-tech/kernel";
import pkg from "./package.json" with { type: "json" };
import { telemetry } from "@simra-tech/kernel/telemetry";
import { registerAnalytics } from "./src/analytics.ts";

/** The versions that /simra-version and the header show. */
const versions = { simra: pkg.version, pi: PI_VERSION };
/** Called by the simra binary: there, pi's VERSION is the version of the simra release, and pi's own version comes from the build. */
export function setVersions(simra: string, pi: string): void {
	versions.simra = simra;
	versions.pi = pi;
	telemetry.configure({ version: simra });
}

/** The images that an experiment may add to a tool result: at most MAX_IMAGES PNG outputs of role "image", MAX_IMAGE_BYTES in all. */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 1_000_000;

/**
 * The image parts of a tool result: the outputs of role "image" of a result (PNG files), in the order of the result,
 * up to MAX_IMAGES and MAX_IMAGE_BYTES in all. An output that is missing, is not a PNG, or does not fit is skipped;
 * the summary text still names it. Paths are relative to the design root, or absolute.
 */
export function imageParts(root: string, result: Pick<ResultRecord, "outputs">): { type: "image"; data: string; mimeType: string }[] {
	const parts: { type: "image"; data: string; mimeType: string }[] = [];
	let total = 0;
	for (const f of result.outputs) {
		if (f.role !== "image" || !/\.png$/i.test(f.path) || parts.length >= MAX_IMAGES) continue;
		const path = isAbsolute(f.path) ? f.path : join(root, f.path);
		if (!existsSync(path)) continue;
		const size = statSync(path).size;
		if (size === 0 || total + size > MAX_IMAGE_BYTES) continue;
		total += size;
		parts.push({ type: "image", data: readFileSync(path).toString("base64"), mimeType: "image/png" });
	}
	return parts;
}

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

/** The example in the check_requirements description: two corners, one AC experiment (one deck per corner), two requirements. */
export const REQUIREMENTS_EXAMPLE = JSON.stringify({
	schema: "simra.requirements/0",
	conditions: { tt: { description: "typical, 27 C" }, ss: { description: "slow, 125 C" } },
	experiments: {
		ac: { adapter: "ngspice", operation: "simulate", environment: "eda", inputs: { deck: "tb_{condition}.spice", measurements: { gain_db: "dB", pm_deg: "deg" } } },
	},
	requirements: [
		{ id: "gain", experiment: "ac", measurement: "gain_db", unit: "dB", op: ">=", limit: 48, conditions: ["tt", "ss"] },
		{ id: "pm", experiment: "ac", measurement: "pm_deg", unit: "deg", op: "between", limit: [60, 90], conditions: ["tt", "ss"] },
	],
});

const NETLIST = /\.(spice|cir|sp|net|inc)$/i;

/** The netlist files that a tool call names and that exist: the path of read, write and edit, the words of bash. */
export function netlistsOf(event: Pick<ToolResultEvent, "toolName" | "input">, cwd: string): string[] {
	const words =
		event.toolName === "bash"
			? String(event.input.command ?? "").match(/[^\s"'<>|;&()=]+/g) ?? []
			: ["read", "write", "edit"].includes(event.toolName) ? [String(event.input.path ?? "")] : [];
	const files = words.filter((w) => NETLIST.test(w)).map((w) => (isAbsolute(w) ? w : resolve(cwd, w)));
	return [...new Set(files)].filter((f) => existsSync(f));
}

const RESOLVED = Symbol("resolved");

/**
 * The absolute path that pi's read opens for a path. pi does not export its path resolution ("@", "~", file:// URLs,
 * fallbacks for macOS file names), so a read tool whose access step keeps the path and stops asks pi for it.
 */
export async function readPath(path: string, cwd: string): Promise<string> {
	let resolved = "";
	const probe = createReadToolDefinition(cwd, {
		operations: {
			access: async (absolutePath) => {
				resolved = absolutePath;
				throw RESOLVED;
			},
			readFile: async () => Buffer.alloc(0),
		},
	});
	await probe.execute("simra-read-path", { path }, undefined, undefined, undefined as never).catch((e) => {
		if (e !== RESOLVED) throw e;
	});
	return resolved;
}

export const TIME_MARKS = [0.5, 0.8];

/**
 * The session clock: note(now) gives a time note the first time that the used fraction of the session passes a
 * mark, else null. start is when the extension loads; deadline is the end of the session.
 */
export function sessionClock(start: number, deadline: number) {
	let passed = 0;
	return (now: number): string | null => {
		const total = deadline - start;
		const used = (now - start) / total;
		let mark = passed;
		while (mark < TIME_MARKS.length && used >= TIME_MARKS[mark]) mark++;
		if (mark === passed || total <= 0) return null;
		passed = mark;
		const min = (ms: number) => Math.max(0, Math.round(ms / 60_000));
		return [
			"",
			`Simra session time: ${min(now - start)} of ${min(total)} min used, ${min(deadline - now)} min left.`,
			"Write the output files that the task asks for now (the changed design, the answer file), with the best result so far.",
			"Then continue, and update the files when you find a better result.",
		].join("\n");
	};
}

export const SIMRA_PREAMBLE = [
	"You are Simra Agent, a chip design assistant. You help with work across the chip design process, including modeling, design,",
	"verification, layout and tapeout preparation. Work with the tools, adapters and technology data available for the task,",
	"and say when a required capability is unavailable. Base claims about design performance and verification on recorded",
	"evidence. Do not present estimates or assumptions as measured or verified results. When a check did not run, say that",
	"it did not run.",
].join(" ");

export const PDF_RULE =
	"For a PDF, read gives the text with a [page N] marker before each page, and read of <file>.pdf#page=N shows page N as an image. Look at the page before you copy a circuit, table or plot from a figure, and check a netlist copied from a figure with a simulation.";

/**
 * Set the chip-design preamble in pi's prompt options. With a custom preamble, pi leaves out its tool list, its rules
 * and its documentation section. This function puts the tool list and the rules back, built as pi builds them from the
 * same options, so that only the preamble and the documentation section change, and adds PDF_RULE when read is
 * available. A prompt that the user set (SYSTEM.md or --system-prompt) stays as it is.
 */
export function chipDesignPrompt(options: BeforeAgentStartEvent["systemPromptOptions"]): void {
	if (options.customPrompt) return;
	const { selectedTools, hiddenTools, toolSnippets, toolGuidelines, promptGuidelines } = options;
	const listed = selectedTools.filter((name) => !hiddenTools.includes(name) && toolSnippets[name]);
	const fileTools = ["grep", "find", "ls"].some((name) => selectedTools.includes(name));
	const rules = [
		...(selectedTools.includes("bash") && !fileTools ? ["Use bash for file operations like ls, rg, find"] : []),
		...selectedTools.flatMap((name) => toolGuidelines[name] ?? []),
		...promptGuidelines,
		...(selectedTools.includes("read") ? [PDF_RULE] : []),
		"Be concise in your responses",
		"Show file paths clearly when working with files",
	]
		.map((rule) => rule.trim())
		.filter(Boolean);
	options.customPrompt = SIMRA_PREAMBLE;
	options.sections.tools = listed.length > 0 ? listed.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
	options.sections.rules = [...new Set(rules)].map((rule) => `- ${rule}`).join("\n");
}

export default function (pi: ExtensionAPI) {
	registerAnalytics(pi);
	// A finding is added once per session, at the first call that shows it.
	const reported = new Set<string>();
	const deadline = Date.parse(process.env.SIMRA_SESSION_DEADLINE ?? "");
	const clock = Number.isFinite(deadline) ? sessionClock(Date.now(), deadline) : null;

	async function netlistNote(event: ToolResultEvent, cwd: string): Promise<string | null> {
		const files = netlistsOf(event, cwd);
		if (files.length === 0) return null;
		const root = findRoot(cwd) ?? cwd;
		let found;
		try {
			found = await queryAdapter({ root, adapter: "ngspice", operation: "lint", inputs: { files } });
		} catch {
			return null;
		}
		const fresh = found.diagnostics.filter((d) => d.severity === "warning" && !reported.has(formatDiagnostic(d)));
		if (fresh.length === 0) return null;
		for (const d of fresh) reported.add(formatDiagnostic(d));
		return ["", "Simra netlist check (ngspice adapter, operation lint):", ...fresh.map(formatDiagnostic)].join("\n");
	}

	pi.on("before_agent_start", (event) => {
		chipDesignPrompt(event.systemPromptOptions);
	});

	// In the terminal UI, a Simra header replaces pi's logo and startup help.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({
			render: () => [
				`${theme.bold(theme.fg("accent", "Simra"))} ${theme.fg("dim", `${versions.simra}, a chip-design agent built on pi ${versions.pi}`)}`,
				theme.fg("dim", "Esc interrupts. / lists the commands. ! runs a shell command. Ctrl+C twice exits."),
			],
			invalidate() {},
		}));
	});

	// A read of a PDF reads its page-marked text from the cache. A read of <file>.pdf#page=N renders page N to a PNG in
	// the cache, once, and reads the image. An encrypted or broken PDF, a page outside the PDF, or a model without image
	// input for a page image blocks the call with the reason.
	pi.on("tool_call", async (event, ctx) => {
		const match = event.toolName === "read" ? /^(.*\.pdf)(?:#page=([1-9]\d*))?$/i.exec(String(event.input.path ?? "")) : null;
		if (!match) return;
		const [, file, page] = match;
		try {
			const path = await readPath(file, ctx.cwd);
			if (!existsSync(path)) return;
			if (page && ctx.model && !ctx.model.input.includes("image")) {
				const reason = `the model ${ctx.model.id} has no image input, so it cannot see page ${page}. Read the text after [page ${page}] in ${file}, or use a model with image input.`;
				return { block: true, reason: `Simra PDF reader: ${reason}` };
			}
			event.input.path = page ? await renderPage(path, Number(page)) : (await extractPdf(path)).document;
		} catch (e) {
			return { block: true, reason: `Simra PDF reader: ${(e as Error).message}` };
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const notes = [await netlistNote(event, ctx.cwd), clock?.(Date.now()) ?? null].filter((n): n is string => n !== null);
		if (notes.length === 0) return;
		return { content: [...event.content, ...notes.map((text) => ({ type: "text" as const, text }))], structuredContent: event.structuredContent };
	});


	pi.registerCommand("simra-version", {
		description: "Show the Simra Agent and pi versions",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`simra-agent ${versions.simra} (pi ${versions.pi})`, "info");
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
			"With detached true, the call returns at once with the experiment id and the status running, and the run continues",
			"after the call. Then call wait_experiments with the id: it gives the same summary when the run ends. Use detached for a",
			"run that takes minutes, or for two runs that are independent (for example DRC and LVS of the same layout): start both,",
			"then wait for both in one wait_experiments call.",
			"When earlier runs of the same adapter and operation exist in the design root, the summary gives their shortest and",
			"longest runtime (line 'estimate:').",
			"Environments are defined in simra.config.json in the design root ('local' always exists).",
			"Available adapters:",
			adapterCatalog(),
		].join("\n"),
		promptSnippet: "run and record one simulation through a Simra adapter",
		promptGuidelines: [
			"Run simulations with run_experiment, not with a direct shell command, so that each run is recorded.",
			"Run DRC and LVS with run_experiment (adapter klayout, operations drc and lvs), not with a DRC or LVS shell script. Report a DRC or LVS that did not run as not run, not as a pass.",
			"To read a layout, use run_experiment with adapter klayout, operation query, and put several questions in one call. To see what an edit or a commit changed, use operation diff (against a file or git:<ref>). Write Python only to change a layout.",
			"To see a region of a layout or a DRC marker, use run_experiment with adapter klayout, operation render (a box, or a drc experiment id and a rule): the picture comes with the result. Use it when the marker boxes and the shapes do not tell which edge to move, not for every marker.",
			"When you report a simulated number, give the experiment id that produced it.",
			"For a run that takes minutes, or for independent runs, start them with run_experiment detached and wait_experiments; do not poll with sleep, tail or log reads.",
			"When a task asks for output files (a changed design, an answer file), write them as soon as you have a first result, and update them each time you find a better one. A session can end before you finish.",
		],
		parameters: Type.Object({
			adapter: Type.String({ description: 'Adapter name, for example "ngspice"' }),
			operation: Type.String({ description: 'Adapter operation, for example "simulate"' }),
			inputs: Type.Record(Type.String(), Type.Unknown(), { description: "Adapter inputs (see the adapter list)" }),
			purpose: Type.String({ description: "Why you run this experiment, in one sentence" }),
			environment: Type.Optional(Type.String({ description: 'Environment name from simra.config.json (default "local")' })),
			timeout_s: Type.Optional(Type.Number({ description: "Stop the run after this many seconds (default 3600)" })),
			detached: Type.Optional(
				Type.Boolean({ description: "Start the run and return at once with its id (default false). Wait for it with wait_experiments." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			const opts = {
				root,
				adapter: params.adapter,
				operation: params.operation,
				inputs: params.inputs,
				purpose: params.purpose,
				environment: params.environment,
				timeoutS: params.timeout_s,
			};
			if (params.detached) {
				const started = await runExperiment({ ...opts, detached: true });
				const text = `${formatStarted(root, started.experiment, started.estimate)}\nwait: wait_experiments with ids ["${started.id}"]`;
				return { content: [{ type: "text", text }], details: { id: started.id, status: "running" } };
			}
			const outcome = await runExperiment({ ...opts, signal });
			return {
				content: [{ type: "text", text: formatOutcome(root, outcome.experiment, outcome.result, outcome.estimate) }, ...imageParts(root, outcome.result)],
				details: { id: outcome.id, status: outcome.result.status, measurements: outcome.result.measurements },
			};
		},
	});
	pi.registerTool({
		name: "wait_experiments",
		label: "Wait for experiments",
		description: [
			"Wait for experiments that run_experiment started with detached true. The call blocks until every listed experiment",
			"has ended, or until timeout_s. It gives one summary per id, in the order of ids, the same summary as a blocking",
			"run_experiment. An experiment that did not end gives 'still running after N s'; call wait_experiments again for it.",
			"An experiment whose supervisor process stopped without a result is recorded with the status error.",
		].join("\n"),
		promptSnippet: "wait for detached experiments and give their summaries",
		parameters: Type.Object({
			ids: Type.Array(Type.String(), { description: "Experiment ids from run_experiment", minItems: 1 }),
			timeout_s: Type.Optional(Type.Number({ description: "Return after this many seconds, also when runs did not end (default 3600)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			const start = Date.now();
			const outcomes = await waitExperiments(root, params.ids, { timeoutS: params.timeout_s ?? 3600, signal });
			telemetry.capture("experiments_wait_completed", {
				requested_experiment_count: params.ids.length,
				completed_experiment_count: outcomes.filter((outcome) => outcome.status === "completed").length,
				unfinished_experiment_count: outcomes.filter((outcome) => outcome.status !== "completed").length,
			});
			const text = formatWait(root, outcomes, (Date.now() - start) / 1000, (e) => runtimeEstimate(root, e));
			return {
				content: [{ type: "text", text }, ...outcomes.flatMap((o) => (o.result ? imageParts(root, o.result) : []))],
				details: { experiments: outcomes.map((o) => ({ id: o.id, status: o.status, measurements: o.result?.measurements ?? {} })) },
			};
		},
	});
	pi.registerTool({
		name: "design_record",
		label: "Design record",
		description: [
			"Show the design record: for each file of record (an input file of an experiment in the design root, for example a",
			"layout or a netlist), its current sha256, its last git commit, and the experiments that ran on it, current ones first.",
			"An experiment is current when the sha256 that it recorded equals the sha256 of the file now. Else it is stale: its",
			"verdict is about an earlier version of the file. 'no check on the current file' means that no experiment ran on the",
			"file as it is now. The summary of an experiment also gives a STALE line for each input file that changed after the run.",
			"It runs no tool; it reads the records in simra/experiments.",
		].join("\n"),
		promptSnippet: "show which checks are current for each file of record (layout, netlist), and which are stale",
		promptGuidelines: [
			"A verdict counts only for the file that it ran on. Before you report a check, confirm with design_record that the check is current for the file of record. If it is stale, run it again.",
			"When a file of record changed under you (another commit, another process), do not overwrite it with your own earlier copy. Read the new version and apply your change to it.",
		],
		parameters: Type.Object({
			paths: Type.Optional(Type.Array(Type.String(), { description: "Show only these files (relative to the design root). Default: all files of record" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			const paths = params.paths?.map((p) => (isAbsolute(p) ? p : resolve(root, p)));
			const record = designRecord(root, paths);
			return {
				content: [{ type: "text", text: formatDesignRecord(record) }],
				details: {
					files: record.files.map((f) => ({
						path: f.path,
						sha256: f.sha256,
						current: f.experiments.filter((e) => e.current).map((e) => e.id),
						stale: f.experiments.filter((e) => !e.current).map((e) => e.id),
					})),
				},
			};
		},
	});
	pi.registerTool({
		name: "check_requirements",
		label: "Check requirements",
		description: [
			"Check the design against requirements.json in the design root (schema simra.requirements/0).",
			"The file names the conditions (for example corners), one experiment template per measurement setup, and the",
			"requirements (measurement, op <=, >= or between, limit, conditions). The check runs each experiment it needs once per",
			"condition with the same runner as run_experiment, compares every measurement with its limit, and writes",
			"simra/checks/<id>/verdict.json. Each row is pass, fail, not measured or not run, with its margin and experiment id.",
			"The status is pass only when every row of every requirement passes. A check of a selection is never a pass.",
			"",
			"Format of requirements.json:",
			"- schema: \"simra.requirements/0\".",
			"- conditions: {name: {description?, inputs?}}. A condition input replaces the experiment input of the same name.",
			"  For ngspice, a condition can give params ({name: value}) and temp_c; they replace the deck's .param values and .temp.",
			"- A sweep bench prints one line per point, 'ROW <sweep>=<v> <name>=<value> ...', and the check uses the worst point",
			"  over the sweep and names it (@ <sweep>=<v>). A sweep point without a value is never a pass.",
			"- experiments: {name: {adapter, operation, inputs, environment?, timeout_s?}}, with the same inputs as",
			"  run_experiment. In each input string, \"{condition}\" is replaced with the condition name.",
			"- requirements: [{id, description?, experiment, measurement, unit?, op, limit, conditions?}]. op is \"<=\", \">=\" or",
			"  \"between\". limit is a number, [low, high] for between, or {condition: limit}. measurement is a measurement",
			"  of the experiment (for simulate, a key of inputs.measurements). conditions lists the condition names to check. A requirement without conditions runs its",
			"  experiment once, with the template inputs only (for example design_errors <= 0 and area_um2 <= 800 from a design",
			"  check). Before the rows, the summary shows the errors and warnings, with file and line, of each experiment that gave a row that does not pass.",
			"Example:",
			REQUIREMENTS_EXAMPLE,
		].join("\n"),
		promptSnippet: "run the experiments in requirements.json and compare each measurement with its limit",
		promptGuidelines: [
			"When the design has a requirements.json, run check_requirements without a selection before you say that the design meets its requirements, and give its check id.",
			"Use the requirements and conditions parameters to check one row quickly while you work; that result is not a pass.",
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
