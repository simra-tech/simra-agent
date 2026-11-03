// Test adapter. inputs.mode: ok | failed | crash | invalid-json | wrong-contract | bad-exit | sleep | slow | values
// "slow": the response of "ok" after inputs.seconds seconds.
// "values": inputs.values {name: number | null} become the measurements, with units from inputs.units.
// "values" also takes inputs.at {name: {sweep: value}}: the "at" of that measurement (a sweep point).
// "values" and "failed" also take inputs.diagnostics, the diagnostics of the response.
// "values" also takes inputs.report: the lines of the response field "report".
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
		if (request.inputs.at?.[name]) measurements[name].at = request.inputs.at[name];
	}
	const report = request.inputs.report ? { report: request.inputs.report } : {};
	respond({ ...ok, measurements, diagnostics: request.inputs.diagnostics ?? [], ...report });
}
else if (mode === "failed") respond({ ...ok, status: "failed", measurements: {}, diagnostics: request.inputs.diagnostics ?? [] });
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
