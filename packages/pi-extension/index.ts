// Simra Agent extension for pi.
// It registers the tools run_experiment (kernel runner + adapters; blocking or detached), query_results (a table of the
// recorded measurements or check rows), wait_experiments (wait for
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
// Context mode (SIMRA_CONTEXT, default "lean"): before each model call, the reasoning of every assistant message but
// the last is left out, and the arguments of every state_note call but the last are shortened. The state_note tool
// keeps a short running note that the agent writes itself (simra/state_note.md). SIMRA_CONTEXT=full sends the whole
// transcript, as before.
// End guard (SIMRA_DELIVERABLES, a JSON list of file paths): when the agent ends its work and a deliverable is
// missing, or the last check has runs that did not complete, or the checked design changed after the last check,
// the session gets one more turn with the missing items named. It happens once per session, and the event is
// recorded in simra/end_guard.json (see endGuardItems).
// All logic lives in @simra-tech/kernel, which works without pi.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
	formatWorkarounds,
	runPdk,
	workaroundsFor,
	emSParameters,
	formatSPoints,
	sParametersAt,
	extractPdf,
	findRoot,
	assumptionUses,
	formatAssumptionUses,
	formatDesignRecord,
	formatQuery,
	formatLog,
	formatTable,
	queryRecords,
	queryTable,
	readLog,
	latestVerdict,
	loadRequirements,
	sha256File,
	formatDiagnostic,
	formatJobs,
	formatOutcome,
	formatStarted,
	formatVerdict,
	formatWait,
	renderPage,
	type ResultRecord,
	runCheck,
	queryAdapter,
	runExperiment,
	runJobs,
	runtimeEstimate,
	waitExperiments,
	type AdapterManifest,
} from "@simra-tech/kernel";
import pkg from "./package.json" with { type: "json" };
import { telemetry } from "@simra-tech/kernel/telemetry";
import { registerHosted } from "./src/hosted.ts";
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

const RECORD_FILE = /(^|\/)simra\/(experiments|checks)\/|(^|\/)(result|verdict|experiment)\.json$/;

/** True when a call reads the record files of the design root (result.json, verdict.json, simra/experiments/...). */
export function readsRecords(event: Pick<ToolResultEvent, "toolName" | "input">): boolean {
	if (event.toolName === "read") return RECORD_FILE.test(String(event.input.path ?? ""));
	if (event.toolName !== "bash") return false;
	const words = String(event.input.command ?? "").match(/[^\s"'<>|;&()=]+/g) ?? [];
	return words.some((w) => RECORD_FILE.test(w) && !/\/work\//.test(w.split("simra/experiments/")[1] ?? ""));
}

/** The next steps after a check: the query of its rows, and the stability diagnosis when a mu row fails. */
export function checkHints(id: string, rows: { requirement: string; status: string; condition: string | null; experiment: string | null; reason?: string | null }[]): string {
	const out = ["", `Rows of this check as a table: query_results with source "checks", check "${id}" (add status "fail" for the failed rows).`];
	const mu = rows.filter((r) => r.status === "fail" && /(^|[_\s])mu($|[_\s])/i.test(r.requirement) && r.experiment);
	if (mu.length)
		out.push(
			`A mu row fails (${mu.map((r) => `${r.condition ?? "-"}: experiment ${r.experiment}`).slice(0, 5).join(", ")}): run_experiment with adapter ngspice, operation stability_diagnosis (the deck and inputs of that experiment, and touchstone = its Touchstone output) gives the frequency, the port and node impedances near it, and the resonating elements.`,
		);
	return out.join("\n");
}

const WORK_FILE = /(^|\/)simra\/experiments\/[^\s]*\/work\/[^\s]*\.(log|raw|dat|txt|csv|out|prn)$|(^|\/)[\w.-]+\.(log|raw)$/;

/** True when a call reads a simulator log or table (a work file of an experiment, or a .log / .raw file). */
export function readsOutputs(event: Pick<ToolResultEvent, "toolName" | "input">): boolean {
	if (event.toolName === "read") return WORK_FILE.test(String(event.input.path ?? ""));
	if (event.toolName !== "bash") return false;
	const words = String(event.input.command ?? "").match(/[^\s"'<>|;&()=]+/g) ?? [];
	return words.some((w) => WORK_FILE.test(w));
}

export const OUTPUT_READ_NOTE = [
	"",
	"Simra: this call reads a simulator log or table. read_output gives it in one call: kind \"log\" lists the measurement",
	'lines, errors and warnings (and lines that match a pattern); kind "table" reads a raw file, wrdata or print output by',
	"column and range, with the minimum and maximum of each column.",
].join("\n");

export const RECORD_READ_NOTE = [
	"",
	"Simra: this call reads record files. query_results gives the same values in one call, as a table:",
	'- source "experiments" with measurement, condition or experiment filters (every run of a measurement, newest first);',
	'- source "checks" with check "latest" (or an id) and status "fail": the rows of a check with limit, margin and reason.',
].join("\n");

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

/**
 * The end guard: the items that are missing when a session ends, as sentences. deliverables are file paths relative to
 * cwd. An item is: a deliverable that does not exist or is empty; with a requirements.json in the design root, no
 * recorded check, a last check with runs that did not complete, or a checked design file (gates.netlist.file) that
 * changed after the last check. An empty list means that the session may end.
 */
export function endGuardItems(cwd: string, deliverables: string[]): string[] {
	const items: string[] = [];
	for (const f of deliverables) {
		const p = isAbsolute(f) ? f : join(cwd, f);
		if (!existsSync(p)) items.push(`${f} does not exist.`);
		else if (statSync(p).size === 0) items.push(`${f} is empty.`);
	}
	const root = findRoot(cwd) ?? cwd;
	const reqPath = join(root, "requirements.json");
	if (!existsSync(reqPath)) return items;
	const checks = join(root, "simra", "checks");
	const verdicts = (existsSync(checks) ? readdirSync(checks) : [])
		.map((id) => join(checks, id, "verdict.json"))
		.filter((p) => existsSync(p))
		.map((p) => {
			try {
				return JSON.parse(readFileSync(p, "utf8")) as { id: string; created_at: string; experiments?: { experiment: string; condition: string | null; status: string }[] };
			} catch {
				return null;
			}
		})
		.filter((v): v is NonNullable<typeof v> => v !== null && Number.isFinite(Date.parse(v.created_at)))
		.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
	const last = verdicts.at(-1);
	if (!last) {
		items.push("No check_requirements run is recorded for requirements.json.");
		return items;
	}
	const failed = (last.experiments ?? []).filter((e) => e.status !== "completed");
	if (failed.length) {
		const names = failed.slice(0, 4).map((e) => `${e.experiment}${e.condition ? ` at ${e.condition}` : ""} (${e.status})`);
		items.push(`The last check (${last.id}) has ${failed.length} run${failed.length === 1 ? "" : "s"} that did not complete: ${names.join(", ")}${failed.length > 4 ? ", ..." : ""}. Their rows are not run.`);
	}
	let design: string | undefined;
	try {
		design = JSON.parse(readFileSync(reqPath, "utf8")).gates?.netlist?.file;
	} catch {
		design = undefined;
	}
	const designPath = typeof design === "string" ? join(root, design) : null;
	if (designPath && existsSync(designPath) && statSync(designPath).mtimeMs > Date.parse(last.created_at)) {
		items.push(`${design} changed after the last check (${last.id}). No check covers the final design.`);
	}
	return items;
}

export const END_GUARD_TYPE = "simra-end-guard";

/** The message of the one re-entry of the end guard. minutesLeft is null when the session has no deadline. */
export function endGuardMessage(items: string[], minutesLeft: number | null): string {
	return [
		"Simra end guard: the session is about to end, and the work is not complete:",
		...items.map((x, i) => `${i + 1}. ${x}`),
		"You get one more turn. Write the missing files now with the best design that a check supports. If the final design has no complete check, run check_requirements on it, or give the last checked design and say which rows are not run.",
		...(minutesLeft === null ? [] : [`Session time left: ${minutesLeft} min.`]),
		"This message comes once. When you stop again, the session ends.",
	].join("\n");
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

type Block = { type: string; [k: string]: unknown };
type Msg = { role?: string; content?: unknown; [k: string]: unknown };

/**
 * The lean context: the messages with the thinking blocks of every assistant message but the last removed, and the
 * arguments of every state_note call but the last replaced by a short marker. The input is not changed.
 */
export function leanContext<T extends Msg>(messages: T[]): T[] {
	let lastAssistant = -1;
	let lastNote = -1;
	messages.forEach((m, i) => {
		if (m.role !== "assistant" || !Array.isArray(m.content)) return;
		lastAssistant = i;
		if ((m.content as Block[]).some((b) => b.type === "toolCall" && b.name === "state_note")) lastNote = i;
	});
	return messages.map((m, i) => {
		if (m.role !== "assistant" || !Array.isArray(m.content) || i === lastAssistant && i === lastNote) return m;
		const blocks = m.content as Block[];
		let changed = false;
		const out: Block[] = [];
		for (const b of blocks) {
			if (b.type === "thinking" && i !== lastAssistant) {
				changed = true;
				continue;
			}
			if (b.type === "toolCall" && b.name === "state_note" && i !== lastNote) {
				changed = true;
				out.push({ ...b, arguments: { note: "(an earlier state note; the latest state_note call holds the current one)" } });
				continue;
			}
			out.push(b);
		}
		return changed ? { ...m, content: out } : m;
	});
}

export const STATE_NOTE_MAX = 3000;

export default function simra(pi: ExtensionAPI, freshHostedId?: string) {
	registerHosted(pi, freshHostedId);
	registerAnalytics(pi);

	// The known gaps of a simulator (workaround registry), shown with the first result of each adapter and PDK in a session.
	const shownGaps = new Set<string>();
	const gapNote = (root: string, adapters: string[], environment?: string, inputs?: Record<string, unknown>): string => {
		const notes: string[] = [];
		for (const adapter of [...new Set(adapters)]) {
			const pdk = runPdk(root, environment, inputs);
			const key = `${adapter}|${pdk ?? ""}`;
			if (shownGaps.has(key)) continue;
			shownGaps.add(key);
			let list: ReturnType<typeof workaroundsFor> = [];
			try {
				list = workaroundsFor({ simulators: [adapter], pdk });
			} catch (e) {
				notes.push(`workaround registry: ${(e as Error).message}`);
			}
			if (list.length) notes.push(formatWorkarounds(list, `known gaps of ${adapter}${pdk ? ` with ${pdk}` : ""} (workaround registry; shown once per session; tool workarounds lists them again)`));
		}
		return notes.length ? `\n\n${notes.join("\n\n")}` : "";
	};

	// A finding is added once per session, at the first call that shows it.
	const reported = new Set<string>();
	const deadline = Date.parse(process.env.SIMRA_SESSION_DEADLINE ?? "");
	const clock = Number.isFinite(deadline) ? sessionClock(Date.now(), deadline) : null;

	let recordReads = 0;
	let outputReads = 0;
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
		let recordNote: string | null = null;
		if (readsRecords(event)) {
			recordReads++;
			// the first three reads, then every tenth: a reminder, not a block
			if (recordReads <= 3 || recordReads % 10 === 0) recordNote = RECORD_READ_NOTE;
		}
		let outputNote: string | null = null;
		if (readsOutputs(event)) {
			outputReads++;
			if (outputReads <= 3 || outputReads % 10 === 0) outputNote = OUTPUT_READ_NOTE;
		}
		const notes = [await netlistNote(event, ctx.cwd), recordNote, outputNote, clock?.(Date.now()) ?? null].filter((n): n is string => n !== null);
		if (notes.length === 0) return;
		return { content: [...event.content, ...notes.map((text) => ({ type: "text" as const, text }))], structuredContent: event.structuredContent };
	});


	// End guard: one re-entry when the agent ends without its deliverables. The event goes into the session (a custom
	// message) and into simra/end_guard.json of the design root.
	let deliverables: string[] = [];
	try {
		const parsed = JSON.parse(process.env.SIMRA_DELIVERABLES ?? "[]");
		if (Array.isArray(parsed)) deliverables = parsed.filter((x): x is string => typeof x === "string");
	} catch {
		deliverables = [];
	}
	if (deliverables.length) {
		let reentries = 0;
		const record = (cwd: string, data: Record<string, unknown>) => {
			const dir = join(findRoot(cwd) ?? cwd, "simra");
			try {
				mkdirSync(dir, { recursive: true });
				const file = join(dir, "end_guard.json");
				const before = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { schema: "simra.end_guard/0", deliverables };
				writeFileSync(file, `${JSON.stringify({ ...before, ...data }, null, 2)}\n`);
			} catch {
				// the record is a trace; a write error must not stop the session
			}
		};
		pi.on("agent_before_settle", async (event, ctx) => {
			if (reentries >= 1) return;
			const items = endGuardItems(ctx.cwd, deliverables);
			if (items.length === 0) return;
			reentries++;
			const left = Number.isFinite(deadline) ? Math.max(0, Math.round((deadline - Date.now()) / 60_000)) : null;
			record(ctx.cwd, { reentry: { at: new Date().toISOString(), items, minutes_left: left } });
			return {
				entries: [...event.entries, { type: "custom_message" as const, customType: END_GUARD_TYPE, content: endGuardMessage(items, left), display: true, details: { items } }],
				continue: true,
			};
		});
		pi.on("agent_settled", async (event, ctx) => {
			record(ctx.cwd, { settled: { at: new Date().toISOString(), aborted: event.aborted, reentries, items: endGuardItems(ctx.cwd, deliverables) } });
		});
	}

	const contextMode = (process.env.SIMRA_CONTEXT ?? "lean").toLowerCase();
	if (contextMode !== "full") {
		pi.on("context", (event) => ({ messages: leanContext(event.messages as Msg[]) as typeof event.messages }));
	}

	pi.registerTool({
		name: "read_output",
		label: "Read output",
		description: [
			"Read a simulator output file of the design root without a script. Use it instead of cat, grep, tail or Python on logs",
			"and tables.",
			"kind \"log\" (default for .log files): the measurement lines (name = value, for example .meas results and print of a",
			"scalar), the error and warning lines (each message once, with its line number and the total count), and the lines",
			"that match pattern (a regex).",
			"kind \"table\": a SPICE raw file (ASCII or binary; complex values as <name>.re and <name>.im), wrdata output (with or",
			"without vector names), print output in a log, or a whitespace or comma table. Give columns (names or /regex/; the",
			"first column, the scale, always comes), from and to (a range of the column by, default the scale), and max_rows",
			"(default 40, evenly spread). The result also gives the minimum and maximum of each column in the range, with the",
			"scale value at each.",
			"file: a path relative to the design root, or <experiment id>/<file> for a file in the work folder of an experiment.",
		].join("\n"),
		promptSnippet: "measurement lines, errors and warnings of a log; a raw or wrdata table by column and range",
		promptGuidelines: [
			"To read a simulator log or a result table, use read_output, not cat, tail, grep or a Python script.",
		],
		parameters: Type.Object({
			file: Type.String({ description: "Path relative to the design root, or <experiment id>/<file in its work folder>" }),
			kind: Type.Optional(Type.Union([Type.Literal("log"), Type.Literal("table")])),
			pattern: Type.Optional(Type.String({ description: "log: also give the lines that match this regex" })),
			columns: Type.Optional(Type.Array(Type.String())),
			by: Type.Optional(Type.String({ description: "table: the column of the range (default the first)" })),
			from: Type.Optional(Type.Number()),
			to: Type.Optional(Type.Number()),
			max_rows: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			let file = params.file;
			const m = /^(\d{8}-\d{6}-[0-9a-f]{6})\/(.+)$/.exec(file);
			if (m && !existsSync(join(root, file))) file = join("simra", "experiments", m[1], "work", m[2]);
			const kind = params.kind ?? (/\.(log|out|lis)$/i.test(file) ? "log" : "table");
			try {
				const text = kind === "log" ? formatLog(readLog(root, file, { pattern: params.pattern })) : formatTable(queryTable(root, file, params));
				return { content: [{ type: "text", text }], details: { file, kind } };
			} catch (e) {
				return { content: [{ type: "text", text: `read_output: ${(e as Error).message}` }], details: { file, kind, error: true } };
			}
		},
	});

	pi.registerTool({
		name: "state_note",
		label: "State note",
		description: [
			"Write your running state note: the goal, the current design and its file, what passed and failed (with experiment or",
			"check ids), what you tried that did not work, and the next step. Each call replaces the note; keep it under",
			`${STATE_NOTE_MAX} characters. The note is written to simra/state_note.md.`,
			"Your reasoning of earlier turns is not kept in the context: only the last state note and the tool results are. Update the",
			"note after each result that changes the plan, and before a long run.",
		].join("\n"),
		promptSnippet: "write the running state note (goal, design state, results, next step)",
		promptGuidelines: [
			"Keep a state note with state_note: update it after each result that changes your plan. Your earlier reasoning is not kept; the note is.",
		],
		parameters: Type.Object({ note: Type.String({ description: `The whole note (at most ${STATE_NOTE_MAX} characters)` }) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			const note = params.note.length > STATE_NOTE_MAX ? params.note.slice(0, STATE_NOTE_MAX) : params.note;
			mkdirSync(join(root, "simra"), { recursive: true });
			writeFileSync(join(root, "simra", "state_note.md"), `${note}\n`);
			const cut = params.note.length > STATE_NOTE_MAX ? ` (cut to ${STATE_NOTE_MAX} of ${params.note.length} characters: keep it short)` : "";
			return { content: [{ type: "text", text: `state note written, ${note.length} characters${cut}` }], details: { chars: note.length } };
		},
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
				const text = `${formatStarted(root, started.experiment, started.estimate)}\nwait: wait_experiments with ids ["${started.id}"]${gapNote(root, [params.adapter], params.environment, params.inputs)}`;
				return { content: [{ type: "text", text }], details: { id: started.id, status: "running" } };
			}
			const outcome = await runExperiment({ ...opts, signal });
			return {
				content: [{ type: "text", text: formatOutcome(root, outcome.experiment, outcome.result, outcome.estimate) + gapNote(root, [params.adapter], params.environment, params.inputs) }, ...imageParts(root, outcome.result)],
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
		name: "run_jobs",
		label: "Run jobs and wait",
		description: [
			"Run N experiments (jobs) and wait for all of them in one call. Each job is a run_experiment request (adapter,",
			"operation, inputs, purpose, environment, timeout_s). Each job runs detached and is recorded as run_experiment records it.",
			"cpus is a CPU pool (for example \"122-125\"): it is split into slots, one job per slot at a time, and each job is pinned",
			"to the CPUs of its slot. timeout_s of a job is its wall-time watchdog (default 3600 s): a job without a result in that",
			"time is stopped (also its container) and has the status timeout. The call gives one line per job: status, experiment",
			"id, exit code, runtime and log paths. Read a job's measurements with wait_experiments or simra show and its id.",
			"wait_timeout_s ends the wait: a running job continues (wait for it with wait_experiments); a job that did not start",
			"is not_started and never runs.",
		].join("\n"),
		promptSnippet: "run N simulations at the same time on a CPU pool and wait for all, with a watchdog per job",
		promptGuidelines: [
			"For more than one independent run (corners, sweep points, seeds), use run_jobs. Do not write shell loops that wait on process names (pgrep, ps).",
		],
		parameters: Type.Object({
			jobs: Type.Array(
				Type.Object({
					adapter: Type.String(),
					operation: Type.String(),
					inputs: Type.Record(Type.String(), Type.Unknown()),
					purpose: Type.Optional(Type.String()),
					environment: Type.Optional(Type.String()),
					timeout_s: Type.Optional(Type.Number({ description: "Watchdog of this job in seconds (default 3600)" })),
				}),
				{ minItems: 1 },
			),
			cpus: Type.Optional(Type.String({ description: 'CPU pool, for example "122-125"' })),
			parallel: Type.Optional(Type.Number({ description: "Jobs at the same time (default: one per CPU of the pool, or 4)" })),
			wait_timeout_s: Type.Optional(Type.Number({ description: "Return after this many seconds (default: when every job ended)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			const outcome = await runJobs({ root, jobs: params.jobs, cpus: params.cpus, parallel: params.parallel, waitTimeoutS: params.wait_timeout_s, signal });
			return {
				content: [{ type: "text", text: formatJobs(outcome) + params.jobs.map((j) => gapNote(root, [j.adapter], j.environment, j.inputs)).join("") }],
				details: { jobs: outcome.jobs.map((o) => ({ index: o.index, id: o.id, status: o.status, exit_code: o.exit_code, cpus: o.cpus })), counts: outcome.counts },
			};
		},
	});
	pi.registerTool({
		name: "assumption_rows",
		label: "Assumption rows",
		description: [
			"List the assumptions of requirements.json (or one), each requirement that depends on it (through the requirement, its",
			"experiment or a condition), and the rows of the newest check that depend on it, with their status. Use it before you",
			"change an assumption: every listed row must be checked again. It runs no tool.",
		].join("\n"),
		promptSnippet: "list the requirement rows that depend on an assumption",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "The assumption id (default: all)" })),
			file: Type.Optional(Type.String({ description: "Requirements file relative to the design root (default requirements.json)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			const { file, path } = loadRequirements(root, params.file);
			if (params.id !== undefined && !file.assumptions?.[params.id]) throw new Error(`assumption "${params.id}" is not defined`);
			const verdict = latestVerdict(root);
			const current = verdict && verdict.requirements_file.sha256 === sha256File(path) ? verdict : null;
			const uses = assumptionUses(file, params.id);
			const stale = verdict && !current ? `\nthe newest check ${verdict.id} used another version of the requirements file: its rows are not listed` : "";
			return {
				content: [{ type: "text", text: formatAssumptionUses(uses, current) + stale }],
				details: { assumptions: uses.map((u) => ({ id: u.assumption, requirements: u.requirements.map((r) => r.id) })), check: current?.id ?? null },
			};
		},
	});
	pi.registerTool({
		name: "em_sparameters",
		label: "EM S-parameters",
		description: [
			"S-parameters of a layout cell with openEMS (adapter openems): one simulate job per port (only that port excited) on a",
			"CPU pool, then a merge to a Touchstone file <cell>.s<N>p. inputs are the inputs of the operation simulate: gds, cell,",
			"stackup (openEMS stackup XML; for IHP SG13G2 $PDK_ROOT/ihp-sg13g2/libs.tech/openems/openems_ihp_sg13g2/workflow/SG13G2_200um.xml),",
			"ports [{name, x, y (um, a number or [a, b]), from, to (conductor layers, or bottom), r_ohm}], band_hz [f_lo, f_hi], points,",
			"and optional faces, layers, merge_um (via arrays), slabs, die, deembed [{port, length_um, eps_eff, loss_db_per_mm}],",
			"mesh_scale, end_criteria_db, max_timesteps. Do not set excite. A port run that does not reach the end criterion of",
			"openEMS (the field energy must fall by end_criteria_db) fails and gives no Touchstone file: never use such data.",
			"report_at_hz lists every S_ij in dB and degrees at the file point nearest to each frequency.",
			"Use inputs.dry_run with run_experiment (adapter openems, operation simulate) to see the mesh size before a long run.",
		].join("\n"),
		promptSnippet: "EM S-parameters (Touchstone) of a layout cell with openEMS, one job per port",
		promptGuidelines: [
			"For S-parameters of a layout structure, use em_sparameters; do not write your own openEMS script. Report the frequency of each value you state.",
		],
		parameters: Type.Object({
			inputs: Type.Record(Type.String(), Type.Unknown()),
			environment: Type.Optional(Type.String()),
			cpus: Type.Optional(Type.String({ description: 'CPU pool, for example "122-125"' })),
			parallel: Type.Optional(Type.Number({ description: "Port jobs at the same time" })),
			timeout_s: Type.Optional(Type.Number({ description: "Watchdog of each port job in seconds (default 3600)" })),
			report_at_hz: Type.Optional(Type.Array(Type.Number())),
			adapter: Type.Optional(Type.String({ description: "EM adapter (default openems)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			const out = await emSParameters({ root, inputs: params.inputs, adapter: params.adapter, environment: params.environment, cpus: params.cpus, parallel: params.parallel, timeoutS: params.timeout_s, signal });
			const points = out.touchstone && params.report_at_hz?.length ? sParametersAt(join(root, out.touchstone), params.report_at_hz) : [];
			const text = (points.length ? `${out.text}\n\n${formatSPoints(points)}` : out.text) + gapNote(root, [params.adapter ?? "openems"], params.environment, params.inputs);
			return {
				content: [{ type: "text", text }],
				details: { touchstone: out.touchstone, problems: out.problems, points, jobs: out.ports.jobs.map((o) => ({ id: o.id, status: o.status })), merge: out.merge?.id ?? null },
			};
		},
	});
	pi.registerTool({
		name: "workarounds",
		label: "Workarounds",
		description: [
			"List the known gaps of the simulators (registry workarounds/<simulator>/<pdk>.json) and the stated workaround of",
			"each: what fails, how it shows, what to do, and the status (worked_around: used and checked; proposed: not yet",
			"used; open: no workaround). Without pdk only the PDK-independent entries are listed. It runs no tool.",
		].join("\n"),
		promptSnippet: "list the known simulator gaps and their workarounds for a PDK",
		promptGuidelines: [
			"Before you write a deck for a simulator, check its known gaps with workarounds (simulator and PDK). Do not use a device class that a gap names without the stated workaround.",
		],
		parameters: Type.Object({
			simulator: Type.Optional(Type.String({ description: "ngspice, xyce or openems (default: all)" })),
			pdk: Type.Optional(Type.String({ description: 'PDK name, for example "ihp-sg13g2"' })),
		}),
		async execute(_toolCallId, params) {
			const list = workaroundsFor({ simulators: params.simulator ? [params.simulator] : undefined, pdk: params.pdk ?? null });
			return { content: [{ type: "text", text: formatWorkarounds(list) }], details: { ids: list.map((w) => w.id) } };
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
		name: "query_results",
		label: "Query results",
		description: [
			"Use this tool to read results: it reads the records of the design root (every experiment and check) and gives a table,",
			"in one call and without a script. It runs no simulation.",
			"Examples: {measurement: \"nf_db\"} gives every run of nf_db, newest first, with its condition; {source: \"checks\",",
			"check: \"latest\", status: \"fail\"} gives the failed rows of the last check with limit, margin and reason;",
			"{source: \"checks\", requirement: \"mu\"} gives the mu rows of every check, to see a change between design versions.",
			"A table of recorded results. source \"experiments\" (default): one row per measurement of each",
			"experiment, newest first; the condition is the condition of its check, else the temperature and params of the inputs.",
			"source \"checks\": one row per verdict row of a check (default the newest; check gives an id), with the limit, the",
			"margin, the sweep point or seed, and the reason. A filter on check or requirement selects checks.",
			"Filters: experiment (an id prefix or a text in the purpose; for checks the experiment name), condition (exact),",
			"measurement and requirement (a text, or /regex/), status, operation (for example monte_carlo or device_limits).",
		].join("\n"),
		promptSnippet: "table of recorded measurements or check rows, filtered by corner, measurement or requirement",
		promptGuidelines: [
			"To compare results over corners, seeds or runs, use query_results instead of reading result.json or verdict.json files with a script.",
			"Do not read simra/experiments/*/result.json or simra/checks/*/verdict.json with cat, jq, grep or Python to get a value: query_results gives it with the experiment id.",
		],
		parameters: Type.Object({
			source: Type.Optional(Type.Union([Type.Literal("experiments"), Type.Literal("checks")])),
			check: Type.Optional(Type.String({ description: 'A check id or "latest"' })),
			experiment: Type.Optional(Type.String()),
			condition: Type.Optional(Type.String()),
			measurement: Type.Optional(Type.String()),
			requirement: Type.Optional(Type.String()),
			status: Type.Optional(Type.String()),
			operation: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Number({ description: "The most rows (default 200)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = findRoot(ctx.cwd) ?? ctx.cwd;
			const q = queryRecords(root, params);
			return { content: [{ type: "text", text: formatQuery(q) }], details: { source: q.source, check: q.check, matched: q.matched, rows: q.rows.length } };
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
			"- kind (optional, default \"measurement\"): \"s_db\" (20 log10 |S_ij|, entry [i, j]) or \"mu\" (stability factor of a",
			"  2-port, > 1 is unconditionally stable) read a Touchstone file of the experiment (touchstone names it when there are",
			"  several) at every data point in band_hz [f_lo, f_hi] and use the worst point (@ f_hz=<f>). They have no measurement.",
			"  A band outside the data is not measured. A mu requirement can name its RF stage in stage.",
			"- kind \"sweep\": a reducer over a column of the sweep table of the experiment (output role sweep; ngspice ROW lines,",
			"  xyce hb sweeps): column, reduce {kind: min | max | crossing (level, direction) | compression (db, default 1)}. The value",
			"  is invalid (not measured) when a point inside the bracket of the reducer has no value.",
			"- kind \"monte_carlo\": a statistic over the seeds of a Monte Carlo table (output role monte_carlo): measurement,",
			"  statistic (mean, sigma, min, max, abs_max, mean_abs_k_sigma = |mean| + k sigma, mean_plus_k_sigma, mean_minus_k_sigma),",
			"  k (default 3), min_seeds (default 30). A seed without a value (no DC point) makes the row not measured.",
			"- gates.limits (optional): {experiments (default every ngspice simulate experiment of a requirement), tran ({experiment:",
			"  {step_s, stop_s, start_s}} for the peak), extra_limits ([{id, class, quantity, op, limit, source or assumption}])}.",
			"  The check runs the operation device_limits of the adapter at each experiment and condition: the operating limits of each",
			"  device from the technology pack (HBT VCE, VCB, VEB, IC per emitter; MOS VDS, VGS) with their PDK source.",
			"- gates.stability (optional): {stages, conditions, band_hz (default [1e9, 300e9])}. Each stage needs a mu requirement",
			"  (op >=, limit >= 1, stage set) whose band contains band_hz at each condition; else its gate row is not run and the",
			"  check cannot pass.",
			"- gates.netlist (optional): {file, subckt, pins, devices, given, wiring, couplings, fitted, em_passives_min, allow_params,",
			"  technology}: one row with the rule errors of the design file (the instance parameters of each PDK device come from the",
			"  technology pack; a parameter that changes the device physics, for example selft or dtemp, is an error unless",
			"  allow_params names it).",
			"- fit_band rows (automatic): each ac, sp or noise analysis of a bench that uses a fitted model (fit_to_spice) must be",
			"  inside the band of use of the fit record (uses.band_hz), and a noise analysis needs a fit with uses.noise_band_hz.",
			"- limit_source (optional, on a requirement or an extra limit): {kind: specification | pdk | reference_design | task, ref}.",
			"- assumptions (optional): {id: {description, value?, unit?, source?}}. A requirement, experiment or condition cites them",
			"  in assumptions [ids]; each row lists the assumptions it depends on. assumption_rows lists the rows of one assumption.",
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
				content: [{ type: "text", text: formatVerdict(root, verdict) + checkHints(id, verdict.rows) }],
				details: { id, status: verdict.status, counts: verdict.counts },
			};
		},
	});
}
