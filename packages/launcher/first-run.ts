// The first start of simra in a terminal: a short welcome and a login with an API key, before pi starts. pi's own
// first-run setup does not run for a rebrand. The login asks for a key and needs no browser, so it works over SSH.
// /login in simra has the other providers and the subscriptions.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { showStartupInput, showStartupSelector } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/startup-ui.js";
import { AuthStorage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";

/** A low-cost model that reads images (for example the page images of a PDF), and a stronger model. */
const SUGGESTIONS = [
	{ label: "DeepSeek V4.1 Flash: low cost, reads images", provider: "deepseek", model: "deepseek-flash", keys: "https://platform.deepseek.com/api_keys" },
	{ label: "GPT-6.1 Sol: stronger", provider: "openai", model: "gpt-6.1-sol", keys: "https://platform.openai.com/api-keys" },
];

/** A first run: pi has no settings, logins or model configuration yet, and no provider key is in the environment. */
export function isFirstRun(agentDir: string): boolean {
	if (["settings.json", "auth.json", "models.json"].some((file) => existsSync(join(agentDir, file)))) return false;
	return !Object.entries(process.env).some(([name, value]) => name.endsWith("_API_KEY") && value);
}

/** The welcome and the login. It saves the key in auth.json and the model as the default model. */
export async function firstRun(agentDir: string): Promise<void> {
	const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
	const choice = await showStartupSelector(settings, "Welcome to Simra, a chip-design agent. Choose a model:", [
		...SUGGESTIONS.map((s) => ({ label: s.label, value: s })),
		{ label: "Another provider or a subscription: log in later with /login", value: undefined },
	]);
	if (!choice) return;
	const key = (await showStartupInput(settings, `${choice.label}. Paste an API key from ${choice.keys}:`))?.trim();
	if (!key) return;
	await AuthStorage.create(join(agentDir, "auth.json")).modify(choice.provider, async () => ({ type: "api_key", key }));
	settings.setDefaultModelAndProvider(choice.provider, choice.model);
	await settings.flush();
}
