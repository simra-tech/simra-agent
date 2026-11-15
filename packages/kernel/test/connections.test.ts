// Connection table and its gate: the table check (a bias need without a provider, a provider with another value or
// temperature behaviour, a control without a definition), the block check (pins from the .subckt line, supplies, bias
// values, control encodings, needs that are not in the table), and the gate rows in a requirements check.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkBlock, checkTable, connectionGate, formatConnectionRows, loadConnectionTable, runCheck, subcktPins, validateTable } from "../src/index.ts";

const fixtures = new URL("./fixtures/connections/", import.meta.url).pathname;
const table = () => loadConnectionTable(join(fixtures, "table.json"));

test("subcktPins reads the pins with continuation lines and stops at the parameters", () => {
	assert.deepEqual(subcktPins(join(fixtures, "div.spice"), "DIV_CORE"), ["vcc", "vcc18", "vss", "vbx", "en", "gain_0", "in", "out"]);
	assert.throws(() => subcktPins(join(fixtures, "div.spice"), "nope"), /no \.subckt nope/);
});

test("checkTable: a need without a provider, a provider with another value, an undefined control, an unused output", () => {
	const rows = checkTable(table());
	assert.deepEqual(rows.map((r) => [r.item, r.reason]), [
		["table bias.spare_ref", "bias output on net spare_ref has no consumer"],
		["table lna.ib1", "provider bias.lna_ref gives 0.000931, the need is 0.000863 +- 0.00004315"],
		["table lna.ib2", "bias need on net lna_iref2 has no provider"],
		["table lna.mux", "control lna_mux is not defined in controls"],
	]);
	assert.ok(rows.every((r) => r.status === "fail"));
	assert.deepEqual(validateTable({ schema: "simra.connections/0", supplies: {}, blocks: { b: { pins: { p: { net: "n", kind: "bias" } } } } } as any), [
		"blocks.b.pins.p: give one of current_a and voltage_v",
		"blocks.b.pins.p: tolerance_rel or tolerance_abs is required",
	]);
});

test("checkBlock: a block that matches the table passes every row", () => {
	const rows = checkBlock(table(), JSON.parse(require_("div_ok.json")), fixtures);
	assert.ok(rows.length >= 15);
	assert.deepEqual(rows.filter((r) => r.status !== "pass"), []);
	const bias = rows.find((r) => r.item === "bias vbx");
	assert.deepEqual([bias?.got, bias?.unit], [5.1e-4, "A"]);
});

test("checkBlock: the mismatch classes of a block are rows with the reason", () => {
	const rows = checkBlock(table(), JSON.parse(require_("div_bad.json")), fixtures);
	const failed = Object.fromEntries(rows.filter((r) => r.status === "fail").map((r) => [r.item, r.reason]));
	assert.deepEqual(Object.keys(failed).sort(), [
		"bias vbx", "bias vbx tc", "bias vtest", "control en active", "control gain encoding", "pin gain", "pin gain_0", "supply vcc18",
	]);
	assert.match(failed["bias vbx"] as string, /used 0.0006 A; the table gives 0.0005 A \+- 0.000025/);
	assert.match(failed["control gain encoding"] as string, /decodes thermometer; control div_gain is binary/);
	assert.match(failed["bias vtest"] as string, /a need without a provider/);
	assert.match(formatConnectionRows(rows), /^connections: \d+ rows \(\d+ pass, 8 fail, 0 not run\)/);
});

test("connection gate in a requirements check: rows per item; without a record the block cannot pass", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "simra-conn-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	cpSync(fixtures, root, { recursive: true });
	writeFileSync(join(root, "simra.config.json"), "{}");
	const req = (iface: string) => ({ schema: "simra.requirements/0", conditions: {}, experiments: {}, requirements: [], gates: { connections: { table: "table.json", block: "div", interface: iface } } });
	writeFileSync(join(root, "requirements.json"), JSON.stringify(req("div_ok.json")));
	const ok = await runCheck({ root });
	assert.equal(ok.verdict.status, "pass");
	assert.ok(ok.verdict.rows.every((r) => r.requirement === "gate connections div" && r.gate?.name === "connections"));
	const bias = ok.verdict.rows.find((r) => r.measurement === "bias vbx");
	assert.deepEqual([bias?.op, bias?.limit, bias?.value], ["between", [0.000475, 0.000525], 5.1e-4]);
	writeFileSync(join(root, "requirements.json"), JSON.stringify(req("div_bad.json")));
	assert.equal((await runCheck({ root })).verdict.status, "fail");
	writeFileSync(join(root, "requirements.json"), JSON.stringify(req("missing.json")));
	const none = await runCheck({ root });
	assert.equal(none.verdict.status, "incomplete");
	assert.match(none.verdict.rows[0].reason ?? "", /no block interface record missing\.json: the block cannot pass without it/);
	assert.deepEqual(connectionGate(root, "table.json", "lna", "missing.json").map((r) => r.item), ["table lna.ib1", "table lna.ib2", "table lna.mux", "record"]);
});

function require_(name: string): string {
	return readFileSync(join(fixtures, name), "utf8");
}

test("checkTable and checkBlock on a 17-block chip table: one unused output; stale rows show as block mismatches", () => {
	const t = loadConnectionTable(join(fixtures, "chip17.json"));
	assert.deepEqual(validateTable(t), []);
	assert.equal(Object.keys(t.blocks).length, 17);
	assert.deepEqual(checkTable(t).map((r) => [r.item, r.reason]), [["table xbias.vref_f", "bias output on net bias_vref_f has no consumer"]]);
	// the mixer as its own testbench used it (pins from the subcircuit line)
	const rows = checkBlock(t, {
		schema: "simra.block_interface/0",
		block: "xmixi",
		pins: ["vcc", "rfp", "lo1", "ifp", "ifn", "m1_m", "eb", "vbbuf", "vbcas", "vblo"],
		supplies: { vcc: 3.3 },
		bias: { m1_m: { current_a: 1.1e-3 }, eb: { current_a: 6e-3 }, vblo: { voltage_v: 1.95 } },
	});
	assert.deepEqual(rows.filter((r) => r.status === "fail").map((r) => r.item), ["bias m1_m", "bias vblo"]);
	assert.equal(rows.filter((r) => r.status === "pass").length, 12);
});
