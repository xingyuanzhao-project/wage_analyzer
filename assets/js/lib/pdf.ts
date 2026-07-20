/**
 * Minimal, dependency-free PDF writer for plain structured text.
 *
 * The aggregated report already exists as structured plain text -- the exact
 * string the Copy button produces (aggregateReportToText). This turns that text
 * into a real, downloadable, text-selectable PDF with no PDF library and no
 * build step, so it works on a plain static host.
 *
 * It sets the text in the standard Courier / Courier-Bold fonts, which need no
 * embedded font program and no glyph-width table: every Courier glyph advances
 * exactly 0.6em, so line wrapping is computed exactly and text can never spill
 * past the page margins -- the layout cannot "break".
 *
 * Text conventions (matching aggregateReportToText's output):
 *   - a blank line is vertical space,
 *   - a line beginning "- " is a bullet, wrapped with a hanging indent,
 *   - a line ending ":" is a section heading, set bold,
 *   - the first line is the title, set bold.
 */

const PAGE_W = 612; // US Letter, PostScript points (1/72 in)
const PAGE_H = 792;
const MARGIN = 54; // 0.75 in
const FONT_SIZE = 10;
const LEADING = 14;
const CHAR_W = FONT_SIZE * 0.6; // Courier advance width per glyph
const MAX_CHARS = Math.floor((PAGE_W - MARGIN * 2) / CHAR_W);
const TOP_BASELINE = PAGE_H - MARGIN - FONT_SIZE;
const LINES_PER_PAGE = Math.floor((TOP_BASELINE - MARGIN) / LEADING) + 1;
const BULLET_INDENT = 2; // spaces a wrapped bullet's continuation lines align to

interface PhysicalLine {
  text: string;
  bold: boolean;
}

// WinAnsi byte for the few non-Latin-1 code points the report can contain; every
// other char in 0x20-0xFF passes through unchanged and anything unmapped becomes
// '?', so an unexpected glyph degrades rather than corrupting the byte stream.
const WINANSI: Record<number, number> = {
  0x2013: 0x96, // en dash
  0x2014: 0x97, // em dash
  0x2018: 0x91, // left single quote
  0x2019: 0x92, // right single quote
  0x201c: 0x93, // left double quote
  0x201d: 0x94, // right double quote
  0x2022: 0x95, // bullet
  0x2026: 0x85, // ellipsis
  0x2122: 0x99, // trademark
  0x20ac: 0x80, // euro
};

/** Encode one text run to a one-byte-per-char WinAnsi string, escaping the three
 *  characters that are syntactically special inside a PDF literal string. */
function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x5c || cp === 0x28 || cp === 0x29) {
      out += "\\" + ch; // \  (  )
      continue;
    }
    let b: number;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) b = cp;
    else if (WINANSI[cp] !== undefined) b = WINANSI[cp];
    else b = 0x3f; // '?'
    out += String.fromCharCode(b);
  }
  return out;
}

/** Greedy word-wrap to MAX_CHARS with a hanging indent on continuation lines,
 *  plus a hard cut for any single token wider than the usable width. */
function wrap(text: string, hanging: number): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const pad = " ".repeat(hanging);
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const prefix = line === "" ? (out.length ? pad : "") : line + " ";
    const candidate = prefix + word;
    if (candidate.length > MAX_CHARS && line !== "") {
      out.push(line);
      line = pad + word;
    } else {
      line = candidate;
    }
  }
  if (line) out.push(line);
  return out.flatMap((l) => {
    if (l.length <= MAX_CHARS) return [l];
    const chunks: string[] = [];
    for (let i = 0; i < l.length; i += MAX_CHARS) chunks.push(l.slice(i, i + MAX_CHARS));
    return chunks;
  });
}

/** Classify the report's logical lines and flatten them to wrapped physical lines. */
function toPhysicalLines(text: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  text.split("\n").forEach((raw, index) => {
    if (raw.trim() === "") {
      lines.push({ text: "", bold: false });
      return;
    }
    const bullet = raw.startsWith("- ");
    const heading = index === 0 || (!bullet && raw.endsWith(":"));
    for (const wrapped of wrap(raw, bullet ? BULLET_INDENT : 0)) {
      lines.push({ text: wrapped, bold: heading });
    }
  });
  return lines;
}

/** The content stream (text-drawing operators) for one page of physical lines. */
function pageContent(lines: PhysicalLine[]): string {
  let s = `BT\n${LEADING} TL\n${MARGIN} ${TOP_BASELINE} Td\n`;
  for (const ln of lines) {
    if (ln.text !== "") {
      s += `/${ln.bold ? "F2" : "F1"} ${FONT_SIZE} Tf (${pdfString(ln.text)}) Tj\n`;
    }
    s += "T*\n"; // advance one line (T* uses the leading set above)
  }
  return s + "ET";
}

/** Render structured plain text to a downloadable PDF Blob. */
export function textToPdfBlob(text: string): Blob {
  const physical = toPhysicalLines(text);
  const pages: PhysicalLine[][] = [];
  for (let i = 0; i < physical.length; i += LINES_PER_PAGE) {
    pages.push(physical.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push([]);

  // Fixed object numbering: 1 Catalog, 2 Pages, 3 Courier, 4 Courier-Bold, then
  // a (page, content) pair per page starting at 5.
  const objects: { num: number; body: string }[] = [
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    {
      num: 2,
      body: `<< /Type /Pages /Count ${pages.length} /Kids [${pages
        .map((_, i) => `${5 + i * 2} 0 R`)
        .join(" ")}] >>`,
    },
    { num: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>" },
    { num: 4, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>" },
  ];
  pages.forEach((lines, i) => {
    const pageNum = 5 + i * 2;
    const contentNum = pageNum + 1;
    objects.push({
      num: pageNum,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentNum} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`,
    });
    const content = pageContent(lines);
    objects.push({ num: contentNum, body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream` });
  });

  // Serialize with byte offsets. Every byte written here is < 0x100, so one
  // string char is exactly one byte and string length equals the byte offset.
  const maxNum = objects[objects.length - 1].num;
  const offsets = new Array<number>(maxNum + 1).fill(0);
  let pdf = "%PDF-1.4\n";
  for (const { num, body } of objects) {
    offsets[num] = pdf.length;
    pdf += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++) {
    pdf += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type: "application/pdf" });
}
