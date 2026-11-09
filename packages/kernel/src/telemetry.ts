// The only analytics boundary. Never pass prompts, tool arguments/results, paths, errors or design records here.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// The context-free entry point avoids Node exception hooks and ambient context from other extensions.
import { PostHog } from "posthog-node/edge";
import pkg from "../package.json" with { type: "json" };

// Bun substitutes these at release build time. Source installs use runtime environment variables.
declare const SIMRA_POSTHOG_PROJECT_TOKEN: string | undefined;
declare const SIMRA_POSTHOG_HOST: string | undefined;
const bundledToken = typeof SIMRA_POSTHOG_PROJECT_TOKEN === "undefined" ? undefined : SIMRA_POSTHOG_PROJECT_TOKEN;
const bundledHost = typeof SIMRA_POSTHOG_HOST === "undefined" ? undefined : SIMRA_POSTHOG_HOST;

type Value = string | number | boolean;
type Rule = (value: unknown) => Value | undefined;
const choice = (...values: string[]): Rule => (v) => typeof v === "string" && values.includes(v) ? v : undefined;
const category = (...values: string[]): Rule => (v) => typeof v === "string" ? values.includes(v) ? v : "custom" : undefined;
const number: Rule = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const boolean: Rule = (v) => typeof v === "boolean" ? v : undefined;
const uuid: Rule = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v) ? v : undefined;
const adapter = category("ngspice", "klayout");
const operation = category("simulate", "operating_point", "check_design", "lint", "drc", "lvs", "query", "diff", "render", "pack_propose", "pack_check");
const tool = category("read", "write", "edit", "bash", "grep", "find", "ls", "codemode", "run_experiment", "wait_experiments", "check_requirements", "design_record");
const execution = choice("blocking", "detached");
const status = choice("completed", "failed", "timeout", "cancelled", "error");
const ai = { $ai_trace_id: uuid, $ai_span_id: uuid, $ai_parent_id: uuid, $ai_latency: number, $ai_is_error: boolean };

// Adding an event or property requires a privacy review here and a payload test. Unknown properties are dropped.
const schemas = {
	cli_started: { command: choice("run", "wait", "show", "list", "record", "check", "pdf", "pack"), headless: boolean },
	cli_completed: { command: choice("run", "wait", "show", "list", "record", "check", "pdf", "pack"), duration_ms: number, exit_code: number },
	setup_started: {},
	setup_completed: { outcome: choice("configured", "deferred", "cancelled", "error"), provider: category("deepseek", "openai") },
	session_started: { reason: choice("startup", "reload", "new", "resume", "fork"), mode: choice("tui", "rpc", "json", "print") },
	session_ended: { duration_ms: number },
	model_selected: { source: choice("set", "cycle", "restore", "startup") },
	$ai_trace: { ...ai, $ai_span_name: choice("agent_run") },
	$ai_span: { ...ai, $ai_span_name: tool, tool_name: tool },
	$ai_generation: { ...ai, $ai_input_tokens: number, $ai_output_tokens: number, $ai_cache_read_input_tokens: number,
		$ai_cache_creation_input_tokens: number, $ai_reasoning_tokens: number, $ai_cache_reporting_exclusive: boolean,
		$ai_total_cost_usd: number, cost_is_estimate: boolean, stop_reason: choice("stop", "length", "toolUse", "error", "aborted", "deferred") },
	experiment_started: { adapter, operation, execution_mode: execution },
	experiment_completed: { adapter, operation, execution_mode: execution, status, duration_ms: number },
	experiments_wait_completed: { requested_experiment_count: number, completed_experiment_count: number, unfinished_experiment_count: number },
} satisfies Record<string, Record<string, Rule>>;

export type TelemetryEvent = keyof typeof schemas;
type Properties<E extends TelemetryEvent> = Partial<Record<keyof (typeof schemas)[E], Value | undefined>> & { $ai_model?: string; $ai_provider?: string };
export interface TelemetryTransport {
	capture(event: { distinctId: string; event: string; properties: Record<string, Value>; timestamp?: Date; disableGeoip: boolean }): void;
	shutdown(timeoutMs?: number): Promise<void>;
}

/** These overrides always take precedence over saved consent. */
export function analyticsOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
	return [env.SIMRA_NO_ANALYTICS, env.DO_NOT_TRACK].some((v) => !!v && !["0", "false", "no"].includes(v.trim().toLowerCase())) || env.NODE_ENV === "test" || !!env.NODE_TEST_CONTEXT;
}

function settingsDirectory(env: NodeJS.ProcessEnv): string {
	const directory = env.SIMRA_CODING_AGENT_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "simra");
	if (directory === "~") return homedir();
	return directory.startsWith("~/") ? join(homedir(), directory.slice(2)) : directory;
}

/** Missing, unreadable or invalid consent means off. An existing analytics-id is never consent. */
export function getAnalyticsConsent(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
	try {
		const saved = JSON.parse(readFileSync(join(settingsDirectory(env), "analytics.json"), "utf8"));
		if (saved?.schema === "simra.analytics/1" && typeof saved.enabled === "boolean") return saved.enabled;
	} catch {}
	return undefined;
}

/** Only an explicit UI choice or analytics on/off command may write this preference. */
export function setAnalyticsConsent(enabled: boolean, env: NodeJS.ProcessEnv = process.env): void {
	const directory = settingsDirectory(env);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `analytics-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: "simra.analytics/1", enabled })}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, join(directory, "analytics.json"));
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Check policy before creating a client or identifier. CI/headless runs also require saved opt-in. */
export function analyticsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return analyticsOptedOut(env) || getAnalyticsConsent(env) !== true;
}

function identity(env: NodeJS.ProcessEnv): string {
	const file = join(settingsDirectory(env), "analytics-id");
	try {
		const id = readFileSync(file, "utf8").trim();
		if (uuid(id)) return id;
	} catch {}
	const id = randomUUID();
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(file, `${id}\n`, { mode: 0o600, flag: "wx" });
	} catch {
		// Concurrent first launch or read-only home. Never block the user's work.
		try {
			const existing = readFileSync(file, "utf8").trim();
			if (uuid(existing)) return existing;
			// Repair an interrupted write without leaving another partially written identifier.
			const temporary = `${file}-${id}.tmp`;
			try {
				writeFileSync(temporary, `${id}\n`, { mode: 0o600, flag: "wx" });
				renameSync(temporary, file);
			} finally {
				rmSync(temporary, { force: true });
			}
		} catch {}
	}
	return id;
}

export const ANALYTICS_NOTICE = "Share usage metadata with Simra via PostHog? Simra version, OS/CPU type, commands, session mode, model, token/cost totals, tool/adapter categories, setup steps, run outcomes and timings. A random installation ID links runs. Prompts, designs, file contents and tool inputs/outputs are excluded. Change later: simra analytics on/off. Environment opt-outs always win.";

/** Shared by the CLI and extensions. Adapters report through their parent; they never export their JSON payloads. */
export function createTelemetry(options: {
	env?: NodeJS.ProcessEnv;
	transport?: (token: string, host: string) => TelemetryTransport;
} = {}) {
	const env = options.env ?? process.env;
	const runtimePair = !!env.SIMRA_POSTHOG_PROJECT_TOKEN && !!env.SIMRA_POSTHOG_HOST;
	const token = runtimePair ? env.SIMRA_POSTHOG_PROJECT_TOKEN : bundledToken;
	const host = runtimePair ? env.SIMRA_POSTHOG_HOST : bundledHost;
	let client: TelemetryTransport | undefined;
	let id: string;
	let closed = false;
	let version = pkg.version;
	let source: "cli" | "agent" = "cli";
	let sessionId = randomUUID();
	const models = new Map<string, Set<string>>();
	const transport = options.transport ?? ((token, host) => new PostHog(token, {
		host, isServer: false, enableExceptionAutocapture: false, privacyMode: true, disableGeoip: true,
		disableRemoteConfig: true, disableSurveys: true, flushAt: 20, flushInterval: 10_000,
		requestTimeout: 1500, fetchRetryCount: 0, maxQueueSize: 500,
		// A user can revoke consent while another Simra process has events queued.
		fetch: (url, request) => configured()
			? fetch(url, request)
			: Promise.resolve(new Response('{"status":1}', { status: 200 })),
	}));
	function configured() { return !analyticsDisabled(env) && !!token && !!host; }
	return {
		enabled: configured,
		configure(context: { version?: string; source?: "cli" | "agent" }) {
			if (context.version && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(context.version)) version = context.version;
			if (context.source === "cli" || context.source === "agent") source = context.source;
		},
		/** Only call with the shipped public model catalog, never models.json or a provider's live catalog. */
		registerPublicModels(catalog: ReadonlyArray<{ provider: string; id: string }>) {
			for (const model of catalog) {
				if (!models.has(model.provider)) models.set(model.provider, new Set());
				models.get(model.provider)!.add(model.id);
			}
		},
		newSession() { closed = false; sessionId = randomUUID(); },
		capture<E extends TelemetryEvent>(event: E, properties: Properties<E> = {}, timestamp?: Date): void {
			if (closed || !configured() || !Object.hasOwn(schemas, event)) return;
			try {
				const safe: Record<string, Value> = {};
				for (const [key, rule] of Object.entries(schemas[event])) {
					const value = rule((properties as Record<string, unknown>)[key]);
					if (value !== undefined) safe[key] = value;
				}
				if (event === "$ai_generation" || event === "model_selected") {
					const provider = properties.$ai_provider ?? "";
					const model = properties.$ai_model ?? "";
					safe.$ai_provider = models.has(provider) ? provider : "custom";
					safe.$ai_model = models.get(provider)?.has(model) ? model : "custom";
				}
				if (!client) {
					client = transport(token!, host!);
					id = identity(env);
				}
				client.capture({ distinctId: id, event, timestamp, disableGeoip: true, properties: {
					...safe, schema_version: 1, simra_version: version, source, os: process.platform, arch: process.arch,
					$session_id: sessionId, $ai_session_id: sessionId, $process_person_profile: false, $geoip_disable: true, $ip: "",
				} });
			} catch {}
		},
		async shutdown(): Promise<void> {
			closed = true;
			// Drain once at the process/session boundary, never on each tool call.
			try { await client?.shutdown(2000); } catch {}
			client = undefined;
		},
	};
}

export type Telemetry = ReturnType<typeof createTelemetry>;
export const telemetry = createTelemetry();
