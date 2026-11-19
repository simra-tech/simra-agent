// The table of the device-class probe (formatProbeTable) from the stored IHP SG13G2 probe, without a simulator.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatProbeTable, relativeDifference } from "@simra-tech/kernel";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/device-probe/ihp-sg13g2.json", import.meta.url), "utf8"));

test("device-probe table: the stored IHP SG13G2 probe gives the class x simulator table and the reasons", () => {
	const text = formatProbeTable({ ...fixture, simulators: Object.fromEntries(Object.entries(fixture.simulators).map(([s, v]) => [s, { ...v, experiment: null, status: "completed" }])) });
	assert.match(text, /^class +ngspice +xyce/m);
	assert.match(text, /^mos_lv_nmos +simulates +fails/m);
	assert.match(text, /^hbt_npn13G2 +simulates +simulates/m);
	assert.match(text, /^ngspice: 18 simulates; xyce: 8 fails, 10 simulates$/m);
	assert.match(text, /^ {2}varactor_hv \/ xyce: fails: subcircuit missing: Subcircuit SG13_HV_SVARICAP has not been defined/m);
	assert.match(text, /^ {2}res_rsil \/ xyce: fails: parameter unrecognized: Unrecognized parameter 1 for device YR3_CMC!R1 \(\$PDK_ROOT\/ihp-sg13g2\/libs\.tech\/xyce\/models\/resistors_mod\.lib:66\)$/m);
	assert.match(text, /^simulators disagree .*\n {2}dio_dantenna: 37\.9 %/m);
	assert.ok(fixture.agreement.hbt_npn13G2 < 1e-3, "ngspice and Xyce agree on the HBT current");
	assert.equal(relativeDifference([1, 1]), 0);
	assert.equal(relativeDifference([0, 1e-16]), 0);
	assert.equal(relativeDifference([1, 2]), 0.5);
});
