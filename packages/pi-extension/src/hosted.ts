import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

const DEFAULT_ORIGIN = "https://chipoai--flowfoundry-server-server-serve.modal.run";
const PROVIDER = "simra";
const MODEL = "simra-hosted";
const VERSION = "hosted-1";
const RECORDING = "Simra-funded · hosted requests and tool results recorded";
const NOTICE =
	"Simra pays for this model. Prompts and tool outputs go to Simra and can go to its model provider. Commercial tools can return licensed foundry rules, layer names or limits. Use hosted inference only when you are authorized to share all of that material. Simra retains hosted requests and responses, including the tool results sent to the model, for staff review and evaluation creation with no automatic expiry. For confidential work, select your own inference. You can request removal of a trace and its linked evaluations. Project instructions and files read in this work directory can enter the model context.";
const START = "Run simra hosted to start a fresh recorded session in an authorized work directory.";

function service() {
	const url = new URL(process.env.SIMRA_FLOW_URL || DEFAULT_ORIGIN);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw Error("Invalid Simra service origin");
	return url.origin + "/pilot";
}

async function call(path: string, token?: string, data?: object, signal?: AbortSignal) {
	const response = await fetch(service() + path, {
		method: data ? "POST" : "GET",
		redirect: "error",
		headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json" } : {}) },
		body: data ? JSON.stringify(data) : undefined,
		signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
	}).catch((error) => {
		if (signal?.aborted) throw error;
		throw Error("Simra service unavailable. Retry or choose your own provider.");
	});
	if (response.status >= 500) throw Error("Simra service unavailable. Retry or choose your own provider.");
	// A proxy or a wrong SIMRA_FLOW_URL can answer with a page instead of JSON.
	const result = await response.json().catch((error) => {
		if (signal?.aborted) throw error;
		return undefined;
	});
	if (result === undefined)
		throw Error(`${new URL(service()).origin} gave no Simra answer (HTTP ${response.status}). Check the proxy settings or SIMRA_FLOW_URL.`);
	if (!response.ok)
		throw Error(typeof result?.detail === "string" ? result.detail : "Simra authorization failed or expired. Retry /login simra.");
	return result;
}

function stored(result: { access: string; refresh: string; expires_in: number; inference: boolean }): OAuthCredentials {
	if (typeof result.access !== "string" || typeof result.refresh !== "string" || !(result.expires_in > 0))
		throw Error("Invalid Simra credentials");
	return {
		access: result.access,
		refresh: result.refresh,
		expires: Date.now() + (result.expires_in - 30) * 1000,
		service: service(),
		inference: result.inference === true,
	};
}

function checkIssuer(credentials: OAuthCredentials) {
	if (credentials.service !== service()) throw Error("Simra service changed. Sign in again.");
}

export const simraOAuth = {
	name: "Sign in with Simra",
	async login(callbacks: OAuthLoginCallbacks) {
		const email = (await callbacks.onPrompt({ message: "Invited email" })).trim();
		if (!email) throw Error("Simra login cancelled");
		const device = await call("/device", undefined, { email }, callbacks.signal);
		callbacks.onDeviceCode({
			userCode: device.user_code,
			verificationUri: service() + "/verify",
			intervalSeconds: device.interval,
			expiresInSeconds: device.expires_in,
		});
		const signal = AbortSignal.any([AbortSignal.timeout(device.expires_in * 1000), ...(callbacks.signal ? [callbacks.signal] : [])]);
		while (true) {
			await sleep(device.interval * 1000, undefined, { signal });
			const token = await call("/token", undefined, { credential: device.device_code }, signal);
			if (token.status === "pending") continue;
			return stored(token);
		}
	},
	async refreshToken(credentials: OAuthCredentials, signal: AbortSignal) {
		checkIssuer(credentials);
		return stored(await call("/token", undefined, { credential: credentials.refresh, refresh: true }, signal));
	},
	getApiKey(credentials: OAuthCredentials) {
		checkIssuer(credentials);
		return credentials.access;
	},
};

export function registerHosted(pi: ExtensionAPI, freshId?: string) {
	let active: string | undefined;
	let generation = 0;
	let resolvingAccount = false;
	async function accountKey(ctx: ExtensionContext) {
		resolvingAccount = true;
		try {
			return await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
		} finally {
			resolvingAccount = false;
		}
	}
	const display = (ctx: ExtensionContext, hosted: boolean) => {
		ctx.ui.setStatus("simra-hosted", hosted ? RECORDING : undefined);
	};
	function clear(ctx: ExtensionContext) {
		generation++;
		active = undefined;
		display(ctx, false);
	}
	pi.registerProvider(PROVIDER, {
		name: "Simra",
		oauth: {
			...simraOAuth,
			modifyModels(models, credential) {
				return credential.inference === false ? [] : models;
			},
			refreshToken(credentials, signal) {
				if (!active && !resolvingAccount && !freshId) throw Error(START);
				return simraOAuth.refreshToken(credentials, signal);
			},
		},
		// Pi requires a catalog URL. The transport validates the configured origin on hosted use.
		baseUrl: DEFAULT_ORIGIN + "/pilot/v1",
		api: "simra-hosted-chat",
		models: [
			{
				id: MODEL,
				name: "Simra-funded (recorded)",
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 65536,
				maxTokens: 4096,
			},
		],
		streamSimple(model, context, options) {
			const id = options?.sessionId;
			function check() {
				if (!id || active !== id || model.provider !== PROVIDER || model.id !== MODEL) throw Error(START);
			}
			// Guard the actual transport. Pi catches exceptions from extension event handlers.
			// No context, tools or headers go to Flow until this session passes preflight.
			check();
			return streamSimple({ ...model, api: "openai-completions", baseUrl: service() + "/v1" } as Model<"openai-completions">, context, {
				...options,
				maxRetries: 0,
				headers: { ...options?.headers, "x-session-id": id || "" },
				onPayload: async (payload, m) => {
					check();
					await call("/preflight", options?.apiKey, undefined, options?.signal);
					check();
					return options?.onPayload?.(payload, m);
				},
				fetch: async (input, init) => {
					check();
					return fetch(input, { ...init, redirect: "error" });
				},
			});
		},
	});
	pi.on("session_start", async (event, ctx) => {
		clear(ctx);
		const candidate = freshId;
		const startingGeneration = generation;
		freshId = undefined;
		// pi starts a plain session on the Simra model when it is the only one with a login: say how hosted use starts.
		if (!candidate && ctx.model?.provider === PROVIDER && ctx.hasUI) ctx.ui.notify(START, "info");
		if (
			!candidate ||
			event.reason !== "startup" ||
			ctx.sessionManager.getSessionId() !== candidate ||
			ctx.model?.provider !== PROVIDER ||
			ctx.sessionManager.getHeader()?.parentSession ||
			ctx.sessionManager.getEntries().some((e) => !["model_change", "thinking_level_change"].includes(e.type))
		)
			return;
		const key = await accountKey(ctx);
		if (!key) throw Error("Use /login simra first");
		const grants = await call("/grants", key);
		if (!grants.inference) throw Error("No hosted inference grant");
		if (!grants.accepted) {
			if (!ctx.hasUI || !(await ctx.ui.confirm("Accept hosted use?", NOTICE))) {
				console.error("Hosted notice acceptance required. Run simra hosted interactively.");
				return;
			}
			await call("/accept", key, { version: VERSION });
		}
		await call("/preflight", key);
		if (generation !== startingGeneration) return;
		active = candidate;
		display(ctx, true);
		console.error(RECORDING + ". Project instructions and files read here can enter model context.");
	});
	pi.on("model_select", (event, ctx) => {
		if (event.model.provider !== PROVIDER) {
			const wasRecording = Boolean(active);
			clear(ctx);
			if (wasRecording) ctx.ui.setStatus("simra-hosted", event.model.provider + " · hosted recording off");
		} else if (!active && ctx.hasUI) ctx.ui.notify(START, "info");
	});
	pi.on("session_shutdown", (_event, ctx) => clear(ctx));
	pi.registerCommand("simra-account", {
		description: "Show Simra invitation grants",
		handler: async (_args, ctx) => {
			const key = await accountKey(ctx);
			if (!key) return ctx.ui.notify("Use /login simra", "info");
			const g = await call("/grants", key);
			ctx.ui.notify(
				`Hosted inference: ${g.inference ? "granted. " + START : "off"}. Private installer: ${g.connectors ? "granted" : "off"}.`,
				"info",
			);
		},
	});
}
