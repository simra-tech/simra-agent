// Test adapter. inputs.mode: ok | failed | crash | invalid-json | wrong-contract | bad-exit | sleep | values
// "values": inputs.values {name: number | null} become the measurements, with units from inputs.units.
// "values" also takes inputs.at {name: {sweep: value}}: the "at" of that measurement (a sweep point).
// Operation "check_design" reads inputs.file: each line "error <text>" is an error diagnostic, each line that starts
// with "x" is a MOS device of 2.5 um2, and a line "failed" makes the run fail.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

if (request.operation === "check_design") {
	const path = join(request.root, request.inputs.file);
	const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : null;
	const diagnostics = lines
		? lines.flatMap((l, i) => (l.startsWith("error ") ? [{ severity: "error", message: l.slice(6), source: `${request.inputs.file}:${i + 1}` }] : []))
		: [{ severity: "error", message: `design file not found: ${request.inputs.file}`, source: request.inputs.file }];
	const mos = (lines ?? []).filter((l) => l.startsWith("x")).length;
	const passive = (lines ?? []).filter((l) => l.startsWith("c")).length * 10;
	const measurements = {
		area_um2: { value: mos * 2.5 + passive, unit: "um2", status: "measured" },
		gate_area_um2: { value: mos * 2.5, unit: "um2", status: "measured" },
		passive_area_um2: { value: passive, unit: "um2", status: "measured" },
		mos_count: { value: mos, unit: null, status: "measured" },
	};
	if (lines?.includes("failed")) respond({ ...ok, status: "failed", measurements: {}, diagnostics: [{ severity: "error", message: "fake design failure", source: "adapter" }] });
	else respond({ ...ok, measurements, diagnostics });
} else if (mode === "ok") respond(ok);
else if (mode === "values") {
	const measurements = {};
	for (const [name, value] of Object.entries(request.inputs.values ?? {})) {
		const unit = request.inputs.units?.[name] ?? null;
		measurements[name] = value === null ? { value: null, unit, status: "missing" } : { value, unit, status: "measured" };
		if (request.inputs.at?.[name]) measurements[name].at = request.inputs.at[name];
	}
	respond({ ...ok, measurements });
}
else if (mode === "failed") respond({ ...ok, status: "failed", measurements: {} });
else if (mode === "crash") {
	console.error("fake adapter: crash");
	process.exit(3);
} else if (mode === "invalid-json") writeFileSync(request.response_path, "{not json");
else if (mode === "wrong-contract") respond({ ...ok, contract: "other/1" });
else if (mode === "bad-exit") {
	respond(ok);
	process.exit(1);
} else if (mode === "sleep") setTimeout(() => {}, 60_000);
