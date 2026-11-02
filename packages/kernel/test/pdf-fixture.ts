// A small PDF writer for the tests: Letter pages with Helvetica text lines, or a blue rectangle and no text,
// and an optional outline. With encrypted, the file has a /Encrypt dictionary that the empty password does not open.

export interface FixturePage {
	/** Text lines of the page; without lines, the page has only a blue rectangle and no text layer. */
	lines?: string[];
}

export function makePdf(pages: FixturePage[], options: { outline?: { title: string; page: number }[]; encrypted?: boolean } = {}): Buffer {
	const objects: string[] = [];
	const add = (body: string) => objects.push(body);
	const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
	const firstPage = 4;
	const pageRef = (n: number) => `${firstPage + 2 * (n - 1)} 0 R`;
	const outlineObj = firstPage + 2 * pages.length;
	const outline = options.outline ?? [];

	add(`<< /Type /Catalog /Pages 2 0 R${outline.length ? ` /Outlines ${outlineObj} 0 R` : ""} >>`);
	add(`<< /Type /Pages /Kids [${pages.map((_, i) => pageRef(i + 1)).join(" ")}] /Count ${pages.length} >>`);
	add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	pages.forEach((page, i) => {
		const stream = page.lines
			? `BT /F1 12 Tf 14 TL 72 720 Td ${page.lines.map((l) => `(${escape(l)}) Tj T*`).join(" ")} ET`
			: "0 0 1 rg 72 72 468 648 re f";
		add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPage + 2 * i + 1} 0 R >>`);
		add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	});
	if (outline.length) {
		const item = (k: number) => outlineObj + 1 + k;
		add(`<< /Type /Outlines /First ${item(0)} 0 R /Last ${item(outline.length - 1)} 0 R /Count ${outline.length} >>`);
		outline.forEach((entry, k) => {
			const links = [k > 0 ? `/Prev ${item(k - 1)} 0 R` : "", k < outline.length - 1 ? `/Next ${item(k + 1)} 0 R` : ""].join(" ");
			add(`<< /Title (${escape(entry.title)}) /Parent ${outlineObj} 0 R ${links} /Dest [${pageRef(entry.page)} /Fit] >>`);
		});
	}
	let trailerExtra = "";
	if (options.encrypted) {
		const hex32 = (byte: string) => byte.repeat(32);
		add(`<< /Filter /Standard /V 1 /R 2 /O <${hex32("ab")}> /U <${hex32("cd")}> /P -44 >>`);
		trailerExtra = ` /Encrypt ${objects.length} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]`;
	}

	let pdf = "%PDF-1.4\n";
	const offsets = objects.map((body, i) => {
		const offset = pdf.length;
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
		return offset;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}
