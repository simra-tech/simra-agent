import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTelemetry, setAnalyticsConsent } from "@simra-tech/kernel/telemetry";
import { registerAnalytics } from "../src/analytics.ts";

test("pi lifecycle produces linked native PostHog traces, generations and tool spans without design content", async (t) => {
	const state = mkdtempSync(join(tmpdir(), "simra-agent-analytics-"));
	t.after(() => rmSync(state, { recursive: true, force: true }));
	const events: any[] = [];
	let shutdowns = 0;
	setAnalyticsConsent(true, { SIMRA_CODING_AGENT_DIR: state });
	const analytics = createTelemetry({ env: { SIMRA_POSTHOG_PROJECT_TOKEN: "phc_test", SIMRA_POSTHOG_HOST: "http://localhost", SIMRA_CODING_AGENT_DIR: state },
		transport: () => ({ capture: (e) => events.push(e), shutdown: async () => { shutdowns++; } }) });
	const hooks = new Map<string, Function>();
	registerAnalytics({ on: (name: string, handler: Function) => hooks.set(name, handler) } as any, analytics);
	const emit = async (name: string, event: any = {}, ctx: any = {}) => hooks.get(name)!(event, ctx);
	const model = { provider: "openai", id: "gpt-6.1-sol", baseUrl: "https://SECRET/api" };
	await emit("session_start", { reason: "startup", previousSessionFile: "/SECRET/session" }, { mode: "print", model });
	await emit("model_select", { model, source: "set" });
	await emit("agent_start");
	await emit("message_end", { message: { role: "user", content: "SECRET user design" } });
	await emit("message_end", { message: {
		role: "assistant", provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 1000, durationMs: 500,
		content: [{ type: "toolCall", id: "SECRET-call", name: "bash", arguments: { command: "cat SECRET.spice" } }],
		usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 5, cost: { total: 0.002 } },
	} });
	await emit("tool_execution_start", { toolName: "bash", toolCallId: "SECRET-call", args: { command: "cat SECRET.spice" } });
	await emit("tool_execution_start", { toolName: "SECRET-plugin", toolCallId: "SECRET-nested", parentToolCallId: "SECRET-call", args: { secret: "SECRET" } });
	await emit("tool_execution_end", { toolName: "SECRET-plugin", toolCallId: "SECRET-nested", result: "SECRET output", isError: true, durationMs: 50 });
	await emit("tool_execution_end", { toolName: "bash", toolCallId: "SECRET-call", result: "SECRET output", isError: false, durationMs: 100 });
	await emit("agent_end", { messages: [{ content: "SECRET response", errorMessage: "SECRET error" }] });
	await emit("session_shutdown");
	assert.doesNotMatch(JSON.stringify(events), /SECRET|baseUrl|errorMessage|content|arguments/);
	const generation = events.find((e) => e.event === "$ai_generation");
	assert.equal(generation.properties.$ai_model, model.id);
	assert.equal(generation.properties.$ai_input_tokens, 100);
	assert.equal(generation.properties.$ai_cache_read_input_tokens, 30);
	assert.equal(generation.properties.$ai_cache_reporting_exclusive, true);
	assert.equal(generation.properties.$ai_latency, 0.5);
	assert.equal(generation.properties.cost_is_estimate, true);
	assert.equal(generation.timestamp.getTime(), 1000);
	const spans = events.filter((e) => e.event === "$ai_span");
	assert.equal(spans[0].properties.tool_name, "custom");
	assert.equal(spans[0].properties.$ai_parent_id, spans[1].properties.$ai_span_id);
	assert.equal(spans[1].properties.$ai_parent_id, generation.properties.$ai_span_id);
	const trace = events.find((e) => e.event === "$ai_trace");
	assert.equal(trace.properties.$ai_trace_id, generation.properties.$ai_trace_id);
	assert.equal(trace.properties.$ai_is_error, true);
	assert.equal(shutdowns, 1);
	// A session replacement must reopen analytics after shutdown.
	await emit("session_start", { reason: "new" }, { mode: "rpc", model });
	assert.equal(events.filter((e) => e.event === "session_started").length, 2);
	await emit("session_shutdown");
});
