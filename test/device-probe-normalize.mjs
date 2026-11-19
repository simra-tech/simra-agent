// normalizeProbe makes a device-probe table independent of the run: no experiment ids, and $PDK_ROOT in place of
// the PDK path of the image. The container test writes and compares the fixture with it.

/** The table without run facts (experiment ids, the PDK root of the image, the paths of the records). */
export function normalizeProbe(table) {
	const text = (s) => (typeof s === "string" ? s.replaceAll("/foss/pdks", "$PDK_ROOT").replace(/simra\/experiments\/[\w.-]+\//g, "") : s);
	const classes = {};
	for (const [name, cells] of Object.entries(table.classes)) {
		classes[name] = {};
		for (const [sim, c] of Object.entries(cells)) {
			classes[name][sim] = { description: c.description ?? null, status: c.status, value_a: c.value_a, reason: text(c.reason), gaps: c.gaps ?? [], warnings: (c.warnings ?? []).map(text) };
		}
	}
	const simulators = Object.fromEntries(Object.entries(table.simulators).map(([s, v]) => [s, { version: v.version }]));
	return { schema: table.schema, pdk: table.pdk, pack: table.pack, simulators, classes, agreement: table.agreement };
}
