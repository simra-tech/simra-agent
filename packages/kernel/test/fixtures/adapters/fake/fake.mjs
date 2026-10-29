// Test adapter. inputs.mode: ok | failed | crash | invalid-json | wrong-contract | bad-exit | sleep | values
// "values": inputs.values {name: number | null} become the measurements, with units from inputs.units.
import { writeFileSync } from "node:fs";

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
