// Smoke test: start the pinned pi in RPC mode with only the Simra extension loaded.
// It needs no model, no API key and no network.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const piBin = join(root, "node_modules", ".bin", "pi");
const extensionDir = join(root, "packages", "pi-extension");
const extensionVersion = JSON.parse(readFileSync(join(extensionDir, "package.json"), "utf8")).version;
const piVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["@earendil-works/pi-coding-agent"];

test("pi loads the extension and runs /simra-version", { timeout: 60_000 }, async (t) => {
	// An empty agent directory keeps the test independent of the user's pi settings.
	const agentDir = mkdtempSync(join(tmpdir(), "simra-smoke-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));

	const child = spawn(
		piBin,
		["--mode", "rpc", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-themes", "-e", extensionDir],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	t.after(() => child.kill());

	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));

	const records = [];
	const done = new Promise((resolve, reject) => {
		child.on("exit", (code) => reject(new Error(`pi exited early (code ${code}). stderr:\n${stderr}`)));
		createInterface({ input: child.stdout }).on("line", (line) => {
			records.push(JSON.parse(line));
			const commands = records.find((r) => r.type === "response" && r.id === "commands");
			const prompt = records.find((r) => r.type === "response" && r.id === "version");
			// pi sends the notification before the response to the prompt that caused it.
			const notify = records.find((r) => r.type === "extension_ui_request" && r.method === "notify");
			if (commands && prompt) resolve({ commands, prompt, notify });
		});
	});

	child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
	child.stdin.write(`${JSON.stringify({ id: "version", type: "prompt", message: "/simra-version" })}\n`);

	const { commands, prompt, notify } = await done;

	assert.equal(commands.success, true);
	const command = commands.data.commands.find((c) => c.name === "simra-version");
	assert.ok(command, "pi does not list /simra-version");
	assert.equal(command.source, "extension");

	assert.equal(prompt.success, true);
	assert.equal(prompt.data.disposition, "handled");

	assert.ok(notify, "/simra-version sent no notification");
	assert.equal(notify.message, `simra-agent ${extensionVersion} (pi ${piVersion})`);
});
