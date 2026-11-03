// The read operations of the klayout adapter in the container, on the real blocks (both PDKs):
// 1. query on the seeded block of layout-block-fix: layers (the layer names come from the layer properties file of
//    the PDK), cells (the cell count of expected.json) and at on one seeded marker (the first marker of the
//    minimum-area rule of Metal3, from the marker database fixture of the adapter): the Metal3 pad and its Via2.
// 2. query (layers, cells) on the flat block of layout-long-job (21487 devices). The test prints the runtimes.
// It runs only with SIMRA_TEST_IMAGE, an image with KLayout, its Python module and both PDKs (optional:
// SIMRA_TEST_ENGINE podman or docker, default podman). A skipped case is reported by the test runner as skipped:
// that check did not run.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runExperiment } from "@simra-tech/kernel";
import { loadTask } from "../evals/layout-drc-fix/layout.mjs";
import { PDKS } from "../evals/layout-block-fix/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
const engine = process.env.SIMRA_TEST_ENGINE ?? "podman";
const local = { environments: { eda: { engine, image: process.env.SIMRA_TEST_IMAGE } } };
const CONFIG = { sg13g2: "examples/ota-sg13g2/simra.config.json", sky130: "evals/layout-block-fix/sky130/simra.config.json" };
// The PDK names of the test: the minimum-area rule of Metal3, and the names of Metal1, Metal3 and Via2 in the layer
// properties file of the PDK.
const NAMES = {
	sg13g2: { rule: "M3.d", metal1: "Metal1", metal3: "Metal3", via2: "Via2" },
	sky130: { rule: "m3.6", metal1: "met1", metal3: "met3", via2: "via2" },
};

/** A design root with the given files and the configuration of the PDK. */
function designRoot(t, pdk, files) {
	// The real path: on macOS, tmpdir() is under the /var link, which a container engine VM may not have.
	const root = mkdtempSync(join(realpathSync(tmpdir()), `simra-read-${pdk}-`));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [to, from] of Object.entries(files)) copyFileSync(join(repo, from), join(root, to));
	copyFileSync(join(repo, CONFIG[pdk]), join(root, "simra.config.json"));
	writeFileSync(join(root, "simra.local.json"), JSON.stringify(local));
	return root;
}

/** The first marker box of a rule in a marker database fixture of the adapter, as [x1, y1, x2, y2] in µm. */
function firstMarker(pdk, rule) {
	const db = readFileSync(join(repo, `adapters/klayout/fixtures/drc-${pdk}-seeded.lyrdb`), "utf8");
	const item = db.split("<item>").find((s) => s.includes(`<category>'${rule}'</category>`));
	const pts = [...item.match(/polygon: \(([^)]*)\)/)[1].matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const query = (root, gds, cell, queries) =>
	runExperiment({ root, adapter: "klayout", operation: "query", environment: "eda", inputs: { gds, cell, queries }, purpose: "container test" });
const values = (result) => Object.fromEntries(Object.entries(result.measurements).map(([k, m]) => [k, m.value]));
const why = (result) => JSON.stringify([...result.errors, ...result.diagnostics.filter((d) => d.severity !== "info").map((d) => d.message)]).slice(0, 2000);

for (const pdk of PDKS) {
	const n = NAMES[pdk];

	test(`klayout ${pdk}: query on the seeded block: layers, cells, and at on a seeded marker (container)`, { skip, timeout: 600_000 }, async (t) => {
		const { spec, expected } = loadTask(join(repo, "evals/layout-block-fix", pdk));
		const root = designRoot(t, pdk, { "block.gds": `evals/layout-block-fix/${pdk}/block-seeded.gds` });
		const box = firstMarker(pdk, n.rule);
		const { result } = await query(root, "block.gds", spec.cell, [{ kind: "layers" }, { kind: "cells" }, { kind: "at", box }]);
		assert.equal(result.status, "completed", why(result));
		assert.deepEqual(result.diagnostics.filter((d) => d.severity !== "info"), [], why(result));
		const m = values(result);
		assert.equal(m.queries, 3);
		const report = result.report;
		const roles = result.input_files.files.map((f) => f.role);
		assert.deepEqual(roles, ["layout", "layer_properties", "technology"]);
		assert.ok(result.input_files.complete);
		// layers: the names come from the layer properties file.
		assert.match(report[0], /^\[1\] layers: \d+ layers with shapes, \d+ shapes \(flat\)$/);
		assert.ok(report.some((l) => new RegExp(`^  ${n.metal1} \\d+/\\d+  shapes=\\d+  area=\\d+\\.\\d{3}$`).test(l)), report.join("\n"));
		// cells: the cell count of the block.
		assert.ok(report.some((l) => l.startsWith(`[2] cells: ${expected.variants.seeded.cells} cells in the tree of ${spec.cell},`)), report.join("\n"));
		// at: the small Metal3 pad of the marker and its Via2.
		const at = report.slice(report.findIndex((l) => l.startsWith("[3] at ")));
		assert.ok(at.some((l) => new RegExp(`^  layer ${n.metal3} \\d+/\\d+  shapes=1  area=`).test(l)), at.join("\n"));
		assert.ok(at.some((l) => new RegExp(`^  layer ${n.via2} \\d+/\\d+  shapes=1  area=`).test(l)), at.join("\n"));
		t.diagnostic(`${pdk} query seeded block: ${m.rows} rows, ${m.runtime_s} s (adapter), ${result.duration_s} s (run)`);
		t.diagnostic(`${pdk} at: ${at.join(" | ")}`);
	});

	test(`klayout ${pdk}: query on the flat block of layout-long-job (container)`, { skip, timeout: 900_000 }, async (t) => {
		const { spec } = loadTask(join(repo, "evals/layout-long-job", pdk));
		const root = designRoot(t, pdk, { "block.gds": `evals/layout-long-job/${pdk}/flat-seeded.gds` });
		const { result } = await query(root, "block.gds", spec.cell, [{ kind: "layers" }, { kind: "cells" }, { kind: "bbox" }]);
		assert.equal(result.status, "completed", why(result));
		const m = values(result);
		assert.ok(result.report.some((l) => l.startsWith(`[2] cells: 1 cells in the tree of ${spec.cell},`)), result.report.join("\n"));
		t.diagnostic(`${pdk} query flat block: ${result.report[0]}; ${m.runtime_s} s (adapter), ${result.duration_s} s (run)`);
	});
}
