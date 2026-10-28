// Execution environments. An environment turns an adapter command into a process command line.
// "local" runs the adapter on this host. "container" runs it in a container image with podman or docker.
// In a container, the design root and the adapter directory are mounted at their host paths, so paths stay the same.

import { execFileSync } from "node:child_process";
import type { ContainerEngine, EnvironmentConfig } from "./config.ts";

export interface Invocation {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	/** Facts recorded in experiment.json. */
	record: Record<string, unknown>;
}

export interface InvocationRequest {
	name: string;
	config: EnvironmentConfig;
	root: string;
	adapterDir: string;
	adapterCommand: string[];
	experimentId: string;
}

export function containerImageId(engine: ContainerEngine, image: string): string {
	const id = execFileSync(engine, ["image", "inspect", "--format", "{{.Id}}", image], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	return id.startsWith("sha256:") ? id : `sha256:${id}`;
}

/**
 * The user in the container. Rootless podman maps container root to the host user.
 * Docker does not, so docker runs as the host user: then files in the design root keep the user's ownership.
 */
export function containerUser(engine: ContainerEngine): string {
	if (engine === "podman") return "0:0";
	return `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
}

export function buildInvocation(req: InvocationRequest): Invocation {
	const { config } = req;
	const pin = config.cpus ? ["taskset", "-c", config.cpus] : [];
	const env = config.env ?? {};

	if (config.kind === "local") {
		const argv = [...pin, ...req.adapterCommand];
		return {
			command: argv[0],
			args: argv.slice(1),
			env: { ...process.env, ...env },
			record: { name: req.name, kind: "local", cpus: config.cpus ?? null, env },
		};
	}

	if (config.kind === "container") {
		const engine = config.engine ?? "podman";
		if (engine !== "podman" && engine !== "docker") throw new Error(`environment "${req.name}": unknown engine "${engine}"`);
		if (!config.image) throw new Error(`environment "${req.name}": container needs "image"`);
		const imageId = containerImageId(engine, config.image);
		if (config.image_id && config.image_id !== imageId) {
			throw new Error(`environment "${req.name}": image ${config.image} is ${imageId}, expected ${config.image_id}`);
		}
		const args = [
			"run",
			"--rm",
			"--network",
			"none",
			"--pull",
			"never",
			"-u",
			containerUser(engine),
			"--label",
			`simra.experiment=${req.experimentId}`,
			...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
			"-v",
			`${req.root}:${req.root}`,
			"-v",
			`${req.adapterDir}:${req.adapterDir}:ro`,
			"-w",
			req.root,
			imageId,
			...pin,
			...req.adapterCommand,
		];
		return {
			command: engine,
			args,
			env: process.env,
			record: { name: req.name, kind: "container", engine, image: config.image, image_id: imageId, cpus: config.cpus ?? null, env },
		};
	}

	throw new Error(`environment "${req.name}": unknown kind "${(config as { kind: string }).kind}"`);
}
