import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAnalyticsConsent, setAnalyticsConsent } from "@simra-tech/kernel/telemetry";
import { askAnalyticsConsent } from "../first-run.ts";

test("a broken analytics prompt does not block startup or log its error content", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "simra-consent-failure-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "agent");
	const messages: string[] = [];
	t.mock.method(console, "error", (...parts: unknown[]) => messages.push(parts.join(" ")));
	await assert.doesNotReject(() => askAnalyticsConsent(dir, { env: {}, select: async () => { throw new Error("PRIVATE-DESIGN-CONTENT"); } }));
	assert.equal(getAnalyticsConsent({ SIMRA_CODING_AGENT_DIR: dir }), undefined);
	assert.equal(existsSync(dir), false);
	assert.equal(messages.length, 1);
	assert.doesNotMatch(messages[0], /PRIVATE-DESIGN-CONTENT/);
});

test("first-run consent is explicit; declining or Escape saves off without creating an analytics identity", async (t) => {
	for (const choice of [true, false, undefined]) {
		const root = mkdtempSync(join(tmpdir(), "simra-consent-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const dir = join(root, "agent");
		let prompts = 0;
		const select = async () => { prompts++; return choice; };
		await askAnalyticsConsent(dir, { env: {}, select });
		assert.equal(getAnalyticsConsent({ SIMRA_CODING_AGENT_DIR: dir }), choice === true);
		assert.equal(existsSync(join(dir, "analytics-id")), false);
		await askAnalyticsConsent(dir, { env: {}, select });
		assert.equal(prompts, 1, "a saved choice must not be asked again");
	}
});

test("environment opt-outs skip the consent prompt even when opt-in was previously saved", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "simra-consent-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const env of [{ SIMRA_NO_ANALYTICS: "1" }, { DO_NOT_TRACK: "1" }, { NODE_ENV: "test" }, { NODE_TEST_CONTEXT: "child-v8" }]) {
		await askAnalyticsConsent(dir, { env, select: async () => { assert.fail("must not prompt"); } });
		assert.equal(existsSync(join(dir, "analytics.json")), false);
	}
	setAnalyticsConsent(true, { SIMRA_CODING_AGENT_DIR: dir });
	await askAnalyticsConsent(dir, { env: { SIMRA_NO_ANALYTICS: "1" }, select: async () => { assert.fail("must not prompt"); } });
	assert.equal(getAnalyticsConsent({ SIMRA_CODING_AGENT_DIR: dir }), true, "an environment override must not rewrite saved preference");
});
