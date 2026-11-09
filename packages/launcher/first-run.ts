// The first start in a terminal: a welcome and an API key login (no browser, so it works over SSH), before pi starts.

import { ANALYTICS_NOTICE, analyticsOptedOut, getAnalyticsConsent, setAnalyticsConsent, telemetry } from "@simra-tech/kernel/telemetry";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { showStartupInput, showStartupSelector } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/startup-ui.js";
import { AuthStorage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

const SUGGESTIONS = [
	{ label: "DeepSeek V4.1 Flash: low cost, reads images", provider: "deepseek", model: "deepseek-flash", keys: "https://platform.deepseek.com/api_keys" },
	{ label: "GPT-6.1 Sol: stronger", provider: "openai", model: "gpt-6.1-sol", keys: "https://platform.openai.com/api-keys" },
];

/** Ask before any setup event. Existing model settings or an old analytics identifier are not consent. */
export async function askAnalyticsConsent(agentDir: string, options: {
	env?: NodeJS.ProcessEnv;
	select?: () => Promise<boolean | undefined>;
} = {}): Promise<void> {
	const env = { ...(options.env ?? process.env), SIMRA_CODING_AGENT_DIR: agentDir };
	if (analyticsOptedOut(env) || getAnalyticsConsent(env) !== undefined) return;
	const select = options.select ?? (() => showStartupSelector(
		SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false }), ANALYTICS_NOTICE, [
			{ label: "Keep analytics off", value: false },
			{ label: "Share usage metadata", value: true },
		],
	));
	try {
		const choice = await select();
		// Escape has the same safe outcome as choosing off, and avoids another prompt on the next launch.
		setAnalyticsConsent(choice === true, env);
	} catch {
		console.error("Could not complete analytics setup. Analytics stays off.");
	}
}

/** No settings (pi writes them at its first start), no credential, no models.json and no provider key in the env. */
export function isFirstRun(agentDir: string): boolean {
	if (["settings.json", "models.json"].some((file) => existsSync(join(agentDir, file)))) return false;
	try {
		if (Object.keys(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))).length > 0) return false;
	} catch {}
	return !Object.entries(process.env).some(([name, value]) => name.endsWith("_API_KEY") && value);
}

export async function firstRun(agentDir: string): Promise<void> {
	telemetry.capture("setup_started");
	try {
		const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
		const choice = await showStartupSelector(settings, "Welcome to Simra, a chip-design agent. Choose a model:", [
			...SUGGESTIONS.map((s) => ({ label: s.label, value: s })),
			{ label: "Another provider or a subscription: log in later with /login", value: undefined },
		]);
		if (!choice) { telemetry.capture("setup_completed", { outcome: "deferred" }); return; }
		const key = (await showStartupInput(settings, `${choice.label}. Paste an API key from ${choice.keys}:`))?.trim();
		if (!key) { telemetry.capture("setup_completed", { outcome: "cancelled" }); return; }
		await AuthStorage.create(join(agentDir, "auth.json")).modify(choice.provider, async () => ({ type: "api_key", key }));
		settings.setDefaultModelAndProvider(choice.provider, choice.model);
		await settings.flush();
		telemetry.capture("setup_completed", { outcome: "configured", provider: choice.provider });
	} catch (error) {
		telemetry.capture("setup_completed", { outcome: "error" });
		throw error;
	}
}
