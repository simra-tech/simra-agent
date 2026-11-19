import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { analyticsDisabled, createTelemetry, getAnalyticsConsent, setAnalyticsConsent } from "../src/telemetry.ts";

const exec = promisify(execFile);

test("quoted home-relative settings paths use the same home as the launcher", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "simra-analytics-home-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [suffix, setting] of [["", "~"], ["custom", "~/custom"]]) {
		const home = join(root, suffix || "plain");
		const cwd = join(home, "workspace");
		mkdirSync(cwd, { recursive: true });
		const script = `import { setAnalyticsConsent, getAnalyticsConsent } from ${JSON.stringify(new URL("../src/telemetry.ts", import.meta.url).href)};
setAnalyticsConsent(true);
console.log(JSON.stringify(getAnalyticsConsent()));`;
		const result = await exec(process.execPath, ["--input-type=module", "-e", script], {
			cwd, env: { ...process.env, HOME: home, USERPROFILE: home, SIMRA_CODING_AGENT_DIR: setting },
		});
		assert.equal(JSON.parse(result.stdout), true);
		assert.equal(getAnalyticsConsent({ SIMRA_CODING_AGENT_DIR: join(home, suffix) }), true);
		assert.equal(existsSync(join(cwd, "~")), false);
	}
});

function fixture(t: any, extra: NodeJS.ProcessEnv = {}, consent: boolean | null = true) {
	const dir = mkdtempSync(join(tmpdir(), "simra-analytics-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const events: any[] = [];
	let clients = 0;
	let shutdowns = 0;
	const env = { SIMRA_POSTHOG_PROJECT_TOKEN: "phc_test", SIMRA_POSTHOG_HOST: "http://localhost", SIMRA_CODING_AGENT_DIR: join(dir, "state"), ...extra };
	if (consent !== null) setAnalyticsConsent(consent, env);
	const analytics = createTelemetry({ env, transport: () => {
		clients++;
		return { capture: (event) => events.push(event), shutdown: async () => { shutdowns++; } };
	} });
	return { analytics, env, dir, events, clients: () => clients, shutdowns: () => shutdowns };
}

test("runtime ingestion overrides require a Simra-specific token and host pair", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "simra-analytics-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const base = { SIMRA_CODING_AGENT_DIR: dir, POSTHOG_PROJECT_TOKEN: "phc_other_product", POSTHOG_HOST: "https://other-product.invalid" };
	setAnalyticsConsent(true, base);
	const configurations: string[][] = [];
	const make = (extra: NodeJS.ProcessEnv) => createTelemetry({ env: { ...base, ...extra }, transport: (token, host) => {
		configurations.push([token, host]);
		return { capture() {}, shutdown: async () => {} };
	} });
	for (const extra of [{}, { SIMRA_POSTHOG_PROJECT_TOKEN: "phc_simra" }, { SIMRA_POSTHOG_HOST: "https://simra.invalid" }]) {
		const analytics = make(extra);
		analytics.capture("setup_started");
		await analytics.shutdown();
	}
	assert.deepEqual(configurations, [], "unrelated or incomplete settings must not redirect telemetry");
	const analytics = make({ SIMRA_POSTHOG_PROJECT_TOKEN: "phc_simra", SIMRA_POSTHOG_HOST: "https://simra.invalid" });
	analytics.capture("setup_started");
	assert.deepEqual(configurations, [["phc_simra", "https://simra.invalid"]]);
	await analytics.shutdown();
});

test("analytics stays off without explicit saved consent, including legacy installs and invalid preferences", async (t) => {
	const f = fixture(t, {}, null);
	assert.equal(getAnalyticsConsent(f.env), undefined);
	assert.equal(f.analytics.enabled(), false);
	f.analytics.capture("setup_started");
	assert.equal(f.clients(), 0);
	assert.equal(existsSync(f.env.SIMRA_CODING_AGENT_DIR), false);
	// A previous opt-out release may have created an identifier without asking for consent.
	mkdirSync(f.env.SIMRA_CODING_AGENT_DIR);
	writeFileSync(join(f.env.SIMRA_CODING_AGENT_DIR, "analytics-id"), "00000000-0000-4000-8000-000000000001\n");
	for (const invalid of ["broken json", "null", '{"enabled":true}', '{"schema":"simra.analytics/1","enabled":"true"}']) {
		writeFileSync(join(f.env.SIMRA_CODING_AGENT_DIR, "analytics.json"), invalid);
		assert.equal(f.analytics.enabled(), false);
		f.analytics.capture("setup_started");
	}
	assert.equal(f.clients(), 0);
	setAnalyticsConsent(true, f.env);
	f.analytics.capture("setup_started");
	assert.equal(f.events.length, 1);
	setAnalyticsConsent(false, f.env);
	f.analytics.capture("setup_completed");
	assert.equal(f.events.length, 1);
	await f.analytics.shutdown();
});

test("opt-outs and missing configuration create no client or identifier; CI and headless remain eligible", async (t) => {
	for (const extra of [
		{ SIMRA_NO_ANALYTICS: "1" }, { DO_NOT_TRACK: "1" }, { SIMRA_NO_ANALYTICS: "true" },
		{ NODE_ENV: "test" }, { NODE_TEST_CONTEXT: "child-v8" }, { SIMRA_POSTHOG_PROJECT_TOKEN: "" }, { SIMRA_POSTHOG_HOST: "" },
	]) {
		const f = fixture(t, extra);
		assert.equal(f.analytics.enabled(), false);
		f.analytics.capture("session_started", { mode: "print" });
		await f.analytics.shutdown();
		assert.equal(f.clients(), 0);
		assert.equal(existsSync(join(f.env.SIMRA_CODING_AGENT_DIR, "analytics-id")), false);
	}
	const notOptedIn = fixture(t, { CI: "true" }, null);
	assert.equal(analyticsDisabled(notOptedIn.env), true);
	const f = fixture(t, { CI: "true" });
	assert.equal(analyticsDisabled(f.env), false);
	assert.equal(analyticsDisabled({ ...f.env, SIMRA_NO_ANALYTICS: "0", DO_NOT_TRACK: "false" }), false);
	f.analytics.capture("cli_started", { command: "list", headless: true });
	assert.equal(f.events[0].properties.headless, true);
	await f.analytics.shutdown();
});

test("allowlist drops content, nested payloads, custom names, invalid metrics and arbitrary events", async (t) => {
	const f = fixture(t);
	f.analytics.registerPublicModels([{ provider: "openai", id: "gpt-public" }]);
	f.analytics.capture("$ai_generation", {
		$ai_model: "private-design-model", $ai_provider: "private-design-provider", $ai_input_tokens: 20,
		$ai_output_tokens: NaN, $ai_latency: -1, $ai_input: "SECRET", $ai_output_choices: [{ text: "SECRET" }],
		error: "SECRET", path: "/SECRET/design.spice", $set: { name: "SECRET" },
	} as any);
	f.analytics.capture("$ai_span", { tool_name: "SECRET", $ai_span_name: "SECRET", result: "SECRET" } as any);
	f.analytics.capture("experiment_started", { adapter: "SECRET", operation: "SECRET", inputs: { deck: "SECRET" }, status: "pass", selected_requirement_count: 8 } as any);
	f.analytics.capture("SECRET" as any, { content: "SECRET" } as any);
	assert.equal(f.events.length, 3);
	assert.doesNotMatch(JSON.stringify(f.events), /SECRET|private-design|NaN|selected_requirement|"status"/);
	assert.equal(f.events[0].properties.$ai_model, "custom");
	assert.equal(f.events[0].properties.$ai_input_tokens, 20);
	assert.equal(f.events[0].properties.$ai_output_tokens, undefined);
	assert.equal(f.events[0].properties.$ai_latency, undefined);
	assert.equal(f.events[1].properties.tool_name, "custom");
	assert.equal(f.events[2].properties.adapter, "custom");
	assert.equal(f.events[0].properties.$process_person_profile, false);
	assert.equal(f.events[0].properties.$ip, "");
	await f.analytics.shutdown();
	assert.equal(f.shutdowns(), 1);
});

test("random install identity survives restarts and session identities change", async (t) => {
	const f = fixture(t);
	f.analytics.capture("session_started");
	const first = f.events[0];
	assert.equal(first.distinctId, readFileSync(join(f.env.SIMRA_CODING_AGENT_DIR, "analytics-id"), "utf8").trim());
	await f.analytics.shutdown();
	f.analytics.newSession();
	f.analytics.capture("session_started");
	assert.equal(f.events[1].distinctId, first.distinctId);
	assert.notEqual(f.events[1].properties.$session_id, first.properties.$session_id);
	await f.analytics.shutdown();
});

test("an empty or corrupt installation identifier is repaired and remains stable", async (t) => {
	for (const invalid of ["", "truncated-id"]) {
		const f = fixture(t);
		const file = join(f.env.SIMRA_CODING_AGENT_DIR, "analytics-id");
		writeFileSync(file, invalid);
		f.analytics.capture("setup_started");
		const id = f.events[0].distinctId;
		assert.equal(readFileSync(file, "utf8").trim(), id);
		await f.analytics.shutdown();
		f.analytics.newSession();
		f.analytics.capture("setup_started");
		assert.equal(f.events[1].distinctId, id);
		await f.analytics.shutdown();
	}
});

test("transport failures never escape into the calling design action", async (t) => {
	const f = fixture(t);
	const analytics = createTelemetry({ env: f.env, transport: () => ({
		capture() { throw new Error("SECRET failure"); }, shutdown: async () => { throw new Error("SECRET failure"); },
	}) });
	assert.doesNotThrow(() => analytics.capture("setup_started"));
	await assert.doesNotReject(() => analytics.shutdown());
});

test("short-lived CLI flushes real SDK payloads to a local server; opted-out CLI sends nothing", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "simra-analytics-http-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const requests: any[] = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks);
		requests.push({ url: req.url, payload: JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString()) });
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end('{"status":1}');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address() as { port: number };
	const env = { ...process.env, SIMRA_POSTHOG_PROJECT_TOKEN: "phc_test", SIMRA_POSTHOG_HOST: `http://127.0.0.1:${address.port}`, SIMRA_CODING_AGENT_DIR: join(dir, "state") };
	for (const name of ["SIMRA_NO_ANALYTICS", "DO_NOT_TRACK", "NODE_TEST_CONTEXT", "NODE_ENV"]) delete env[name];
	const cli = new URL("../src/cli.ts", import.meta.url).pathname;
	const command = process.env.SIMRA_BINARY ? resolve(process.env.SIMRA_BINARY) : process.execPath;
	const run = (args: string[], runEnv = env) => exec(command, [...(process.env.SIMRA_BINARY ? [] : [cli]), ...args], { cwd: dir, env: runEnv });
	await run(["list"]);
	assert.equal(requests.length, 0);
	assert.equal(existsSync(env.SIMRA_CODING_AGENT_DIR), false);
	assert.match((await run(["analytics", "status"])).stdout, /unset \(off by default\)/);
	assert.equal(existsSync(env.SIMRA_CODING_AGENT_DIR), false);
	await run(["analytics", "on"]);
	assert.equal(getAnalyticsConsent(env), true);
	assert.equal(existsSync(join(env.SIMRA_CODING_AGENT_DIR, "analytics-id")), false);
	assert.equal(requests.length, 0, "preference commands do not send analytics");
	await run(["list"]);
	const events = requests.flatMap((r) => r.payload.batch ?? []);
	assert.deepEqual(events.map((e: any) => e.event), ["cli_started", "cli_completed"]);
	assert.equal(events[0].properties.headless, true);
	assert.equal(events[0].properties.$process_person_profile, false);
	assert.equal(events[0].properties.$geoip_disable, true);
	assert.doesNotMatch(JSON.stringify(requests), new RegExp(dir));
	const before = requests.length;
	for (const optout of ["SIMRA_NO_ANALYTICS", "DO_NOT_TRACK"]) {
		const state = join(dir, optout);
		const optedOut = { ...env, [optout]: "1", SIMRA_CODING_AGENT_DIR: state };
		setAnalyticsConsent(true, optedOut);
		await run(["list"], optedOut);
		assert.equal(existsSync(join(state, "analytics-id")), false);
	}
	await run(["analytics", "off"]);
	assert.equal(getAnalyticsConsent(env), false);
	await run(["list"]);
	assert.equal(requests.length, before);
	// Positive control: this in-process SDK path really sends before testing revocation.
	setAnalyticsConsent(true, env);
	const control = createTelemetry({ env });
	control.capture("setup_started");
	await control.shutdown();
	assert.equal(requests.length, before + 1);
	// Revocation also stops batches queued in a process that is already running.
	const queued = createTelemetry({ env });
	queued.capture("setup_started");
	await new Promise((resolve) => setImmediate(resolve));
	setAnalyticsConsent(false, env);
	await queued.shutdown();
	assert.equal(requests.length, before + 1);
});
