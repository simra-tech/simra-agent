import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runExperiment } from "@simra-tech/kernel";
import { installConnectors, installedConnectors } from "../../pi-extension/src/connectors.ts";
import { selfUpdate } from "../update.ts";

// The connector bundle against a fake Simra service: install, update, rollback, a broken download, the grant, and the
// token refresh of two processes at once.

const fixtures = new URL("../../kernel/test/fixtures", import.meta.url).pathname;
const updateModule = new URL("../update.ts", import.meta.url).pathname;

function bundle(dir: string, version: string): { data: Buffer; sha256: string } {
	const stage = mkdtempSync(join(dir, `stage-${version}-`));
	cpSync(join(fixtures, "adapters", "fake"), join(stage, "adapters", "fake"), { recursive: true });
	cpSync(join(fixtures, "technologies"), join(stage, "technologies"), { recursive: true });
	writeFileSync(join(stage, "bundle.json"), JSON.stringify({ name: "simra-connectors", version }));
	const data = spawnSync("tar", ["-czf", "-", "-C", stage, "bundle.json", "adapters", "technologies"]).stdout;
	return { data, sha256: createHash("sha256").update(data).digest("hex") };
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
	const dir = mkdtempSync(join(tmpdir(), "simra-connectors-"));
	const state = { served: bundle(dir, "1.0.0"), version: "1.0.0", connectors: true, corrupt: false, downloads: 0, refreshes: 0, used: new Set<string>(), refresh: "simra-rt-0", script: "exit 0" };
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		res.setHeader("Content-Type", "application/json");
		const auth = req.headers.authorization ?? "";
		if (req.url === "/releases/latest/download/install.sh") return res.end(state.script);
		if (req.url === "/pilot/token") {
			// Slow, so that two processes overlap.
			await new Promise((r) => setTimeout(r, 300));
			const { credential } = JSON.parse(body);
			if (credential !== state.refresh || state.used.has(credential)) return res.writeHead(403).end(JSON.stringify({ status: "invalid" }));
			state.used.add(credential);
			state.refreshes++;
			state.refresh = `simra-rt-${state.refreshes}`;
			return res.end(JSON.stringify({ status: "ok", access: `simra-at-${state.refreshes}`, refresh: state.refresh, expires_in: 900, inference: false }));
		}
		if (!auth.startsWith("Bearer simra-at-")) return res.writeHead(401).end(JSON.stringify({ detail: "Sign in with Simra" }));
		if (req.url === "/pilot/grants") return res.end(JSON.stringify({ inference: false, connectors: state.connectors }));
		if (req.url === "/pilot/connectors") return res.end(JSON.stringify({ version: state.version, sha256: state.served.sha256, bytes: state.served.data.length }));
		if (req.url === "/pilot/connectors/bundle") {
			state.downloads++;
			res.setHeader("Content-Type", "application/gzip");
			return res.end(state.corrupt ? state.served.data.subarray(0, 100) : state.served.data);
		}
		res.writeHead(404).end("{}");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const saved = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, SIMRA_FLOW_URL: process.env.SIMRA_FLOW_URL, SIMRA_CODING_AGENT_DIR: process.env.SIMRA_CODING_AGENT_DIR, SIMRA_RELEASES_URL: process.env.SIMRA_RELEASES_URL };
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	Object.assign(process.env, { XDG_DATA_HOME: join(dir, "data"), SIMRA_FLOW_URL: url, SIMRA_CODING_AGENT_DIR: join(dir, "agent"), SIMRA_RELEASES_URL: `${url}/releases` });
	t.after(async () => {
		for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
		await new Promise((r) => server.close(r));
		rmSync(dir, { recursive: true, force: true });
	});
	const serve = (version: string, inside = version) => Object.assign(state, { version, served: bundle(dir, inside) });
	const base = join(dir, "data", "simra");
	const login = (expires: number) => {
		mkdirSync(join(dir, "agent"), { recursive: true });
		const credential = { type: "oauth", access: "simra-at-0", refresh: state.refresh, expires, service: `${url}/pilot`, inference: false };
		writeFileSync(join(dir, "agent", "auth.json"), JSON.stringify({ simra: credential }));
	};
	return { dir, state, serve, base, login, url };
}

const versions = (base: string) => readdirSync(base).filter((n) => n.startsWith("connectors-")).map((n) => n.split("-")[1]).sort();

test("the bundle installs once, a new version replaces it, the previous one stays, a rollback is a republish", async (t) => {
	const { dir, state, serve, base } = await setup(t);
	assert.equal(await installConnectors("simra-at-0"), "Installed Simra connectors 1.0.0.");
	assert.match(readlinkSync(join(base, "connectors")), /^connectors-1\.0\.0-/);
	assert.equal(installedConnectors(), "1.0.0");
	// Two designs without configuration find the bundled adapter and pack; the record names the installed version.
	const real = join(base, readlinkSync(join(base, "connectors")));
	for (const name of ["a", "b"]) {
		const root = join(dir, name);
		mkdirSync(root);
		writeFileSync(join(root, "amp.spice"), "* fixture design\n.subckt amp in out vss\nXn out in vss vss tn w=1 l=1\n.ends\n");
		const run = await runExperiment({ root, adapter: "fake", operation: "run", inputs: { mode: "ok" }, purpose: "bundled adapter" });
		assert.equal(run.experiment.adapter.dir, join(real, "adapters", "fake"));
		const pack = await runExperiment({ root, adapter: "ngspice", operation: "check_design", inputs: { file: "amp.spice", subckt: "amp", pins: ["in", "out", "vss"], technology: "test-pack" }, purpose: "bundled pack" });
		assert.equal(pack.result.status, "completed", JSON.stringify(pack.result.diagnostics ?? pack.result.errors));
		assert.equal(pack.result.input_files.files.find((f: { role?: string }) => f.role === "technology")?.path, join(real, "technologies", "test-pack", "technology.json"));
	}
	assert.equal(await installConnectors("simra-at-0"), "Simra connectors 1.0.0 are installed.");
	assert.equal(state.downloads, 1);
	serve("1.1.0");
	await installConnectors("simra-at-0");
	serve("1.2.0");
	await installConnectors("simra-at-0");
	assert.deepEqual(versions(base), ["1.1.0", "1.2.0"]);
	serve("1.1.0");
	assert.equal(await installConnectors("simra-at-0"), "Installed Simra connectors 1.1.0.");
	assert.equal(installedConnectors(), "1.1.0");
});

test("a broken download, an unpack failure or another version inside change nothing", async (t) => {
	const { state, serve, base } = await setup(t);
	await installConnectors("simra-at-0");
	const before = readdirSync(base).sort();
	serve("2.0.0");
	state.corrupt = true;
	await assert.rejects(installConnectors("simra-at-0"), /incomplete. Nothing changed/);
	state.corrupt = false;
	const garbage = Buffer.from("not a tarball");
	Object.assign(state, { served: { data: garbage, sha256: createHash("sha256").update(garbage).digest("hex") } });
	await assert.rejects(installConnectors("simra-at-0"), /Unpacking the Simra connectors failed/);
	serve("2.0.0", "3.0.0");
	await assert.rejects(installConnectors("simra-at-0"), /another version. Nothing changed/);
	assert.equal(installedConnectors(), "1.0.0");
	assert.deepEqual(readdirSync(base).sort(), before);
});

test("simra update: the release result stands whatever the bundle does; --connectors alone; the grant", async (t) => {
	const { state, serve, login } = await setup(t);
	assert.equal(await selfUpdate(["--connectors"]), 0);
	assert.equal(installedConnectors(), undefined);
	login(Date.now() + 600_000);
	// A failed release update does not skip the bundle, and its status stays the result.
	state.script = "exit 3";
	assert.equal(await selfUpdate([]), 3);
	assert.equal(installedConnectors(), "1.0.0");
	// A failed bundle update does not change the release result, and the installed bundle stays.
	state.script = "exit 0";
	serve("2.0.0");
	state.corrupt = true;
	assert.equal(await selfUpdate([]), 0);
	assert.equal(await selfUpdate(["--connectors"]), 1);
	assert.equal(installedConnectors(), "1.0.0");
	state.corrupt = false;
	state.connectors = false;
	assert.equal(await selfUpdate(["--connectors"]), 0);
	assert.equal(installedConnectors(), "1.0.0");
	assert.equal(await selfUpdate(["--other"]), 2);
});

test("two processes with an expired login refresh it once and both get a valid token", async (t) => {
	const { state, login, dir } = await setup(t);
	login(1);
	const script = `import { connectorAccess } from ${JSON.stringify(updateModule)}; console.log(await connectorAccess(${JSON.stringify(join(dir, "agent"))}));`;
	const run = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { env: process.env });
	const results = await Promise.all([run(), run()]);
	assert.deepEqual(results.map((r) => r.stdout.trim()), ["simra-at-1", "simra-at-1"]);
	assert.equal(state.refreshes, 1);
	assert.equal(JSON.parse(readFileSync(join(dir, "agent", "auth.json"), "utf8")).simra.refresh, "simra-rt-1");
	assert.ok(!existsSync(join(dir, "data")));
});
