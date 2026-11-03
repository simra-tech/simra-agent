// The read operations of the klayout adapter in the container, on the real blocks (both PDKs):
// 1. query on the seeded block of layout-block-fix: layers (the layer names come from the layer properties file of
//    the PDK), cells (the cell count of expected.json) and at on one seeded marker (the first marker of the
//    minimum-area rule of Metal3, from the marker database fixture of the adapter): the Metal3 pad and its Via2.
// 2. query (layers, cells) on the flat block of layout-long-job (21487 devices).
// 3. diff of layout-stale-state: v2 (the commit of the colleague) against v1 (the input), with the DRC markers of two
//    drc runs. The kept box of expected.json must show as added, the two rules that the colleague fixed must show as
//    fixed, and the new rule as new.
// 4. diff on the flat block of layout-long-job: the block against a copy with one Metal2 box added and five shapes
//    removed (made in the container with klayout.db). The test prints the runtimes.
// It runs only with SIMRA_TEST_IMAGE, an image with KLayout, its Python module and both PDKs (optional:
// SIMRA_TEST_ENGINE podman or docker, default podman). A skipped case is reported by the test runner as skipped:
// that check did not run.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runExperiment } from "@simra-tech/kernel";
import { loadTask, runContainer, taskEnvironment } from "../evals/layout-drc-fix/layout.mjs";
import { PDKS } from "../evals/layout-block-fix/reference.mjs";

const repo = new URL("../", import.meta.url).pathname;
const skip = !process.env.SIMRA_TEST_IMAGE && "SIMRA_TEST_IMAGE is not set";
const engine = process.env.SIMRA_TEST_ENGINE ?? "podman";
const local = { environments: { eda: { engine, image: process.env.SIMRA_TEST_IMAGE } } };
const CONFIG = { sg13g2: "examples/ota-sg13g2/simra.config.json", sky130: "evals/layout-block-fix/sky130/simra.config.json" };
// The PDK names of the test: the minimum-area rule of Metal3, the names of Metal1, Metal3 and Via2 in the layer
// properties file of the PDK, and the layer/datatype of Metal2.
const NAMES = {
	sg13g2: { rule: "M3.d", metal1: "Metal1", metal3: "Metal3", via2: "Via2", metal2: [10, 0] },
	sky130: { rule: "m3.6", metal1: "met1", metal3: "met3", via2: "via2", metal2: [69, 20] },
};
const f3 = (x) => x.toFixed(3);

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
const run = (root, operation, inputs) =>
	runExperiment({ root, adapter: "klayout", operation, environment: "eda", inputs, purpose: "container test" });
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

	test(`klayout ${pdk}: diff of layout-stale-state v2 against v1, with the DRC marker delta (container)`, { skip, timeout: 1_800_000 }, async (t) => {
		const { spec, expected } = loadTask(join(repo, "evals/layout-stale-state", pdk));
		const root = designRoot(t, pdk, {
			"block.gds": `evals/layout-stale-state/${pdk}/v2-seeded.gds`,
			"v1.gds": `evals/layout-block-fix/${pdk}/block-seeded.gds`,
		});
		const [v2, v1] = await Promise.all([run(root, "drc", { gds: "block.gds", cell: spec.cell }), run(root, "drc", { gds: "v1.gds", cell: spec.cell })]);
		for (const r of [v2, v1]) assert.equal(r.result.status, "completed", why(r.result));
		const { result } = await run(root, "diff", { gds: "block.gds", against: "v1.gds", cell: spec.cell, drc: v2.id, drc_against: v1.id, max: 3 });
		assert.equal(result.status, "completed", why(result));
		assert.deepEqual(result.diagnostics.filter((d) => d.severity !== "info"), [], why(result));
		const report = result.report;
		const m = values(result);
		// The kept box: the wider ibias stub on Metal2, added in v2.
		const [x1, y1, x2, y2] = expected.change.box_um;
		const kept = `    + box (${f3(x1)},${f3(y1)};${f3(x2)},${f3(y2)})  area=${f3((x2 - x1) * (y2 - y1))}  cell=${spec.cell}`;
		const layer = report.findIndex((l) => l.includes(` ${expected.change.layer.join("/")}  added=`));
		assert.ok(layer >= 0 && report.slice(layer + 1, layer + 3).includes(kept), report.join("\n"));
		// The rules that the colleague fixed, and the new rule of v2.
		const v1Rules = expected.variants["v1-seeded"].drc.rules;
		const fixed = expected.colleague.fixed_seeds.flatMap((s) => s.rules);
		const fresh = Object.entries(Object.assign({}, ...expected.colleague.new_seed.map((s) => s.rules)));
		for (const rule of fixed) assert.ok(report.includes(`  ${rule}  new=0 fixed=${v1Rules[rule]} unchanged=0`), `${rule}\n${report.join("\n")}`);
		for (const [rule, n] of fresh) assert.ok(report.includes(`  ${rule}  new=${n} fixed=0 unchanged=0`), `${rule}\n${report.join("\n")}`);
		assert.equal(m.markers_fixed, fixed.reduce((a, r) => a + v1Rules[r], 0));
		assert.equal(m.markers_new, fresh.reduce((a, [, n]) => a + n, 0));
		assert.equal(m.markers_unchanged, v1.result.measurements.markers.value - m.markers_fixed);
		assert.deepEqual(result.input_files.files.map((f) => f.role), ["layout", "layout", "layer_properties", "technology", "drc", "drc"]);
		t.diagnostic(`${pdk} diff stale-state: ${m.layers_changed} layers, +${m.area_added_um2} -${m.area_removed_um2} µm², ${m.cells_changed} cells, markers new ${m.markers_new} fixed ${m.markers_fixed} unchanged ${m.markers_unchanged}; ${m.runtime_s} s (adapter), ${result.duration_s} s (run)`);
		t.diagnostic(`${pdk} diff report:\n${report.join("\n")}`);
	});

	test(`klayout ${pdk}: diff on the flat block of layout-long-job (container)`, { skip, timeout: 900_000 }, async (t) => {
		const { spec } = loadTask(join(repo, "evals/layout-long-job", pdk));
		const root = designRoot(t, pdk, { "block.gds": `evals/layout-long-job/${pdk}/flat-seeded.gds` });
		const [l, d] = n.metal2;
		writeFileSync(join(root, "edit.py"), [
			"import klayout.db as db",
			"ly = db.Layout()",
			'ly.read("block.gds")',
			`shapes = ly.top_cell().shapes(ly.layer(${l}, ${d}))`,
			"for s in [s for i, s in enumerate(shapes.each()) if i < 5]:",
			"    shapes.erase(s)",
			"shapes.insert(db.DBox(0, 200, 5, 201))",
			'ly.write("edited.gds")',
			"",
		].join("\n"));
		const env = taskEnvironment(root, { environment: "eda" });
		const edit = await runContainer({ ...env, env: { ...env.env, PYTHONDONTWRITEBYTECODE: "1" } }, root, "python3 edit.py");
		assert.equal(edit.code, 0, edit.stderr ?? "");
		const { result } = await run(root, "diff", { gds: "edited.gds", against: "block.gds", cell: spec.cell, max: 3 });
		assert.equal(result.status, "completed", why(result));
		const m = values(result);
		assert.equal(m.layers_changed, 1);
		assert.equal(m.area_added_um2, 5);
		assert.ok(result.report.includes(`    + box (0.000,200.000;5.000,201.000)  area=5.000  cell=${spec.cell}`), result.report.join("\n"));
		t.diagnostic(`${pdk} diff flat block: ${result.report[0]}; ${m.runtime_s} s (adapter), ${result.duration_s} s (run)`);
	});
}
