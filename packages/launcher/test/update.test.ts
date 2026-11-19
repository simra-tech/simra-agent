// The daily update check (update.ts) against a fake releases page on 127.0.0.1.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { updateNotice } from "../update.ts";

test("the update check: a notice for a newer release, once a day, none with SIMRA_NO_UPDATE_CHECK=1", async (t) => {
	const saved = Object.fromEntries(["SIMRA_RELEASES_URL", "SIMRA_NO_UPDATE_CHECK", "PI_OFFLINE"].map((name) => [name, process.env[name]]));
	t.after(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	delete process.env.SIMRA_NO_UPDATE_CHECK;
	const requests: string[] = [];
	const server = createServer((req, res) => {
		requests.push(req.url ?? "");
		res.writeHead(302, { location: "/releases/tag/v99.0.0" }).end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const dir = mkdtempSync(join(tmpdir(), "simra-update-"));
	t.after(() => {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	process.env.SIMRA_RELEASES_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;
	delete process.env.PI_OFFLINE;
	/** Start a session; give its notices after the first one, or after ms. */
	const start = (state: string, ms: number) =>
		new Promise<string[]>((resolve) => {
			const notices: string[] = [];
			const on = (_event: string, handler: (event: object, ctx: object) => void) => handler({}, { hasUI: true, ui: { notify: (m: string) => resolve([...notices, m]) } });
			updateNotice("1.0.0", state)({ on } as never);
			setTimeout(() => resolve(notices), ms);
		});
	const state = join(dir, "update-check");
	assert.deepEqual(await start(state, 10_000), ["simra 99.0.0 is available: run simra update"]);
	assert.deepEqual(await start(state, 500), []);
	process.env.SIMRA_NO_UPDATE_CHECK = "1";
	assert.deepEqual(await start(join(dir, "other"), 500), []);
	assert.deepEqual(requests, ["/releases/latest"]);
});
