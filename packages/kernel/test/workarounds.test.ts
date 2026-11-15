// Workaround registry: the built-in files are valid, every class that a simulator fails in the stored device-class
// probe of IHP SG13G2 has an entry, the selection by simulator and PDK, and the errors of a malformed file.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatWorkarounds, loadWorkarounds, runPdk, workaroundsFor } from "../src/index.ts";

const probe = JSON.parse(readFileSync(new URL("../../../test/fixtures/device-probe/ihp-sg13g2.json", import.meta.url), "utf8"));

test("the built-in registry loads, and each failed probe class has an entry for its simulator and PDK", () => {
	const all = loadWorkarounds();
	assert.ok(all.length >= 15);
	for (const [cls, cells] of Object.entries<Record<string, { status: string }>>(probe.classes)) {
		for (const [sim, cell] of Object.entries(cells)) {
			if (cell.status !== "fails") continue;
			const hit = workaroundsFor({ simulators: [sim], pdk: probe.pdk }, all).filter((w) => w.applies_to?.device_classes?.includes(cls));
			assert.ok(hit.length > 0, `no workaround entry for ${sim} / ${cls}`);
		}
	}
	const xyce = workaroundsFor({ simulators: ["xyce"], pdk: "ihp-sg13g2" }, all).map((w) => w.id);
	for (const id of ["xyce-sg13g2-psp103", "xyce-sg13g2-r3cmc", "xyce-sg13g2-varactor", "xyce-hb-autonomous"]) assert.ok(xyce.includes(id), id);
	const ngspice = workaroundsFor({ simulators: ["ngspice"], pdk: "ihp-sg13g2" }, all).map((w) => w.id);
	for (const id of ["ngspice-pulse-pw0", "ngspice-trnoise-round-step", "ngspice-sg13g2-klu-large-deck", "ngspice-sg13g2-mc-reltol", "ngspice-bsource-pwl-bare-param"]) assert.ok(ngspice.includes(id), id);
});

test("selection: without a PDK only the PDK-independent entries; another PDK gets none of the IHP entries", () => {
	const all = loadWorkarounds();
	assert.ok(workaroundsFor({ simulators: ["xyce"] }, all).every((w) => w.pdk === "*"));
	assert.ok(workaroundsFor({ simulators: ["xyce"], pdk: "sky130A" }, all).every((w) => w.pdk === "*"));
	assert.ok(workaroundsFor({ pdk: "ihp-sg13g2" }, all).some((w) => w.simulator === "openems"));
	const text = formatWorkarounds(workaroundsFor({ simulators: ["xyce"], pdk: "ihp-sg13g2" }, all));
	assert.match(text, /^- xyce-sg13g2-psp103 \(xyce, ihp-sg13g2; open\) \[mos_lv_nmos, /m);
	assert.match(text, /^ {2}workaround: Simulate decks with MOS devices in ngspice/m);
	assert.equal(formatWorkarounds([], "known gaps of fake"), "known gaps of fake: none in the registry");
});

test("runPdk: inputs.pdk, then the PDK of the environment", (t) => {
	const root = mkdtempSync(join(tmpdir(), "simra-wa-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "simra.config.json"), JSON.stringify({ environments: { eda: { kind: "container", image: "x", env: { PDK: "ihp-sg13g2" } } } }));
	assert.equal(runPdk(root, "eda"), "ihp-sg13g2");
	assert.equal(runPdk(root, "eda", { pdk: "sky130A" }), "sky130A");
	assert.equal(runPdk(root), null);
});

test("a malformed registry file is an error that names the file and the entry", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "simra-wa-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "xyce"));
	const entry = { id: "a", gap: "g", symptom: "s", workaround: "w", status: "open", evidence: "e" };
	const write = (doc: unknown) => writeFileSync(join(dir, "xyce", "any.json"), JSON.stringify(doc));
	write({ schema: "simra.workarounds/0", simulator: "xyce", pdk: "*", versions: "7.10", entries: [entry] });
	assert.equal(loadWorkarounds([dir]).length, 1);
	write({ schema: "simra.workarounds/0", simulator: "xyce", pdk: "*", versions: "7.10", entries: [{ ...entry, status: "maybe" }] });
	assert.throws(() => loadWorkarounds([dir]), /xyce\/any\.json: entry a: status must be one of/);
	write({ schema: "simra.workarounds/0", simulator: "xyce", pdk: "*", versions: "7.10", entries: [entry, entry] });
	assert.throws(() => loadWorkarounds([dir]), /entry id a is repeated/);
	write({ schema: "simra.workarounds/0", simulator: "xyce", pdk: "ihp-sg13g2", versions: "7.10", entries: [entry] });
	assert.throws(() => loadWorkarounds([dir]), /does not match the file name/);
	write({ schema: "simra.workarounds/0", simulator: "xyce", pdk: "*", versions: "7.10", entries: [{ ...entry, workaround: "" }] });
	assert.throws(() => loadWorkarounds([dir]), /workaround is required/);
});
