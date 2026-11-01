// The spec families of the synthesis tasks (evals/synthesis-family.mjs): the targets, the derived limits, the
// committed variants and their scores. The test needs no container: the scorer gets a fake verifier with the
// recorded results of the expected.json of the variant. test/synthesis-target.test.mjs checks that a target from an
// arm run reproduces its recorded results with ngspice.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerOf } from "../evals/ota-synthesis/reference.mjs";
import { scoreSynthesis } from "../evals/ota-synthesis/synthesis.mjs";
import { baseFactors, deriveLimits, referenceTarget, targetOfRun, variantFiles } from "../evals/synthesis-family.mjs";
import { variantDirs } from "./ota-bench-consistency.mjs";

const repo = new URL("../", import.meta.url).pathname;
const TASKS = ["ota-synthesis", "comparator-synthesis"];
const PDKS = ["sg13cmos5l", "sky130"];
const CASES = TASKS.flatMap((task) => PDKS.map((pdk) => ({ task, pdk, dir: join(repo, "evals", task, pdk) })));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const familyOf = (task) => readJson(join(repo, "evals", task, "family.json"));
const label = ({ task, pdk }) => `${task} ${pdk}`;

/** The parsed base spec of a task directory (the parseSpec of the task). */
async function baseSpecOf(task, dir) {
	const { parseSpec } = await import(join(repo, "evals", task, "synthesis.mjs"));
	return parseSpec(readFileSync(join(dir, "spec.md"), "utf8"));
}

/** A score.json of an arm run whose verification is a target result (in the shape of verify()). */
function scoreJsonOf(target, task = target.task) {
	const { design_check, corners } = target.result;
	const verification = Object.fromEntries(Object.entries(corners).map(([c, v]) => [c, { experiment: v.experiment, status: "completed", errors: [], provenance: target.provenance, points: v.sweep, worst: v.worst }]));
	verification.design = { experiment: "fake", ...design_check };
	return { task, arm: "simra", model: "test/model", started_at: "2026-10-31T00:00:00.000Z", sandbox: { image: "test:image", image_id: "sha256:test" }, contamination: [], score: { verification } };
}

for (const c of CASES) {
	test(`synthesis family ${label(c)}: the derived limits of the committed target`, async () => {
		const family = familyOf(c.task);
		const target = readJson(join(c.dir, "target.json"));
		const baseSpec = await baseSpecOf(c.task, c.dir);
		const factors = baseFactors(family, baseSpec, target);
		assert.deepEqual(Object.keys(factors), [...Object.keys(family.requirements), ...Object.keys(family.design)]);
		const largest = Math.max(...Object.values(factors));
		assert.ok(Object.values(factors).every((x) => x >= 1), `the target passes the base task: ${JSON.stringify(factors)}`);
		for (const f of [1, 1.01, 1.05, 1.1, 1.2, 1.3].filter((x) => x < largest)) {
			let limits;
			try {
				limits = deriveLimits(family, baseSpec, target, f);
			} catch (err) {
				assert.match(err.message, /no limit changes after the rounding/, `f ${f}`);
				continue;
			}
			for (const [k, l] of Object.entries(limits)) {
				const at = `f ${f} ${k}`;
				// Never looser than the base.
				assert.ok(l.kind === "upper" ? l.value <= l.base : l.value >= l.base, `${at}: ${l.value}, base ${l.base}`);
				if (!l.changed) {
					assert.equal(l.value, l.base, at);
					continue;
				}
				// At least f times the worst value in the tight direction, tighter than the base, and a multiple of the step.
				assert.ok(l.margin >= f * (1 - 1e-9), `${at}: margin ${l.margin}`);
				assert.ok(l.kind === "upper" ? l.value < l.base : l.value > l.base, at);
				const steps = Number(l.text) / l.step;
				assert.ok(Math.abs(steps - Math.round(steps)) < 1e-9, `${at}: ${l.text} is not a multiple of ${l.step}`);
				assert.ok(Math.abs((Number(l.text) * l.scale) / l.value - 1) < 1e-12, `${at}: text ${l.text} ${l.unit}, value ${l.value}`);
				// The rounding is to the nearest step that keeps the margin: one step looser would break it.
				const looser = Number(l.text) + (l.kind === "upper" ? -l.step : l.step);
				const m = l.kind === "upper" ? (looser * l.scale) / l.worst : l.kind === "lower" ? l.worst / (looser * l.scale) : 10 ** ((l.worst - looser) / 20);
				assert.ok(m < f, `${at}: ${looser} ${l.unit} would keep the margin`);
			}
			assert.ok(Object.values(limits).some((l) => l.changed), `f ${f}`);
		}
		assert.throws(() => deriveLimits(family, baseSpec, target, 0.99), /factor 0\.99 is below 1.*base factors: /);
		assert.throws(() => deriveLimits(family, baseSpec, target, largest), /at or above the largest base factor.*base factors: /);
		assert.throws(() => deriveLimits(family, baseSpec, target, largest + 0.5), /at or above the largest base factor/);
	});

	test(`synthesis family ${label(c)}: the committed target`, async () => {
		const target = readJson(join(c.dir, "target.json"));
		const reference = await referenceTarget(c.dir);
		assert.equal(target.task, readJson(join(c.dir, "task.json")).name);
		assert.ok(target.result.meets_spec, "the target meets the base spec");
		// The target has a worst value of every requirement of the base task (a new requirement needs a new verification).
		const ids = readJson(join(c.dir, "requirements.json")).requirements.filter((r) => r.conditions).map((r) => r.id);
		for (const [k, x] of Object.entries(target.result.corners)) assert.deepEqual(Object.keys(x.worst), ids, `${k}: the requirements of the target`);
		if (target.source.kind === "reference") {
			assert.deepEqual(target, reference, "target.json is targetOf the reference role of expected.json");
			return;
		}
		// A target from a run: at least as good as the reference on every derived metric, and its source names the run.
		assert.equal(target.source.kind, "run");
		assert.deepEqual(Object.keys(target.source), ["kind", "run", "task", "arm", "model", "started_at", "image", "image_id"]);
		assert.doesNotMatch(target.source.run, /\//, "only the base name of the run directory");
		const family = familyOf(c.task);
		const baseSpec = await baseSpecOf(c.task, c.dir);
		const [mine, ref] = [baseFactors(family, baseSpec, target), baseFactors(family, baseSpec, reference)];
		for (const k of Object.keys(mine)) assert.ok(mine[k] >= ref[k], `${k}: base factor ${mine[k]}, reference ${ref[k]}`);
		assert.deepEqual(targetOfRun(scoreJsonOf(target), target.design, family, reference, target.source.run).result, target.result);
	});
}

test("synthesis family: targetOfRun takes a verified run and refuses a failed or worse one", async () => {
	const c = CASES.find((x) => x.task === "comparator-synthesis" && x.pdk === "sg13cmos5l");
	const family = familyOf(c.task);
	const current = await referenceTarget(c.dir);
	const run = "comparator-synthesis-sg13cmos5l-simra-20261031-000000";
	const fake = () => structuredClone(scoreJsonOf(current));

	// The same design point is at least as good: it is taken, with the source of the run.
	const t = targetOfRun(fake(), "* design\n", family, current, run);
	assert.deepEqual(t.source, { kind: "run", run, task: current.task, arm: "simra", model: "test/model", started_at: "2026-10-31T00:00:00.000Z", image: "test:image", image_id: "sha256:test" });
	assert.deepEqual([t.design, t.result, t.provenance], ["* design\n", current.result, current.provenance]);

	const designFails = fake();
	Object.assign(designFails.score.verification.design, { status: "fail", errors: [{ source: "cmp.spice:3", message: "B1: a behavioural source (B) is not allowed" }] });
	assert.throws(() => targetOfRun(designFails, "", family, current, run), /design check of the run is fail: cmp\.spice:3: B1/);

	const rowFails = fake();
	rowFails.score.verification.ss.worst.vos_v.pass = false;
	assert.throws(() => targetOfRun(rowFails, "", family, current, run), /rows of the run fail: ss vos_v/);

	const worse = fake();
	worse.score.verification.ff.worst.tpd_f_s.value *= 1.5;
	worse.score.verification.design.area_um2 += 1;
	assert.throws(() => targetOfRun(worse, "", family, current, run), /worse than the current target on: tpd_f_s .*, area_um2 21\.39 \(target 20\.39\)/);

	// A non-derived metric (the offset) may be worse; a derived one that is better on its own does not suffice.
	const offset = fake();
	offset.score.verification.tt.worst.vos_v.value = 0.004;
	assert.equal(targetOfRun(offset, "", family, current, run).result.corners.tt.worst.vos_v.value, 0.004);
	const mixed = fake();
	mixed.score.verification.tt.worst.tpd_r_s.value /= 2;
	mixed.score.verification.ss.worst.idd_a.value *= 1.1;
	assert.throws(() => targetOfRun(mixed, "", family, current, run), /on: idd_a /);

	const contaminated = fake();
	contaminated.contamination = ["task directory"];
	assert.throws(() => targetOfRun(contaminated, "", family, current, run), /contaminated: task directory/);
	assert.throws(() => targetOfRun(scoreJsonOf(current, "ota-synthesis-sg13cmos5l"), "", family, current, run), /task ota-synthesis-sg13cmos5l/);
	assert.throws(() => targetOfRun({ score: {} }, "", family, current, run), /no verification/);

	// A run of a variant (<task>-f<factor>) can set the target of its base task; the source keeps the variant task.
	const variantRun = `${current.task}-f1.05-simra-20261031-000000`;
	const v = targetOfRun(scoreJsonOf(current, `${current.task}-f1.05`), "* design\n", family, current, variantRun);
	assert.deepEqual([v.task, v.source.task, v.source.run, v.result], [current.task, `${current.task}-f1.05`, variantRun, current.result]);
	// A variant of another task, or a name that is not a variant, is refused.
	assert.throws(() => targetOfRun(scoreJsonOf(current, "ota-synthesis-sg13cmos5l-f1.05"), "", family, current, run), /run is of task ota-synthesis-sg13cmos5l-f1\.05/);
	assert.throws(() => targetOfRun(scoreJsonOf(current, "comparator-synthesis-sky130-f1.05"), "", family, current, run), /run is of task comparator-synthesis-sky130-f1\.05/);
	assert.throws(() => targetOfRun(scoreJsonOf(current, `${current.task}-fast`), "", family, current, run), /run is of task comparator-synthesis-sg13cmos5l-fast/);
});

test("synthesis family: the committed variants", () => {
	for (const c of CASES) assert.ok(variantDirs(join(repo, "evals", c.task), c.pdk).includes(`${c.pdk}-f1.05`), `${label(c)}: the variant f1.05`);
});

for (const c of CASES) {
	for (const v of variantDirs(join(repo, "evals", c.task), c.pdk)) {
		const vdir = join(repo, "evals", c.task, v);
		const factor = v.slice(c.pdk.length + 2);

		test(`synthesis family ${c.task} ${v}: the variant is the output of the generator`, async () => {
			const { dir, files, limits } = await variantFiles(c.dir, factor);
			assert.equal(dir, vdir);
			assert.deepEqual(readdirSync(vdir).sort(), Object.keys(files).sort());
			for (const [name, text] of Object.entries(files)) assert.equal(readFileSync(join(vdir, name), "utf8"), text, `${v}/${name}: run node evals/synthesis-family.mjs variant`);
			// The copies are the files of the base; target.json and expected.json are not task files.
			for (const name of ["task.md", "verify.spice", "simra.config.json", "score.mjs"]) assert.equal(files[name], readFileSync(join(c.dir, name), "utf8"), name);
			const task = readJson(join(vdir, "task.json"));
			assert.equal(task.name, `${readJson(join(c.dir, "task.json")).name}-f${factor}`);
			for (const src of Object.values(task.files)) assert.doesNotMatch(src, /expected\.json|target\.json/);
			// The spec text: the base with one sentence and the changed limit cells.
			const [base, text] = [readFileSync(join(c.dir, "spec.md"), "utf8").split("\n"), files["spec.md"].split("\n")];
			const baseName = readJson(join(c.dir, "task.json")).name;
			assert.match(files["spec.md"], new RegExp(`\\n## Requirements\\n\\nThis specification is a variant of ${baseName} with the limits at factor ${factor} of a hidden design point\\.\\n\\n`));
			const k = text.findIndex((l) => l.startsWith("This specification is a variant"));
			const lines = text.filter((_, i) => i !== k && i !== k + 1);
			assert.equal(lines.length, base.length);
			const differ = base.flatMap((l, i) => (l === lines[i] ? [] : [l]));
			const want = Object.entries(limits)
				.filter(([, l]) => l.changed)
				.map(([id, l]) => (l.where === "design" ? /^- Area: the gate area plus the area of the R and C/ : new RegExp(`\\| \`${id}\` \\|`)));
			assert.equal(differ.length, want.length, `changed lines: ${differ.join(" / ")}`);
			for (const re of want) assert.ok(differ.some((l) => re.test(l)), `${re}`);
		});

		test(`synthesis family ${c.task} ${v}: the target gets every point, the known fail, the cheat and the input load do not`, async (t) => {
			const e = readJson(join(vdir, "expected.json"));
			const { roles } = familyOf(c.task);
			const target = readJson(join(c.dir, "target.json"));
			const { designs } = await import(join(repo, "evals", c.task, "reference.mjs"));
			const known = [...Object.entries(designs(c.pdk)), ["target", target.design]];
			const metrics = Object.keys(e.spec.limits);
			const rows = 3 * metrics.length;
			const verifier = async (_dir, design) => {
				const which = known.find(([, d]) => d === design)?.[0];
				if (!which) throw new Error("fake verifier: unknown design");
				const r = e[which];
				const corners = Object.entries(r.corners).map(([k, x]) => [k, { experiment: x.experiment, status: "completed", errors: [], points: x.sweep, worst: x.worst }]);
				return { ...Object.fromEntries(corners), design: { experiment: "fake", ...r.design_check } };
			};
			const score = async (design, answer) => {
				const ws = mkdtempSync(join(tmpdir(), "simra-family-score-"));
				t.after(() => rmSync(ws, { recursive: true, force: true }));
				writeFileSync(join(ws, e.spec.design.file), design);
				writeFileSync(join(ws, "answer.json"), JSON.stringify(answer));
				const s = await scoreSynthesis(ws, vdir, { verifier, tolerance: e.tolerance });
				return [s.design, s.requirements, s.claim, s.values, s.verified_meets_spec];
			};
			assert.deepEqual(await score(target.design, answerOf(e.target, true, metrics)), [2, rows, 4, rows, true], "the target");
			const [design, requirements, claim, , meets] = await score(designs(c.pdk)[roles.known_fail], answerOf(e[roles.known_fail], true, metrics));
			assert.equal(meets, false, "the known fail");
			assert.ok(design < 2 || requirements < rows, "the known fail");
			assert.equal(claim, 0, "the known fail with the claim that it meets the spec");
			assert.deepEqual((await score(designs(c.pdk)[roles.cheat], answerOf(e[roles.cheat], true, metrics))).slice(0, 2), [0, 0], "the cheat");
			assert.ok(e[roles.cheat].rows_pass, "the cheat passes every row of the simulation");
			// The input load fails iin_a, a fixed limit, at every corner.
			assert.deepEqual(Object.values(e[roles.input_load].corners).map((x) => x.worst.iin_a.pass), [false, false, false], "the input load");
			assert.equal(e[roles.input_load].meets_spec, false, "the input load");
			// The reference roles keep their values; only the pass flags of the derived limits can change.
			const baseExpected = readJson(join(c.dir, "expected.json"));
			for (const role of Object.values(roles)) {
				for (const [k, x] of Object.entries(e[role].corners)) {
					for (const m of metrics) assert.equal(x.worst[m].value, baseExpected[role].corners[k].worst[m].value, `${role} ${k} ${m}`);
				}
				assert.deepEqual(e[role].corners.tt.sweep, baseExpected[role].corners.tt.sweep);
			}
			assert.equal(e.provenance.derived_from, `evals/${c.task}/${c.pdk}/expected.json`);
			assert.deepEqual([e.provenance.target, e.provenance.factor, e.target.source], [target.source, Number(factor), target.source]);
			assert.ok(existsSync(join(vdir, "expected.json")));
		});
	}
}
