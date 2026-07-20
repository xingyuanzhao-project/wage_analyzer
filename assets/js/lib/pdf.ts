/**
 * Minimal, dependency-free *vector* PDF writer.
 *
 * The aggregated report has an on-screen HTML view (renderAggregateReport) with
 * a specific visual layout -- role cards carrying four scaled wage bars, code +
 * title sub-role pills, and each pooled section as a headed bullet list with
 * per-item role chips. This module gives that layout a matching downloadable
 * PDF: it draws text runs, filled boxes, wage bars and rounded pills as raw PDF
 * content-stream operators, so it needs no PDF library and no build step and
 * runs on a plain static host. onetView.ts composes the report on top of it.
 *
 * Text is set only in the standard Helvetica / Helvetica-Bold fonts, which need
 * no embedded font program. Their fixed AFM advance widths (WIDTHS below) are
 * used to measure and wrap every run, so lines never spill past the margins and
 * chips/values are placed at exact widths.
 */

// US Letter, PostScript points (1/72 in).
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54; // 0.75 in

/** Adobe AFM advance widths (per 1000 em) for printable ASCII 0x20-0x7E,
 *  indexed by (codePoint - 32). Two tables: Helvetica and Helvetica-Bold. */
// prettier-ignore
const W_REG = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,
  556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,
  500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,
  500,722,500,500,500,334,260,334,584,
];
// prettier-ignore
const W_BOLD = [
  278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,
  556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,
  556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,
  556,778,556,556,500,389,280,389,584,
];

/** Advance widths for the few non-ASCII code points the report can contain
 *  (matching the WINANSI map below): [regular, bold], per 1000 em. */
const W_SPECIAL: Record<number, [number, number]> = {
  0x2013: [556, 556], // en dash
  0x2014: [1000, 1000], // em dash
  0x2018: [222, 278], // left single quote
  0x2019: [222, 278], // right single quote
  0x201c: [333, 500], // left double quote
  0x201d: [333, 500], // right double quote
  0x2022: [350, 350], // bullet
  0x2026: [1000, 1000], // ellipsis
  0x2122: [1000, 1000], // trademark
  0x20ac: [556, 556], // euro
};

// WinAnsi byte for the same non-Latin-1 code points; every other char in
// 0x20-0xFF passes through unchanged and anything unmapped becomes '?', so an
// unexpected glyph degrades rather than corrupting the byte stream.
const WINANSI: Record<number, number> = {
  0x2013: 0x96,
  0x2014: 0x97,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2026: 0x85,
  0x2122: 0x99,
  0x20ac: 0x80,
};

export interface Color {
  r: number;
  g: number;
  b: number;
}

/** Parse "#rrggbb" into a 0..1 RGB triple. */
export function rgb(hex: string): Color {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

const BLACK: Color = { r: 0, g: 0, b: 0 };

export interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: Color;
}
export interface BoxOpts {
  fill?: Color;
  stroke?: Color;
  radius?: number;
  lineWidth?: number;
}
/** A styled run of text; a paragraph flows a sequence of these as words. */
export interface Run {
  text: string;
  bold?: boolean;
  color?: Color;
}

/** Round to 2 decimals and stringify -- compact, exact enough for layout. */
const n = (x: number): string => (Math.round(x * 100) / 100).toString();
const col = (c: Color): string => `${n(c.r)} ${n(c.g)} ${n(c.b)}`;

/** Encode a text run to one-byte-per-char WinAnsi, escaping the three characters
 *  that are syntactically special inside a PDF literal string. */
function enc(text: string): string {
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

/** Advance width of one code point at 1pt, in the given weight. Unknown glyphs
 *  fall back to '?' -- the same char enc() substitutes -- so width matches ink. */
function glyphWidth(cp: number, bold: boolean): number {
  const table = bold ? W_BOLD : W_REG;
  if (cp >= 0x20 && cp <= 0x7e) return table[cp - 0x20] / 1000;
  const sp = W_SPECIAL[cp];
  if (sp) return sp[bold ? 1 : 0] / 1000;
  return table[0x3f - 0x20] / 1000;
}

/**
 * A single page's content stream, drawn in a top-left origin coordinate space
 * (x from the left margin, `top` measured downward from the page top) that the
 * builder converts to PDF's bottom-left origin on emit.
 */
class Page {
  ops: string[] = [];
}

export class Pdf {
  readonly pageW = PAGE_W;
  readonly pageH = PAGE_H;
  readonly margin = MARGIN;
  readonly contentW = PAGE_W - MARGIN * 2;
  /** Largest `top` a line may occupy before it must move to the next page. */
  readonly contentBottom = PAGE_H - MARGIN;
  /** Current vertical cursor, measured downward from the page top. */
  top = MARGIN;

  private pages: Page[] = [];
  private page: Page;

  constructor() {
    this.page = new Page();
    this.pages.push(this.page);
  }

  /** Start a fresh page and reset the cursor to the top margin. */
  newPage(): void {
    this.page = new Page();
    this.pages.push(this.page);
    this.top = MARGIN;
  }

  /** Break to a new page if a block of height `h` would cross the bottom margin. */
  ensure(h: number): void {
    if (this.top + h > this.contentBottom) this.newPage();
  }

  /** Width in points of `text` set at `size` in the given weight. */
  measure(text: string, size: number, bold = false): number {
    let w = 0;
    for (const ch of text) w += glyphWidth(ch.codePointAt(0) as number, bold);
    return w * size;
  }

  /** Greedy word-wrap to `maxWidth`, hard-breaking any single word too wide to fit. */
  wrap(text: string, size: number, bold: boolean, maxWidth: number): string[] {
    const out: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const cand = line ? line + " " + word : word;
      if (this.measure(cand, size, bold) <= maxWidth) {
        line = cand;
        continue;
      }
      if (line) {
        out.push(line);
        line = "";
      }
      if (this.measure(word, size, bold) <= maxWidth) {
        line = word;
      } else {
        const parts = this.hardBreak(word, size, bold, maxWidth);
        out.push(...parts.slice(0, -1));
        line = parts[parts.length - 1];
      }
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  }

  private hardBreak(word: string, size: number, bold: boolean, maxWidth: number): string[] {
    const parts: string[] = [];
    let cur = "";
    for (const ch of word) {
      if (cur && this.measure(cur + ch, size, bold) > maxWidth) {
        parts.push(cur);
        cur = ch;
      } else {
        cur += ch;
      }
    }
    if (cur) parts.push(cur);
    return parts.length ? parts : [word];
  }

  /** Draw one text run whose em box top sits at `top` (baseline derived from it). */
  text(x: number, top: number, str: string, o: TextOpts = {}): void {
    const size = o.size ?? 10;
    const baseline = PAGE_H - (top + size * 0.8);
    this.page.ops.push(
      `BT ${col(o.color ?? BLACK)} rg /${o.bold ? "F2" : "F1"} ${n(size)} Tf ` +
        `${n(x)} ${n(baseline)} Td (${enc(str)}) Tj ET`,
    );
  }

  /** Draw a filled and/or stroked rectangle, optionally with rounded corners. */
  box(x: number, top: number, w: number, h: number, o: BoxOpts = {}): void {
    if (w <= 0 || h <= 0) return;
    const yb = PAGE_H - (top + h);
    const path = o.radius && o.radius > 0 ? roundRect(x, yb, w, h, o.radius) : `${n(x)} ${n(yb)} ${n(w)} ${n(h)} re`;
    let s = "";
    if (o.fill) s += `${col(o.fill)} rg `;
    if (o.stroke) s += `${col(o.stroke)} RG ${n(o.lineWidth ?? 0.75)} w `;
    s += path + " " + (o.fill && o.stroke ? "B" : o.fill ? "f" : "S");
    this.page.ops.push(s);
  }

  /**
   * Flow a sequence of styled runs as words within [x, x+width], wrapping at
   * `lineHeight`. All runs share one baseline per line, so keep them one size.
   * Returns the last line's top and the x just past the last word (for trailing
   * chips). With `draw=false` it only measures, so callers can page-break first.
   */
  paragraph(
    x: number,
    top: number,
    width: number,
    runs: Run[],
    size: number,
    lineHeight: number,
    draw = true,
  ): { endTop: number; endX: number } {
    const spaceW = this.measure(" ", size);
    let lineTop = top;
    let cursor = x;
    let placed = false;
    for (const run of runs) {
      for (const word of run.text.split(/\s+/).filter(Boolean)) {
        const wWidth = this.measure(word, size, run.bold);
        if (placed && cursor + spaceW + wWidth > x + width + 0.01) {
          lineTop += lineHeight;
          cursor = x;
          placed = false;
        }
        if (placed) cursor += spaceW;
        if (draw) this.text(cursor, lineTop, word, { size, bold: run.bold, color: run.color });
        cursor += wWidth;
        placed = true;
      }
    }
    return { endTop: lineTop, endX: cursor };
  }

  /** Serialize every page to a downloadable PDF Blob. */
  blob(): Blob {
    // Fixed object numbering: 1 Catalog, 2 Pages, 3 Helvetica, 4 Helvetica-Bold,
    // then a (page, content) pair per page starting at 5.
    const objects: { num: number; body: string }[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      {
        num: 2,
        body: `<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages
          .map((_, i) => `${5 + i * 2} 0 R`)
          .join(" ")}] >>`,
      },
      { num: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
      { num: 4, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>" },
    ];
    this.pages.forEach((p, i) => {
      const pageNum = 5 + i * 2;
      const contentNum = pageNum + 1;
      objects.push({
        num: pageNum,
        body:
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Contents ${contentNum} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`,
      });
      const content = p.ops.join("\n");
      objects.push({ num: contentNum, body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream` });
    });

    // Serialize with byte offsets. Every byte written is < 0x100, so one string
    // char is exactly one byte and string length equals the byte offset.
    const maxNum = objects[objects.length - 1].num;
    const offsets = new Array<number>(maxNum + 1).fill(0);
    let pdf = "%PDF-1.4\n";
    for (const { num, body } of objects) {
      offsets[num] = pdf.length;
      pdf += `${num} 0 obj\n${body}\nendobj\n`;
    }
    const xrefStart = pdf.length;
    pdf += `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= maxNum; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    pdf += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: "application/pdf" });
  }
}

/** Rounded-rectangle path (no paint op) in PDF bottom-left coordinates, built
 *  from four cubic-Bézier corners (kappa = 0.5523 approximates a quarter-circle). */
function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  const k = 0.5523 * rr;
  const x1 = x + w;
  const y1 = y + h;
  return (
    `${n(x + rr)} ${n(y)} m ` +
    `${n(x1 - rr)} ${n(y)} l ` +
    `${n(x1 - rr + k)} ${n(y)} ${n(x1)} ${n(y + rr - k)} ${n(x1)} ${n(y + rr)} c ` +
    `${n(x1)} ${n(y1 - rr)} l ` +
    `${n(x1)} ${n(y1 - rr + k)} ${n(x1 - rr + k)} ${n(y1)} ${n(x1 - rr)} ${n(y1)} c ` +
    `${n(x + rr)} ${n(y1)} l ` +
    `${n(x + rr - k)} ${n(y1)} ${n(x)} ${n(y1 - rr + k)} ${n(x)} ${n(y1 - rr)} c ` +
    `${n(x)} ${n(y + rr)} l ` +
    `${n(x)} ${n(y + rr - k)} ${n(x + rr - k)} ${n(y)} ${n(x + rr)} ${n(y)} c`
  );
}
