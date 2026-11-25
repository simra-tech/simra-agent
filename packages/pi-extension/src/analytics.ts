import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { telemetry, type Telemetry } from "@simra-tech/kernel/telemetry";

/** Observe lifecycle metadata only. Never capture entire pi events or walk message content. */
export function registerAnalytics(pi: ExtensionAPI, analytics: Telemetry = telemetry): void {
	analytics.registerPublicModels(getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider)));
	let sessionStart = Date.now();
	let trace: { id: string; start: number; error: boolean } | undefined;
	let generation: string | undefined;
	const tools = new Map<string, { id: string; parent: string; start: number }>();
	pi.on("session_start", (event, ctx) => {
		analytics.configure({ source: "agent" });
		analytics.newSession();
		sessionStart = Date.now();
		analytics.capture("session_started", { reason: event.reason, mode: ctx.mode });
		if (ctx.model) analytics.capture("model_selected", { source: "startup", $ai_provider: ctx.model.provider, $ai_model: ctx.model.id });
	});
	pi.on("model_select", (event) => {
		analytics.capture("model_selected", { source: event.source, $ai_provider: event.model.provider, $ai_model: event.model.id });
	});
	pi.on("agent_start", () => {
		trace = { id: randomUUID(), start: Date.now(), error: false };
		generation = undefined;
		tools.clear();
	});
	pi.on("message_end", (event) => {
		const message = event.message;
		if (!trace || message.role !== "assistant" || message.stopReason === "pending") return;
		generation = randomUUID();
		const error = message.stopReason === "error" || message.stopReason === "aborted";
		trace.error ||= error;
		// pi normalizes all providers' input counts to exclude cache reads/writes.
		analytics.capture("$ai_generation", {
			$ai_trace_id: trace.id, $ai_span_id: generation, $ai_parent_id: trace.id,
			$ai_model: message.model, $ai_provider: message.provider,
			$ai_input_tokens: message.usage?.input, $ai_output_tokens: message.usage?.output,
			$ai_cache_read_input_tokens: message.usage?.cacheRead, $ai_cache_creation_input_tokens: message.usage?.cacheWrite,
			$ai_reasoning_tokens: message.usage?.reasoning, $ai_cache_reporting_exclusive: true,
			$ai_total_cost_usd: message.usage?.cost?.total, cost_is_estimate: !message.usage?.cost?.totalFromProvider,
			$ai_latency: message.durationMs === undefined ? undefined : message.durationMs / 1000,
			$ai_is_error: error, stop_reason: message.stopReason,
		}, new Date(message.timestamp));
	});
	pi.on("tool_execution_start", (event) => {
		if (!trace) return;
		tools.set(event.toolCallId, {
			id: randomUUID(), start: Date.now(),
			parent: (event.parentToolCallId && tools.get(event.parentToolCallId)?.id) || generation || trace.id,
		});
	});
	pi.on("tool_execution_end", (event) => {
		const call = tools.get(event.toolCallId);
		if (!trace || !call) return;
		trace.error ||= event.isError;
		analytics.capture("$ai_span", {
			$ai_trace_id: trace.id, $ai_span_id: call.id, $ai_parent_id: call.parent,
			$ai_span_name: event.toolName, tool_name: event.toolName,
			$ai_latency: (event.durationMs ?? Date.now() - call.start) / 1000, $ai_is_error: event.isError,
		}, new Date(call.start));
		tools.delete(event.toolCallId);
	});
	function endTrace(aborted = false) {
		if (!trace) return;
		analytics.capture("$ai_trace", {
			$ai_trace_id: trace.id, $ai_span_id: trace.id, $ai_span_name: "agent_run",
			$ai_latency: (Date.now() - trace.start) / 1000, $ai_is_error: trace.error || aborted,
		}, new Date(trace.start));
		trace = undefined;
		tools.clear();
	}
	pi.on("agent_end", () => endTrace());
	pi.on("session_shutdown", async () => {
		endTrace(true);
		analytics.capture("session_ended", { duration_ms: Date.now() - sessionStart });
		await analytics.shutdown();
	});
}
