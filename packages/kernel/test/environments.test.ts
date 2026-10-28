import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { buildInvocation } from "../src/environments.ts";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

/** Fake podman and docker on PATH: "image inspect" prints IMAGE_ID. */
function fakeEngines(t: { after: (fn: () => void) => void }): void {
	const bin = mkdtempSync(join(tmpdir(), "simra-engines-"));
	for (const engine of ["podman", "docker"]) {
		writeFileSync(join(bin, engine), `#!/bin/sh\n[ "$1 $2" = "image inspect" ] && echo ${IMAGE_ID}\n`);
		chmodSync(join(bin, engine), 0o755);
	}
	const path = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${path}`;
	t.after(() => {
		process.env.PATH = path;
		rmSync(bin, { recursive: true, force: true });
	});
}

const request = (config: object) => ({
	name: "eda",
	config: { kind: "container", image: "eda:1", cpus: "0-1", env: { HOME: "/tmp" }, ...config } as never,
	root: "/designs/ota",
	adapterDir: "/adapters/ngspice",
	adapterCommand: ["python3", "/adapters/ngspice/adapter.py", "request.json"],
	experimentId: "e1",
});

test("a container environment runs podman as container root by default", (t) => {
	fakeEngines(t);
	const inv = buildInvocation(request({}));
	assert.equal(inv.command, "podman");
	assert.deepEqual(inv.args.slice(inv.args.indexOf("-u"), inv.args.indexOf("-u") + 2), ["-u", "0:0"]);
	assert.deepEqual(inv.args.slice(inv.args.indexOf(IMAGE_ID)), [IMAGE_ID, "taskset", "-c", "0-1", ...request({}).adapterCommand]);
	assert.ok(inv.args.includes("/designs/ota:/designs/ota") && inv.args.includes("/adapters/ngspice:/adapters/ngspice:ro"));
	assert.deepEqual(inv.record, { name: "eda", kind: "container", engine: "podman", image: "eda:1", image_id: IMAGE_ID, cpus: "0-1", env: { HOME: "/tmp" } });
});

test("docker runs as the host user, so files keep the user's ownership", (t) => {
	fakeEngines(t);
	const inv = buildInvocation(request({ engine: "docker" }));
	assert.equal(inv.command, "docker");
	assert.equal(inv.args[inv.args.indexOf("-u") + 1], `${process.getuid?.()}:${process.getgid?.()}`);
	assert.equal(inv.record.engine, "docker");
});

test("a container environment checks the image ID and the engine", (t) => {
	fakeEngines(t);
	assert.throws(() => buildInvocation(request({ image_id: `sha256:${"b".repeat(64)}` })), /expected sha256:b/);
	assert.throws(() => buildInvocation(request({ engine: "nerdctl" })), /unknown engine "nerdctl"/);
	assert.throws(() => buildInvocation(request({ image: undefined })), /needs "image"/);
});
