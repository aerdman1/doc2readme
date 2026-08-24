/* pdf-extract.js — PDF -> the same Block[] model converter.js builds from .docx.
 *
 * This is the lossy half of the tool, and it is worth being clear about why.
 *
 * A .docx stores meaning: "this paragraph is Heading 2", "this cell belongs to
 * that table", "this run is Courier New". A PDF stores none of that. It stores
 * glyphs at coordinates. Everything structural — headings, paragraphs, tables,
 * code blocks, lists — has to be *inferred* from font size, font name, and x/y
 * position. There is no ground truth to check against.
 *
 * So the rules below are heuristics, tuned to read conservatively: when a
 * signal is ambiguous we emit a plain paragraph rather than guess a heading or
 * invent a table. Wrong-but-plain is recoverable by hand; wrong-but-confident
 * is not.
 *
 * Text extraction itself is pdf.js's job (vendor/). What is here is only the
 * reconstruction on top of it.
 */
'use strict';

const PDF_MONO_HINT = /mono|courier|consol|menlo|inconsolata|source ?code|fira ?(code|mono)|jetbrains|cascadia|ubuntu ?mono|pt ?mono|typewriter/i;
const PDF_BOLD_HINT = /bold|black|heavy|semibold|demibold|-bd|,bold/i;
const PDF_ITALIC_HINT = /italic|oblique|-it\b/i;

let pdfjsLib = null;

async function loadPdfjs(config) {
  if (pdfjsLib) return pdfjsLib;
  // Resolve against the page: a dynamic import() rejects a bare specifier
  // like "vendor/pdf.mjs", and the single-file build passes blob: URLs.
  const abs = (u) => (/^(blob|data|https?):/.test(u) ? u : new URL(u, document.baseURI).href);
  pdfjsLib = await import(abs(config.pdfLibUrl));
  pdfjsLib.GlobalWorkerOptions.workerSrc = abs(config.pdfWorkerUrl);
  return pdfjsLib;
}

/** One positioned piece of text from pdf.js, normalised. */
function toItem(raw, styles, pageHeight) {
  const tr = raw.transform;               // [a, b, c, d, e, f]
  const size = Math.hypot(tr[2], tr[3]) || raw.height || 0;
  const style = styles[raw.fontName] || {};
  const family = style.fontFamily || raw.fontName || '';
  return {
    str: raw.str,
    x: tr[4],
    y: pageHeight - tr[5],                // flip to top-down so sorting reads naturally
    w: raw.width || 0,
    size: Math.round(size * 10) / 10,
    family,
    mono: PDF_MONO_HINT.test(family) || PDF_MONO_HINT.test(raw.fontName || ''),
    bold: PDF_BOLD_HINT.test(family) || PDF_BOLD_HINT.test(raw.fontName || ''),
    italic: PDF_ITALIC_HINT.test(family) || PDF_ITALIC_HINT.test(raw.fontName || ''),
    eol: !!raw.hasEOL,
  };
}

/** Group items on a page into visual lines by y proximity. */
function groupLines(items) {
  const sorted = items.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines = [];
  for (const it of sorted) {
    if (!it.str) continue;
    const tol = Math.max(2, it.size * 0.5);
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= tol) {
      last.items.push(it);
      last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = joinLine(line.items);
    line.x = line.items[0].x;
    line.right = Math.max(...line.items.map((i) => i.x + i.w));
    line.size = mode(line.items.filter((i) => i.str.trim()).map((i) => i.size));
    const solid = line.items.filter((i) => i.str.trim());
    line.mono = solid.length > 0 && solid.every((i) => i.mono);
    line.bold = solid.length > 0 && solid.every((i) => i.bold);
    line.italic = solid.length > 0 && solid.every((i) => i.italic);
  }
  return lines.filter((l) => l.text.trim());
}

/** Join items into a line, inserting spaces where the gap implies one. */
function joinLine(items) {
  let out = '';
  let prev = null;
  for (const it of items) {
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      const space = Math.max(1, prev.size * 0.18);
      if (gap > space && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
    }
    out += it.str;
    prev = it;
  }
  return out.replace(/\s+$/, '');
}

function mode(nums) {
  if (!nums.length) return 0;
  const counts = new Map();
  for (const n of nums) counts.set(n, (counts.get(n) || 0) + 1);
  let best = nums[0], bestN = 0;
  for (const [v, n] of counts) if (n > bestN || (n === bestN && v > best)) { best = v; bestN = n; }
  return best;
}

const PDF_NUMERIC_ONLY = /^[\svixlcdmIVXLCDM.\-–—|]*\d+[\svixlcdmIVXLCDM.\-–—|]*$/;

/**
 * The identity of a line for furniture purposes: its text and its band on the
 * page, with any page number folded away.
 *
 * Folding the number matters more than it looks. A footer is usually not a bare
 * numeral on its own line — it is "Northwind Ltd © 2023. All rights
 * reserved 7", a single text run whose count changes every page. Keying on the
 * literal text gives every page its own key, none of them ever reaches the
 * repeat threshold, and all 46 copies survive into the output. Worse, each one
 * sits mid-paragraph, so the prose joiner splices it into the sentence that
 * continues across the page break: "...for processing and Northwind Ltd
 * © 2019. All rights reserved 4 delivery. The system performs...".
 *
 * So strip a leading or trailing number before comparing. Two footers that
 * differ only by that number are the same piece of furniture.
 */
function furnitureKey(line) {
  const t = line.text.trim();
  const body = PDF_NUMERIC_ONLY.test(t) ? '\0PAGENO' : t.toLowerCase()
    .replace(/^[\s|.\-–—]*\d{1,4}[\s|.\-–—]+/, ' # ')
    .replace(/[\s|.\-–—]+\d{1,4}[\s|.\-–—]*$/, ' # ')
    .replace(/\s+/g, ' ').trim();
  return body + '@' + Math.round(line.y / 12);
}

/**
 * Repeated running heads and feet.
 * A line whose text repeats at roughly the same y on many pages is page
 * furniture — a running header, a footer, a confidentiality stamp.
 */
function findFurniture(pages) {
  const byKey = new Map();
  pages.forEach((lines, p) => {
    for (const line of lines) {
      if (!line.text.trim()) continue;
      const key = furnitureKey(line);
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(p);
    }
  });
  const threshold = Math.max(2, Math.ceil(pages.length * 0.5));
  const drop = new Set();
  for (const [key, seen] of byKey) if (seen.size >= threshold) drop.add(key);
  return { drop, count: drop.size };
}

function isFurniture(line, drop) {
  return drop.has(furnitureKey(line));
}

/**
 * Heading levels from font size.
 * The most common size on the page is body text. Distinct sizes above it,
 * largest first, become H1, H2, H3... A line only qualifies if it is also
 * short and not sentence-like — a large-font paragraph is still a paragraph.
 */
/**
 * Body text is the size that carries the most *text*, not the size used on the
 * most lines. Counting lines makes a short document with four headings and two
 * long paragraphs decide that heading size is body size, after which nothing
 * is a heading and the cover page survives.
 */
function bodySizeOf(lines) {
  const weight = new Map();
  for (const line of lines) {
    if (line.mono) continue;
    const n = (line.text || '').trim().length;
    if (!n) continue;
    weight.set(line.size, (weight.get(line.size) || 0) + n);
  }
  let best = 0, bestWeight = -1;
  for (const [size, w] of weight) {
    if (w > bestWeight || (w === bestWeight && size < best)) { best = size; bestWeight = w; }
  }
  return best;
}

function buildSizeLadder(lines) {
  const bodySize = bodySizeOf(lines);
  const bigger = [...new Set(lines.map((l) => l.size))]
    .filter((s) => s > bodySize + 0.6)
    .sort((a, b) => b - a);
  const ladder = new Map();
  bigger.slice(0, 5).forEach((size, i) => ladder.set(size, i + 1));
  return { bodySize, ladder };
}

/**
 * A line that is large or bold but is plainly not a title.
 *
 * Callout labels annotating a screenshot are the case that matters. They are
 * set in their own font, so the size ladder reads them as headings, but they
 * are fragments of a phrase broken across the arrow they label: "Display Total
 * Messages,", "Total Message Parts &", "chart of selected date", "range",
 * "type of the". One 40-page panel guide turned 222 of them into H3s.
 *
 * The three signals here are all about being mid-phrase rather than being
 * short — a title is short too, so length cannot separate them:
 *   - stops on a joiner: a trailing comma, ampersand, slash, or a dangling
 *     function word ("Select the", "to be send")
 *   - starts lowercase, which a title does not (an internal capital keeps
 *     "iOS setup" and "eBay orders" safe)
 *   - a label followed by a whole sentence after a colon
 */
const PDF_DANGLING_WORD = /\b(and|or|of|the|to|for|in|on|by|from|with|a|an|is|are|as|at|that|this)$/i;

function looksLikeFragment(t) {
  if (/[,;&+/\\-]$/.test(t)) return true;
  if (PDF_DANGLING_WORD.test(t)) return true;
  const first = t.split(/\s+/)[0] || '';
  if (/^[a-z]/.test(t) && !/[A-Z]/.test(first)) return true;
  const colon = t.indexOf(': ');
  if (colon > 0 && t.slice(colon + 2).trim().split(/\s+/).length >= 5) return true;
  return false;
}

function looksLikeHeading(line, ladder, bodySize) {
  const t = line.text.trim();
  if (!t || t.length > 120) return 0;
  if (/[.;,]$/.test(t) && t.length > 60) return 0;      // a sentence, not a title
  if (line.mono) return 0;
  if (looksLikeFragment(t)) return 0;
  const bySize = ladder.get(line.size);
  if (bySize) return bySize;
  // Bold, short, on its own line, at body size -> a run-in heading.
  if (line.bold && line.size >= bodySize - 0.3 && t.length <= 80 && !/[.;,]$/.test(t)) {
    return ladder.size + 1;
  }
  return 0;
}

const PDF_BULLET_RE = /^\s*([•·▪◦‣∙*+-]|•|)\s+/;
const PDF_ORDERED_RE = /^\s*(\d{1,3}[.)]|[a-z][.)]|[ivxlcdm]+[.)])\s+/i;

/**
 * Column detection for tables.
 * Only fires when several consecutive lines share the same x-positions for
 * their pieces — that is what a real table looks like once the ruling lines
 * are gone. Two columns of prose that happen to line up would produce a
 * two-column table, so we require at least two columns, at least two rows,
 * and consistent gutters.
 */
function escapeCell(text) {
  // `|` ends the cell; `<` and `{` are a JSX tag and a JS expression to MDX,
  // and a PDF cell holding "code=<authorization code>" or "{opaque}" is
  // exactly the kind of thing that fails the page build.
  return String(text || '').replace(/([<>{}|])/g, '\\$1');
}

function detectTable(lines, start) {
  const rows = [];
  let i = start;
  let gutters = null;

  while (i < lines.length) {
    const line = lines[i];
    const cells = splitByGaps(line);
    if (cells.length < 2) break;
    // Match on cell *count*, not left edge. Table columns are very often
    // centred, so the x of "Responsable" in the header and "Empresa" in the
    // body differ by tens of points even though they are the same column.
    // Requiring left alignment silently rejects most real tables.
    if (gutters === null) gutters = cells.length;
    else if (cells.length !== gutters) break;
    // Escape here: table cells skip inlineFromLine, and a PDF cell containing
    // something like "code=<authorization code>" is a JSX tag to MDX.
    rows.push(cells.map((c) => escapeCell(c.text.trim())));
    i++;
  }
  // Two lines that merely happen to split in two are not a table. Demand
  // either a third row or a third column before believing it.
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2) return null;
  if (rows.length < 3 && width < 3) return null;
  return { rows: rows.map((r) => r.concat(Array(width - r.length).fill(''))), next: i };
}

/** Split one line into cells wherever a gap is much wider than a space. */
function splitByGaps(line) {
  const cells = [];
  let cur = null;
  let prev = null;
  for (const it of line.items) {
    // Whitespace-only items matter here. Generators emit the run of spaces
    // padding a column as its own text item, so every pair of *consecutive*
    // items is touching and no gap ever looks like a column boundary. Skip
    // them and measure between the visible pieces instead.
    if (!it.str || !it.str.trim()) continue;
    const gap = prev ? it.x - (prev.x + prev.w) : 0;
    if (!cur || gap > Math.max(5, it.size * 1.0)) {
      cur = { x: it.x, text: it.str };
      cells.push(cur);
    } else {
      const small = prev ? it.x - (prev.x + prev.w) : 0;
      cur.text += (small > Math.max(1, it.size * 0.18) ? ' ' : '') + it.str;
    }
    prev = it;
  }
  return cells.filter((c) => c.text.trim());
}

function inlineFromLine(line) {
  let t = line.text.trim();
  if (!t) return '';
  if (line.mono) return t;
  t = t.replace(/([\\`*\[\]<>{}])/g, '\\$1');
  // Escape characters that would turn this paragraph into a different block
  // once it starts a line — a table row flattened to prose often begins "#".
  t = t.replace(/^(#{1,6}|>|\||={2,}|-{3,})(\s|$)/, '\\$1$2');
  if (line.bold && line.italic) return '***' + t + '***';
  if (line.bold) return '**' + t + '**';
  if (line.italic) return '*' + t + '*';
  return t;
}

/**
 * Turn all pages' lines into Block[] — the same shape parseBody() produces for
 * .docx, so every downstream pass (code merging, callouts, label demotion,
 * heading remap, rendering) is shared.
 */
function isCoverPage(lines, bodySize) {
  // A title page is short and dominated by oversized centred text. In a .docx
  // the cover is "everything before the first heading"; in a PDF the cover
  // title *is* the biggest heading, so that rule would keep it.
  if (!lines.length || lines.length > 14) return false;
  const solid = lines.filter((l) => l.text.trim());
  if (solid.length < 2) return false;
  const big = solid.filter((l) => l.size >= bodySize * 1.5).length;
  return big >= Math.max(2, Math.ceil(solid.length * 0.4));
}

function linesToBlocks(pages, report, opts) {
  const furniture = findFurniture(pages);
  if (furniture.count) report.pdfFurnitureDropped = furniture.count;

  let usable = pages;
  if (!opts.keepCover && pages.length > 1) {
    const approxBody = bodySizeOf(pages.flat());
    if (isCoverPage(pages[0], approxBody)) {
      report.coverLines = pages[0].map((l) => l.text.trim()).filter(Boolean);
      usable = pages.slice(1);
    }
  }

  const all = [];
  for (const lines of usable) {
    for (const line of lines) {
      if (isFurniture(line, furniture.drop)) continue;
      all.push(line);
    }
  }
  if (!all.length) return [];

  const { bodySize, ladder } = buildSizeLadder(all);
  report.pdfBodySize = bodySize;
  if (ladder.size) report.pdfHeadingSizes = [...ladder.keys()];

  const blocks = [];
  let para = null;             // accumulating prose lines
  let prevY = null, prevRight = null;

  const flushPara = () => {
    if (para && para.parts.length) {
      // A PDF hyphenates at the line break: "proce-" / "dure". Joining on a
      // space leaves "proce- dure" in the middle of every other sentence.
      // Only rejoin when both halves look like one word, so "end-" / "to-end"
      // and "TLS-" / "1.2" are left alone.
      let text = para.parts.join(' ');
      text = text.replace(/([a-záéíóúñüà-ÿ]{2,})-\s+([a-záéíóúñüà-ÿ]{2,})/g, '$1$2');
      blocks.push({ kind: 'para', text: text.replace(/\s+/g, ' ').trim(), images: [] });
    }
    para = null;
  };

  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    const text = line.text.trim();
    if (!text) continue;

    // --- code: monospace lines, kept verbatim, one block per run ----------
    if (line.mono) {
      flushPara();
      blocks.push({ kind: 'code', text: line.text.replace(/\s+$/, ''), images: [] });
      prevY = line.y; prevRight = line.right;
      continue;
    }

    // --- table --------------------------------------------------------------
    // Tried before headings: a table's header row is short and bold, which
    // otherwise reads as a heading and swallows the whole table.
    const table = detectTable(all, i);
    if (table) {
      flushPara();
      blocks.push({ kind: 'table', rows: table.rows });
      report.pdfTables = (report.pdfTables || 0) + 1;
      prevY = all[Math.min(table.next, all.length - 1)].y;
      prevRight = null;
      i = table.next - 1;
      continue;
    }

    // --- heading ----------------------------------------------------------
    const level = looksLikeHeading(line, ladder, bodySize);
    if (level) {
      flushPara();
      blocks.push({ kind: 'heading', level, text, images: [] });
      prevY = line.y; prevRight = line.right;
      continue;
    }

    // --- list --------------------------------------------------------------
    const bullet = PDF_BULLET_RE.exec(line.text);
    const ordered = !bullet && PDF_ORDERED_RE.exec(line.text);
    if (bullet || ordered) {
      flushPara();
      const marker = (bullet || ordered)[0];
      blocks.push({
        kind: 'list',
        text: inlineFromLine({ ...line, text: line.text.slice(marker.length) }),
        level: Math.min(3, Math.floor(Math.max(0, line.x - 40) / 24)),
        ordered: !!ordered,
        images: [],
      });
      prevY = line.y; prevRight = line.right;
      continue;
    }

    // --- prose: join wrapped lines into one paragraph ------------------------
    const gap = prevY === null ? 0 : line.y - prevY;
    const newPara = para === null || gap > line.size * 1.8 ||
                    (prevRight !== null && prevRight < line.right - line.size * 6);
    if (newPara) {
      flushPara();
      para = { parts: [] };
    }
    para.parts.push(inlineFromLine(line));
    prevY = line.y; prevRight = line.right;
  }
  flushPara();
  return blocks;
}

/** Extract Block[] from a PDF ArrayBuffer. */
async function pdfToBlocks(arrayBuffer, config, report) {
  const lib = await loadPdfjs(config);
  const doc = await lib.getDocument({
    data: new Uint8Array(arrayBuffer),
    isEvalSupported: false,          // the CSP forbids eval; pdf.js honours this
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  report.pdfPages = doc.numPages;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = groupLines(content.items.map((it) => toItem(it, content.styles, viewport.height)));
    for (const l of lines) l.page = n;
    pages.push(lines);
    page.cleanup();
  }
  await doc.destroy();

  const blocks = linesToBlocks(pages, report, config);
  if (!blocks.length) {
    throw new Error('no text found — this looks like a scanned PDF. ' +
                    'Scanned pages are images of text and need OCR first.');
  }
  return blocks;
}

window.pdfExtract = { pdfToBlocks, linesToBlocks, detectTable, splitByGaps, groupLines, toItem };
