// Project configuration: <root>/simra.config.json, then <root>/simra.local.json on top of it.
// simra.local.json holds machine-specific values (image tag, CPU set). Do not commit it.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readJson } from "./records.ts";

export type ContainerEngine = "podman" | "docker";

export interface EnvironmentConfig {
	kind: "local" | "container";
	/** container: the engine that runs the image (default "podman"). */
	engine?: ContainerEngine;
	/** container: image reference. */
	image?: string;
	/** container: expected image ID (sha256:...). The run stops if the local image differs. */
	image_id?: string;
	/** CPU list for taskset, for example "121-123,127". */
	cpus?: string;
	/** Environment variables for the adapter process. */
	env?: Record<string, string>;
}

export interface SimraConfig {
	environments: Record<string, EnvironmentConfig>;
	/** Extra directories that contain adapters (each adapter is a subdirectory with adapter.json). */
	adapter_dirs?: string[];
}

export const CONFIG_FILE = "simra.config.json";
export const LOCAL_CONFIG_FILE = "simra.local.json";

/** The design root is the nearest directory (from start upward) that has simra.config.json. */
export function findRoot(start: string): string | null {
	let dir = resolve(start);
	for (;;) {
		if (existsSync(join(dir, CONFIG_FILE))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function loadConfig(root: string): SimraConfig {
	const config: SimraConfig = { environments: { local: { kind: "local" } } };
	for (const name of [CONFIG_FILE, LOCAL_CONFIG_FILE]) {
		const path = join(root, name);
		if (!existsSync(path)) continue;
		const part = readJson<Partial<SimraConfig>>(path);
		for (const [envName, env] of Object.entries(part.environments ?? {})) {
			config.environments[envName] = { ...config.environments[envName], ...env } as EnvironmentConfig;
		}
		if (part.adapter_dirs) {
			config.adapter_dirs = [...(config.adapter_dirs ?? []), ...part.adapter_dirs.map((d) => resolve(root, d))];
		}
	}
	return config;
}
