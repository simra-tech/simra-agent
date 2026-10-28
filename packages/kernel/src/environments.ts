// Execution environments. An environment turns an adapter command into a process command line.
// "local" runs the adapter on this host. "podman" runs it in a container image.
// In podman, the design root and the adapter directory are mounted at their host paths, so paths stay the same.

import { execFileSync } from "node:child_process";
import type { EnvironmentConfig } from "./config.ts";

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

export function podmanImageId(image: string): string {
	const id = execFileSync("podman", ["image", "inspect", "--format", "{{.Id}}", image], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
	return id.startsWith("sha256:") ? id : `sha256:${id}`;
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

	if (config.kind === "podman") {
		if (!config.image) throw new Error(`environment "${req.name}": podman needs "image"`);
		const imageId = podmanImageId(config.image);
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
			// Rootless podman maps container root to the host user, so files keep the user's ownership.
			"-u",
			"0:0",
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
			command: "podman",
			args,
			env: process.env,
			record: { name: req.name, kind: "podman", image: config.image, image_id: imageId, cpus: config.cpus ?? null, env },
		};
	}

	throw new Error(`environment "${req.name}": unknown kind "${(config as { kind: string }).kind}"`);
}
