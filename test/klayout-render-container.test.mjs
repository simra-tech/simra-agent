// The render operation of the klayout adapter in the container, on the seeded block of layout-block-fix (both PDKs):
// 1. a box: the first marker box of the minimum-area rule of Metal3 (from the marker database fixture of the
//    adapter), drawn with the colours of the layer properties file of the PDK. The output is a PNG with the role
//    image, and the report line names the box, the view, the file, the size and the layers in the view.
// 2. a DRC marker: the same marker, taken from a drc run of the block (drc and rule), drawn with a red outline.
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
// The minimum-area rule of Metal3 and the names of Metal3 and Via2 in the layer properties file of the PDK.
const NAMES = {
	sg13g2: { rule: "M3.d", metal3: "Metal3", via2: "Via2" },
	sky130: { rule: "m3.6", metal3: "met3", via2: "via2" },
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const f3 = (x) => x.toFixed(3);

/** A design root with the seeded block and the configuration of the PDK. */
function designRoot(t, pdk) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), `simra-render-${pdk}-`));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	copyFileSync(join(repo, `evals/layout-block-fix/${pdk}/block-seeded.gds`), join(root, "block.gds"));
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

const run = (root, operation, inputs) =>
	runExperiment({ root, adapter: "klayout", operation, environment: "eda", inputs, purpose: "container test" });
const values = (result) => Object.fromEntries(Object.entries(result.measurements).map(([k, m]) => [k, m.value]));
const why = (result) => JSON.stringify([...result.errors, ...result.diagnostics.filter((d) => d.severity !== "info").map((d) => d.message)]).slice(0, 2000);

/** The one picture of a completed render: a PNG output with the role image, work/render.png of the experiment. */
function picture(root, id, result) {
	const images = result.outputs.filter((o) => o.role === "image");
	assert.equal(images.length, 1, JSON.stringify(result.outputs));
	assert.ok(images[0].path.endsWith(`/${id}/work/render.png`), images[0].path);
	const data = readFileSync(join(root, images[0].path));
	assert.ok(data.subarray(0, 8).equals(PNG), "the output is a PNG");
	assert.equal(data.length, images[0].bytes);
	return data;
}

for (const pdk of PDKS) {
	const n = NAMES[pdk];

	test(`klayout ${pdk}: render a box of the seeded block (container)`, { skip, timeout: 600_000 }, async (t) => {
		const { spec } = loadTask(join(repo, "evals/layout-block-fix", pdk));
		const root = designRoot(t, pdk);
		const box = firstMarker(pdk, n.rule);
		const { id, result } = await run(root, "render", { gds: "block.gds", cell: spec.cell, box, size: 512 });
		assert.equal(result.status, "completed", why(result));
		assert.deepEqual(result.diagnostics.filter((d) => d.severity !== "info"), [], why(result));
		const m = values(result);
		assert.equal(m.images, 1);
		assert.deepEqual(result.input_files.files.map((f) => f.role), ["layout", "layer_properties", "technology"]);
		const line = result.report[0];
		const head = `[1] box cell=${spec.cell} box=(${f3(box[0])},${f3(box[1])};${f3(box[2])},${f3(box[3])}) view=(`;
		assert.ok(line.startsWith(head), line);
		const tail = line.match(/ image=(work\/render\.png) (\d+)x(\d+) layers=(.*)$/);
		assert.ok(tail, line);
		assert.equal(Math.max(Number(tail[2]), Number(tail[3])), 512);
		const layers = tail[4].split(",");
		assert.ok(layers.includes(n.metal3) && layers.includes(n.via2), line);
		const data = picture(root, id, result);
		t.diagnostic(`${pdk} render box: ${line}; ${data.length} bytes, ${m.runtime_s} s (adapter), ${result.duration_s} s (run), experiment ${id}`);
	});

	test(`klayout ${pdk}: render a DRC marker of the seeded block (container)`, { skip, timeout: 900_000 }, async (t) => {
		const { spec } = loadTask(join(repo, "evals/layout-block-fix", pdk));
		const root = designRoot(t, pdk);
		const drc = await run(root, "drc", { gds: "block.gds", cell: spec.cell });
		assert.equal(drc.result.status, "completed", why(drc.result));
		const table = JSON.parse(readFileSync(join(root, "simra", "experiments", drc.id, "work/drc.json"), "utf8"));
		const count = table.rules.find((r) => r.rule === n.rule).count;
		const { id, result } = await run(root, "render", { gds: "block.gds", cell: spec.cell, drc: drc.id, rule: n.rule, size: 512 });
		assert.equal(result.status, "completed", why(result));
		assert.deepEqual(result.diagnostics.filter((d) => d.severity !== "info"), [], why(result));
		assert.equal(values(result).images, 1);
		assert.deepEqual(result.input_files.files.map((f) => f.role), ["layout", "layer_properties", "technology", "drc"]);
		const line = result.report[0];
		assert.ok(line.startsWith(`[1] marker ${n.rule} 1/${count} cell=`), line);
		assert.match(line, / image=work\/render\.png \d+x\d+ layers=/);
		const data = picture(root, id, result);
		t.diagnostic(`${pdk} render marker: ${line}; ${data.length} bytes, ${result.duration_s} s (run)`);
	});
}
