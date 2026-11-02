// The PDF reader on PDFs that the test writes: page markers, header, meta.json, the cache, the no-text warning,
// encrypted and broken files, and the command simra pdf. It needs no network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheRoot, extractPdf, pdfPages } from "../src/index.ts";
import { makePdf } from "./pdf-fixture.ts";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;

/** A temporary folder with the cache in it and the 3-page test PDF. Page 2 has no text. */
function setup(t: { after: (fn: () => void) => void }) {
	const dir = mkdtempSync(join(tmpdir(), "simra-pdf-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const saved = process.env.SIMRA_CACHE_DIR;
	process.env.SIMRA_CACHE_DIR = join(dir, "cache");
	t.after(() => (saved === undefined ? delete process.env.SIMRA_CACHE_DIR : (process.env.SIMRA_CACHE_DIR = saved)));
	const data = makePdf([{ lines: ["Design rules", "M1.a min width = 0.16 um"] }, {}, { lines: ["Process spec", "VDD = 1.2 V (nominal)"] }], {
		outline: [{ title: "Rules", page: 1 }, { title: "Spec", page: 3 }],
	});
	const pdf = join(dir, "rules.pdf");
	writeFileSync(pdf, data);
	return { dir, pdf, cache: join(dir, "cache"), sha256: createHash("sha256").update(data).digest("hex") };
}

test("the cache is SIMRA_CACHE_DIR, else XDG_CACHE_HOME/simra, else ~/.cache/simra, as an absolute path", () => {
	assert.equal(cacheRoot({ SIMRA_CACHE_DIR: "/c", XDG_CACHE_HOME: "/x" }), "/c");
	assert.equal(cacheRoot({ SIMRA_CACHE_DIR: "c" }), join(process.cwd(), "c"));
	assert.equal(cacheRoot({ XDG_CACHE_HOME: "/x" }), "/x/simra");
	assert.equal(cacheRoot({}), join(homedir(), ".cache", "simra"));
});

test("extractPdf writes document.md with page markers and a header, and meta.json", async (t) => {
	const { pdf, cache, sha256 } = setup(t);
	const doc = await extractPdf(pdf);
	assert.equal(doc.cached, false);
	assert.equal(doc.dir, join(cache, "pdf", sha256));
	assert.equal(doc.document, join(doc.dir, "document.md"));

	const meta = JSON.parse(readFileSync(join(doc.dir, "meta.json"), "utf8"));
	assert.deepEqual(meta, doc.meta);
	assert.equal(meta.schema, "simra.pdf/0");
	assert.equal(meta.sha256, sha256);
	assert.equal(meta.source, pdf);
	assert.equal(meta.pages, 3);
	assert.deepEqual(meta.outline, [{ title: "Rules", level: 0, page: 1 }, { title: "Spec", level: 0, page: 3 }]);
	assert.deepEqual(meta.warnings, ["No text layer on page 2. There is no OCR."]);

	// Each marker is at its line in meta.json, and the text of the page follows it.
	const lines = readFileSync(doc.document, "utf8").split("\n");
	assert.deepEqual(meta.page_lines.map((n: number) => lines[n - 1]), ["[page 1]", "[page 2]", "[page 3]"]);
	assert.deepEqual(lines.slice(meta.page_lines[0], meta.page_lines[0] + 2), ["Design rules", "M1.a min width = 0.16 um"]);
	assert.equal(lines[meta.page_lines[1]], "(no text layer)");
	assert.deepEqual(lines.slice(meta.page_lines[2], meta.page_lines[2] + 2), ["Process spec", "VDD = 1.2 V (nominal)"]);

	const header = lines.slice(0, meta.page_lines[0] - 1).join("\n");
	assert.match(header, /^# rules\.pdf\n/);
	assert.ok(header.includes(`Source: ${pdf}\nSHA-256: ${sha256}\nPages: 3\nText file: ${doc.document}\n`));
	assert.ok(header.includes(`Outline:\n- Rules: page 1, line ${meta.page_lines[0]}\n- Spec: page 3, line ${meta.page_lines[2]}\n`));
	assert.ok(header.includes("Warnings:\n- No text layer on page 2. There is no OCR.\n"));
	assert.match(header, /grep the text file/);
	assert.match(header, /Cite each fact with its page, for example \[page 12\]\./);
});

test("a second extraction of the same content uses the cache", async (t) => {
	const { dir, pdf } = setup(t);
	const first = await extractPdf(pdf);
	const mtime = statSync(first.document).mtimeMs;
	const copy = join(dir, "copy.pdf");
	writeFileSync(copy, readFileSync(pdf));
	const second = await extractPdf(copy);
	assert.equal(second.cached, true);
	assert.equal(second.dir, first.dir);
	assert.deepEqual(second.meta, first.meta);
	assert.equal(statSync(second.document).mtimeMs, mtime);
});

test("a line break in the path does not move the page lines", async (t) => {
	const { dir, pdf } = setup(t);
	const odd = join(dir, "a\nb.pdf");
	writeFileSync(odd, readFileSync(pdf));
	const doc = await extractPdf(odd);
	const lines = readFileSync(doc.document, "utf8").split("\n");
	assert.deepEqual(doc.meta.page_lines.map((n) => lines[n - 1]), ["[page 1]", "[page 2]", "[page 3]"]);
});

test("an encrypted, broken or empty PDF gives a clear error and leaves no cache", async (t) => {
	const { dir, cache } = setup(t);
	const encrypted = join(dir, "encrypted.pdf");
	writeFileSync(encrypted, makePdf([{ lines: ["secret"] }], { encrypted: true }));
	await assert.rejects(extractPdf(encrypted), { message: `${encrypted}: the PDF is encrypted and needs a password. Give a copy without a password.` });
	const broken = join(dir, "broken.pdf");
	writeFileSync(broken, "%PDF-1.4\nthis is not a PDF\n");
	await assert.rejects(extractPdf(broken), /broken\.pdf: cannot read the PDF \(.+\)\. The file is broken or is not a PDF\.$/);
	const empty = join(dir, "empty.pdf");
	writeFileSync(empty, makePdf([]));
	await assert.rejects(extractPdf(empty), { message: `${empty}: cannot read the PDF (it has no pages). The file is broken or is not a PDF.` });
	assert.equal(existsSync(cache), false);
});

test("pdfPages and simra pdf --pages give the header and the selected pages", async (t) => {
	const { pdf, cache } = setup(t);
	const doc = await extractPdf(pdf);
	const page3 = pdfPages(doc, 3, 3);
	assert.match(page3, /^# rules\.pdf\n[^]*Cite each fact[^]*\n\n\[page 3\]\nProcess spec\n/);
	assert.doesNotMatch(page3, /\[page [12]\]\n/);
	assert.equal(pdfPages(doc), readFileSync(doc.document, "utf8"));
	assert.throws(() => pdfPages(doc, 2, 4), { message: "pages 2-4: the PDF has pages 1-3" });

	const run = (...args: string[]) => spawnSync(process.execPath, [cli, "pdf", pdf, ...args], { env: { ...process.env, SIMRA_CACHE_DIR: cache }, encoding: "utf8" });
	const one = run("--pages", "1-2");
	assert.equal(one.status, 0, one.stderr);
	assert.equal(one.stdout, pdfPages(doc, 1, 2));
	assert.equal(run().stdout, pdfPages(doc));
	const bad = run("--pages", "0-9");
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /^simra: pages 0-9: the PDF has pages 1-3/);
});
