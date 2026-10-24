// A tiny dependency-free PDF writer: just enough vector drawing (lines,
// rectangles, polygons) and standard-font text to lay out printable
// puzzle booklets. See print-booklet.js for what gets drawn.
//
// Coordinates are in points (1/72 inch) with the origin at the page's TOP-
// left and y growing downward -- the opposite of PDF's own convention, so
// callers can lay out pages the way they'd read them. Pages are written
// with the 14 built-in fonts (Helvetica / Helvetica-Bold), so nothing needs
// embedding; text is therefore limited to Latin-1 (see sanitizeText).

// Advance widths (1/1000 em) of Helvetica's printable ASCII range, from
// the standard AFM metrics. Bold is approximated from these (see
// textWidth) -- only used to center or right-align short labels.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// Width of `text` in points at `size`, for the built-in Helvetica faces.
export function textWidth(text, size, bold = false) {
  let w = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    w += (code >= 32 && code <= 126) ? HELVETICA_WIDTHS[code - 32] : 556;
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

// The built-in fonts only cover Latin-1, so swap the few non-Latin-1
// characters a book label might plausibly carry for plain equivalents and
// drop anything else rather than emit garbage bytes.
export function sanitizeText(text) {
  return String(text)
    .replace(/[–—]/g, '-')
    .replace(/★/g, '*')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

// Numbers in content streams: enough precision for sub-point accuracy, no
// trailing zeros.
const num = (v) => {
  const s = (Math.round(v * 100) / 100).toString();
  return s === '-0' ? '0' : s;
};

const escapeString = (s) => s.replace(/[\\()]/g, '\\$&');

// A single page's drawing operations.
class PdfPage {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.ops = [];
  }

  // y conversion: caller's top-left origin -> PDF's bottom-left origin.
  _y(y) { return this.height - y; }

  // Run `fn` with a clean graphics state, so one drawing call's colors and
  // line widths can't leak into the next.
  _scoped(fn) {
    this.ops.push('q');
    fn();
    this.ops.push('Q');
  }

  // Stroke many separate segments as one path (cheaper than one stroke per
  // segment). `segments` is [[x1, y1, x2, y2], ...].
  lines(segments, { width = 1, gray = 0, cap = 'butt' } = {}) {
    if (segments.length === 0) return;
    const capCode = { butt: 0, round: 1, square: 2 }[cap];
    this._scoped(() => {
      this.ops.push(`${num(width)} w ${capCode} J ${num(gray)} G`);
      this.ops.push(segments.map(([x1, y1, x2, y2]) =>
        `${num(x1)} ${num(this._y(y1))} m ${num(x2)} ${num(this._y(y2))} l`).join(' '));
      this.ops.push('S');
    });
  }

  fillRect(x, y, w, h, gray = 0) {
    this._scoped(() => {
      this.ops.push(`${num(gray)} g ${num(x)} ${num(this._y(y + h))} ${num(w)} ${num(h)} re f`);
    });
  }

  strokeRect(x, y, w, h, { width = 1, gray = 0 } = {}) {
    this._scoped(() => {
      this.ops.push(`${num(width)} w ${num(gray)} G ${num(x)} ${num(this._y(y + h))} ${num(w)} ${num(h)} re S`);
    });
  }

  // A closed, filled polygon from [[x, y], ...].
  fillPolygon(points, gray = 0) {
    this._scoped(() => {
      const path = points.map(([x, y], i) => `${num(x)} ${num(this._y(y))} ${i === 0 ? 'm' : 'l'}`).join(' ');
      this.ops.push(`${num(gray)} g ${path} h f`);
    });
  }

  // Draw `text` with its baseline at y. `align` is relative to x.
  text(text, x, y, size, { bold = false, gray = 0, align = 'left' } = {}) {
    const clean = sanitizeText(text);
    const w = textWidth(clean, size, bold);
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    this._scoped(() => {
      this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(gray)} g ${num(left)} ${num(this._y(y))} Td (${escapeString(clean)}) Tj ET`);
    });
  }
}

export class PdfDocument {
  constructor({ title = '' } = {}) {
    this.title = title;
    this.pages = [];
  }

  addPage(width, height) {
    const page = new PdfPage(width, height);
    this.pages.push(page);
    return page;
  }

  // Serialize to a Uint8Array. Content streams are deflated when the
  // platform has CompressionStream (all current browsers, and Node 18+);
  // otherwise they're written plain, which is just bigger.
  async toBytes() {
    const encoder = new TextEncoder();
    const latin1 = (s) => Uint8Array.from(s, ch => ch.charCodeAt(0) & 0xff);
    const canCompress = typeof CompressionStream === 'function';

    const compress = async (bytes) => {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    };

    // Object numbers: 1 catalog, 2 page tree, 3-4 fonts, 5 info, then a
    // (page, content) pair per page.
    const pageObj = (i) => 6 + 2 * i;
    const contentObj = (i) => 7 + 2 * i;

    const objects = new Map(); // object number -> Uint8Array body
    const setObj = (n, body) => objects.set(n, typeof body === 'string' ? encoder.encode(body) : body);

    setObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    setObj(2, `<< /Type /Pages /Count ${this.pages.length} /Kids [${this.pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
    setObj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    setObj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    setObj(5, `<< /Title (${escapeString(sanitizeText(this.title))}) /Producer (Multiverse Star Battle) >>`);

    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      setObj(pageObj(i),
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);

      let stream = latin1(page.ops.join('\n'));
      let dict = `<< /Length ${stream.length} >>`;
      if (canCompress) {
        stream = await compress(stream);
        dict = `<< /Filter /FlateDecode /Length ${stream.length} >>`;
      }
      const head = encoder.encode(`${dict}\nstream\n`);
      const tail = encoder.encode('\nendstream');
      const body = new Uint8Array(head.length + stream.length + tail.length);
      body.set(head, 0);
      body.set(stream, head.length);
      body.set(tail, head.length + stream.length);
      setObj(contentObj(i), body);
    }

    // Assemble: header, numbered objects, cross-reference table, trailer.
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (bytes) => { chunks.push(bytes); length += bytes.length; };

    push(encoder.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    const count = 5 + 2 * this.pages.length;
    for (let n = 1; n <= count; n++) {
      offsets[n] = length;
      push(encoder.encode(`${n} 0 obj\n`));
      push(objects.get(n));
      push(encoder.encode('\nendobj\n'));
    }

    const xrefStart = length;
    let xref = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= count; n++) {
      xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${count + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    push(encoder.encode(xref));

    const out = new Uint8Array(length);
    let pos = 0;
    for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
    return out;
  }
}
