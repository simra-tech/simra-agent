// PDF reader: the text of a PDF with a "[page N]" marker before each page, and page images, in a per-user cache.
// It does not need pi.
//
// extractPdf(file) writes pdf/<sha256>/ in the cache: document.md (a short header, then the pages) and meta.json
// (hash, page count, outline, warnings, the line of each page marker). renderPage(file, N) also renders page N to
// page-N.png in that folder (PDFium), at about 150 dpi.
// The cache is $SIMRA_CACHE_DIR, else $XDG_CACHE_HOME/simra, else ~/.cache/simra. It is safe to delete. A second call
// for the same content uses the cache. An encrypted or broken file gives an error and leaves nothing in the cache.
// There is no OCR.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { PNG } from "pngjs";
import { extractText, getDocumentProxy } from "unpdf";

export const PDF_SCHEMA = "simra.pdf/0";

/** The outline entries that the header of document.md shows. meta.json has all entries. */
const OUTLINE_IN_HEADER = 200;
/** Page images: about 150 dpi, with at most 2000 pixels on the long side (the limit at which pi resizes an image). */
const RENDER_DPI = 150;
const RENDER_MAX_PX = 2000;

export interface PdfOutlineEntry {
	title: string;
	/** 0 for a top-level entry. */
	level: number;
	/** The page that the entry points to, or null when the destination is not a page of the file. */
	page: number | null;
}

export interface PdfMeta {
	schema: typeof PDF_SCHEMA;
	sha256: string;
	/** The absolute path of the file when it was extracted. */
	source: string;
	pages: number;
	outline: PdfOutlineEntry[];
	warnings: string[];
	/** page_lines[N - 1] is the line (from 1) of the "[page N]" marker in document.md. */
	page_lines: number[];
}

export interface PdfDocument {
	/** The cache folder of the file: pdf/<sha256>/, with page-N.png for page N after renderPage. */
	dir: string;
	/** document.md in dir. */
	document: string;
	meta: PdfMeta;
	/** true when the cache already had the file. */
	cached: boolean;
}

/** The absolute path of the cache. */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.SIMRA_CACHE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "simra"));
}

function loadMeta(dir: string): PdfMeta | null {
	try {
		const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as PdfMeta;
		return meta.schema === PDF_SCHEMA && existsSync(join(dir, "document.md")) ? meta : null;
	} catch {
		return null;
	}
}

/** Page numbers as a short list, for example "page 2" or "pages 2, 5-7". */
function pageList(pages: number[]): string {
	const ranges: string[] = [];
	for (let i = 0; i < pages.length; i++) {
		let j = i;
		while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
		ranges.push(j === i ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
		i = j;
	}
	return `${pages.length === 1 ? "page" : "pages"} ${ranges.join(", ")}`;
}

function cleanText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "");
}

/** The text of each page and the outline. An encrypted or broken file gives an error with the reason. */
async function readPdf(source: string, data: Buffer): Promise<{ texts: string[]; outline: PdfOutlineEntry[] }> {
	const fail = (e: unknown): never => {
		const error = e as Error;
		if (error.name === "PasswordException") {
			throw new Error(`${source}: the PDF is encrypted and needs a password. Give a copy without a password.`);
		}
		throw new Error(`${source}: cannot read the PDF (${error.message}). The file is broken or is not a PDF.`);
	};
	const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 }).catch(fail);
	try {
		if (pdf.numPages === 0) throw new Error("it has no pages");
		const { text } = await extractText(pdf);
		const page = async (dest: unknown): Promise<number | null> => {
			try {
				const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
				const ref = Array.isArray(explicit) ? explicit[0] : null;
				if (ref === null || ref === undefined) return null;
				return (typeof ref === "number" ? ref : await pdf.getPageIndex(ref)) + 1;
			} catch {
				return null;
			}
		};
		const outline: PdfOutlineEntry[] = [];
		const walk = async (items: { title: string; dest: unknown; items?: unknown[] }[], level: number) => {
			for (const item of items) {
				outline.push({ title: item.title.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim(), level, page: await page(item.dest) });
				await walk((item.items ?? []) as typeof items, level + 1);
			}
		};
		await walk((await pdf.getOutline()) ?? [], 0);
		return { texts: text.map(cleanText), outline };
	} catch (e) {
		return fail(e);
	} finally {
		await pdf.loadingTask.destroy();
	}
}

/** document.md and its meta.json. The page lines do not change the number of lines of the header. */
function buildDocument(source: string, sha256: string, dir: string, texts: string[], outline: PdfOutlineEntry[]) {
	const empty = texts.flatMap((text, i) => (text ? [] : [i + 1]));
	const warnings = empty.length > 0 ? [`No text layer on ${pageList(empty)}. There is no OCR. To see a page, read the PDF path with #page=N at the end.`] : [];
	const shown = outline.slice(0, OUTLINE_IN_HEADER);
	const header = (pageLines: number[]) => [
		`# ${basename(source)}`,
		"",
		`Source: ${source}`,
		`SHA-256: ${sha256}`,
		`Pages: ${texts.length}`,
		`Text file: ${join(dir, "document.md")}`,
		"",
		...(shown.length === 0
			? ["Outline: none"]
			: [
					"Outline:",
					...shown.map((e) => `${"  ".repeat(e.level)}- ${e.title}: ${e.page === null ? "no page" : `page ${e.page}, line ${pageLines[e.page - 1]}`}`),
					...(outline.length > shown.length ? [`- (${outline.length - shown.length} more entries in meta.json)`] : []),
				]),
		"",
		...(warnings.length === 0 ? ["Warnings: none"] : ["Warnings:", ...warnings.map((w) => `- ${w}`)]),
		"",
		'Each page starts with a line "[page N]". N is the page number in the PDF file (the first page is 1), not the printed page label.',
		"To find a term, grep the text file. To read page N, read from the line of its marker (the outline and meta.json give the lines).",
		`To see page N as an image (for example a figure or a table), read ${source}#page=N, or run simra pdf <file> --render N.`,
		"Cite each fact with its page, for example [page 12].",
		"",
	];
	const noText = (n: number) => `(no text layer. To see this page, read the PDF path with #page=${n} at the end)`;
	const pages = texts.map((text, i) => [`[page ${i + 1}]`, text || noText(i + 1), ""].join("\n").split("\n"));
	const pageLines: number[] = [];
	// A path in the header can contain a line break.
	let line = header([]).join("\n").split("\n").length + 1;
	for (const lines of pages) {
		pageLines.push(line);
		line += lines.length;
	}
	const document = [...header(pageLines), ...pages.flat()].join("\n");
	const meta: PdfMeta = { schema: PDF_SCHEMA, sha256, source, pages: texts.length, outline, warnings, page_lines: pageLines };
	return { document, meta };
}

/** The absolute path, the content and the SHA-256 of a file. */
function load(file: string) {
	const source = resolve(file);
	const data = readFileSync(source);
	return { source, data, sha256: createHash("sha256").update(data).digest("hex") };
}

/** Extract a PDF into the cache, or use the cache when it has the file. */
export async function extractPdf(file: string): Promise<PdfDocument> {
	return extract(load(file));
}

async function extract({ source, data, sha256 }: ReturnType<typeof load>): Promise<PdfDocument> {
	const base = join(cacheRoot(), "pdf");
	const dir = join(base, sha256);
	const result = (meta: PdfMeta, cached: boolean) => ({ dir, document: join(dir, "document.md"), meta, cached });
	const found = loadMeta(dir);
	if (found) return result(found, true);

	const { texts, outline } = await readPdf(source, data);
	const { document, meta } = buildDocument(source, sha256, dir, texts, outline);
	// Write into a temporary folder and rename it, so that the cache never has a part of a document.
	mkdirSync(base, { recursive: true });
	const tmp = mkdtempSync(join(base, ".tmp-"));
	try {
		writeFileSync(join(tmp, "document.md"), document);
		writeFileSync(join(tmp, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
		if (existsSync(dir) && !loadMeta(dir)) rmSync(dir, { recursive: true, force: true });
		renameSync(tmp, dir);
	} catch (e) {
		rmSync(tmp, { recursive: true, force: true });
		// Another process can write the same folder at the same time.
		const other = loadMeta(dir);
		if (other) return result(other, true);
		throw e;
	}
	return result(meta, false);
}

/** The header of document.md and the pages first to last (default: all pages). */
export function pdfPages(doc: PdfDocument, first = 1, last = doc.meta.pages): string {
	const { pages, page_lines: at } = doc.meta;
	if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > pages || first > last) {
		throw new Error(`pages ${first}-${last}: the PDF has pages 1-${pages}`);
	}
	const lines = readFileSync(doc.document, "utf8").split("\n");
	return [...lines.slice(0, at[0] - 1), ...lines.slice(at[first - 1] - 1, last < pages ? at[last] - 1 : lines.length)].join("\n");
}

let pdfium: Promise<PDFiumLibrary> | undefined;
let renderQueue: Promise<unknown> = Promise.resolve();

/**
 * Render page N of a PDF to page-N.png in its cache folder, if the folder does not have it, and give its path.
 * The page renders from the same bytes as the hash of the folder. Pages render one at a time, because PDFium is not
 * thread-safe.
 */
export async function renderPage(file: string, page: number): Promise<string> {
	const pdf = load(file);
	const { dir, meta } = await extract(pdf);
	if (!Number.isInteger(page) || page < 1 || page > meta.pages) throw new Error(`page ${page}: the PDF has pages 1-${meta.pages}`);
	const png = join(dir, `page-${page}.png`);
	if (existsSync(png)) return png;
	const render = renderQueue.then(async () => {
		if (existsSync(png)) return png;
		pdfium ??= PDFiumLibrary.init();
		const doc = await (await pdfium).loadDocument(pdf.data);
		try {
			const pdfPage = doc.getPage(page - 1);
			const { originalWidth, originalHeight } = pdfPage.getOriginalSize();
			const scale = Math.min(RENDER_DPI / 72, RENDER_MAX_PX / Math.max(originalWidth, originalHeight));
			const { width, height, data } = await pdfPage.render({ scale, renderFormFields: true });
			const image = new PNG({ width, height });
			image.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
			const tmp = `${png}.${process.pid}.tmp`;
			writeFileSync(tmp, PNG.sync.write(image, { colorType: 2 }));
			renameSync(tmp, png);
			return png;
		} catch (e) {
			throw new Error(`${pdf.source}: cannot render page ${page} (${(e as Error).message})`);
		} finally {
			doc.destroy();
		}
	});
	renderQueue = render.catch(() => {});
	return render;
}
