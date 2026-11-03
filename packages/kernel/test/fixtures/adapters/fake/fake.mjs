// Test adapter. inputs.mode: ok | failed | crash | invalid-json | wrong-contract | bad-exit | sleep | slow | values
// "slow": the response of "ok" after inputs.seconds seconds.
// "values": inputs.values {name: number | null} become the measurements, with units from inputs.units.
// "values" also takes inputs.at {name: {sweep: value}}: the "at" of that measurement (a sweep point).
// "values" and "failed" also take inputs.diagnostics, the diagnostics of the response.
// "values" also takes inputs.report: the lines of the response field "report".
// "image": the response of "ok" with inputs.count (default 1) PNG outputs work/render-<n>.png of role "image"
// (a 1 x 1 pixel PNG each, or inputs.bytes zero bytes each), and a work/render.json output without a role.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const request = JSON.parse((await import("node:fs")).readFileSync(process.argv[2], "utf8"));
const mode = request.inputs.mode;
const respond = (body) => writeFileSync(request.response_path, JSON.stringify(body));
const ok = {
	contract: "simra.adapter/0",
	status: "completed",
	tool: { name: "fake", version: "1" },
	input_files: { files: [], complete: true },
	outputs: [],
	measurements: { x: { value: 1.5, unit: "V", status: "measured" } },
	diagnostics: [],
};

if (mode === "ok") respond(ok);
else if (mode === "values") {
	const measurements = {};
	for (const [name, value] of Object.entries(request.inputs.values ?? {})) {
		const unit = request.inputs.units?.[name] ?? null;
		measurements[name] = value === null ? { value: null, unit, status: "missing" } : { value, unit, status: "measured" };
		if (request.inputs.at?.[name]) measurements[name].at = request.inputs.at[name];
	}
	const report = request.inputs.report ? { report: request.inputs.report } : {};
	respond({ ...ok, measurements, diagnostics: request.inputs.diagnostics ?? [], ...report });
}
else if (mode === "image") {
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
	const data = request.inputs.bytes ? Buffer.alloc(request.inputs.bytes) : png;
	const outputs = [];
	const entry = (name) => ({ path: join(request.work_dir, name), sha256: "0".repeat(64), bytes: data.length });
	writeFileSync(join(request.work_dir, "render.json"), "{}");
	outputs.push({ ...entry("render.json"), bytes: 2 });
	for (let n = 1; n <= (request.inputs.count ?? 1); n++) {
		writeFileSync(join(request.work_dir, `render-${n}.png`), data);
		outputs.push({ ...entry(`render-${n}.png`), role: "image" });
	}
	respond({ ...ok, outputs, report: outputs.filter((o) => o.role).map((o, i) => `[${i + 1}] image=${o.path}`) });
} else if (mode === "failed") respond({ ...ok, status: "failed", measurements: {}, diagnostics: request.inputs.diagnostics ?? [] });
else if (mode === "crash") {
	console.error("fake adapter: crash");
	process.exit(3);
} else if (mode === "invalid-json") writeFileSync(request.response_path, "{not json");
else if (mode === "wrong-contract") respond({ ...ok, contract: "other/1" });
else if (mode === "bad-exit") {
	respond(ok);
	process.exit(1);
} else if (mode === "sleep") setTimeout(() => {}, 60_000);
else if (mode === "slow") setTimeout(() => respond(ok), (request.inputs.seconds ?? 1) * 1000);
