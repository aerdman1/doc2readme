/* docx2readme — browser port of docx2readme.py
 *
 * Everything here runs in the tab. No network calls, no dependencies.
 * A .docx is a zip of XML; browsers can open both natively now.
 *
 * Kept deliberately parallel to the Python so the two stay in sync — same
 * function names, same order, same constants.
 */
'use strict';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif'];

// Fonts that mean "this is code". Word docs in the wild use these.
const MONO_FONTS = new Set([
  'courier new', 'courier', 'consolas', 'menlo', 'monaco', 'sf mono',
  'lucida console', 'andale mono', 'dejavu sans mono', 'liberation mono',
  'roboto mono', 'source code pro', 'fira code', 'fira mono', 'cascadia code',
  'cascadia mono', 'ibm plex mono', 'jetbrains mono', 'inconsolata',
  'ubuntu mono', 'pt mono', 'space mono', 'monospace',
]);

// Heading titles that are scaffolding, not sections.
const DEFAULT_LABEL_HEADINGS = new Set([
  'estructura de la llamada', 'parametros', 'parametros (form-urlencoded)',
  'ejemplo curl', 'ejemplo de curl', 'ejemplo respuesta',
  'ejemplo de respuesta', 'respuesta del servicio', 'respuesta exitosa',
  'definicion de campos de llamada', 'definicion de campos de respuesta',
  'definicion de campos', 'cuerpo de la solicitud', 'encabezados', 'headers',
  'campos de entrada', 'campos de salida', 'notas', 'consideraciones',
  'request', 'request structure', 'request body', 'request headers',
  'request parameters', 'parameters', 'query parameters', 'path parameters',
  'example request', 'example response', 'sample request', 'sample response',
  'curl example', 'response', 'responses', 'response fields',
  'response body', 'field definitions', 'returns', 'example',
]);

// Sections dropped wholesale (heading + everything under it).
const DEFAULT_DROP_SECTIONS = new Set([
  'indice', 'contenido', 'tabla de contenido', 'tabla de contenidos',
  'table of contents', 'table of content', 'contents', 'toc',
  'historial de versiones', 'control de versiones', 'control de cambios',
  'historial de cambios', 'registro de cambios',
  'version history', 'revision history', 'change log', 'changelog',
  'document history', 'document control',
  // Vendor template boilerplate: a metadata block, then a change log with
  // author/contributor/reviewer/approver columns. Those columns reconstruct
  // badly from a PDF (jagged merged cells) and are never publishable content,
  // so drop them like the rest of the front matter.
  'document information', 'document information and version history',
  'document version history', 'document details',
]);

// Word has no callout component; ReadMe does, and its markdown spelling is a
// blockquote whose first character is one of four magic emoji.
const CALLOUT_EMOJI = {
  '⚠': '🚧', '⚠️': '🚧', '🚧': '🚧', '❕': '🚧', '🔔': '🚧',
  'ℹ': '📘', 'ℹ️': '📘', '📘': '📘', '💡': '📘', '📝': '📘', '📌': '📘',
  '❗': '❗️', '❗️': '❗️', '‼': '❗️', '‼️': '❗️', '⛔': '❗️', '🛑': '❗️',
  '❌': '❗️', '🚫': '❗️',
  '✅': '👍', '☑': '👍', '👍': '👍', '✔': '👍', '✔️': '👍',
};
const CALLOUT_WORDS = [
  [/^(nota|note|aviso|tip|sugerencia|info(?:rmaci[oó]n)?)\s*[:.—-]\s*/i, '📘'],
  [/^(importante|important|atenci[oó]n|attention|advertencia|warning|precauci[oó]n|caution|cuidado)\s*[:.—-]\s*/i, '🚧'],
  [/^(peligro|danger|error|cr[ií]tico|critical|no\s+haga|never)\s*[:.—-]\s*/i, '❗️'],
];

// Word AutoCorrect silently rewrites straight quotes to typographic ones while
// an author types a cURL command, turning a copy-pasteable snippet into one
// that fails with a shell syntax error. Always undone inside code.
const SMART_IN_CODE = {
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '′': "'", '″': '"', '«': '"', '»': '"',
  '…': '...', ' ': ' ', '​': '',
};

// ---------------------------------------------------------------------------
// Tiny zip reader — EOCD -> central directory -> local headers
// ---------------------------------------------------------------------------

async function readZip(buffer) {
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file — is this really a .docx? (.doc and .docm need a resave as .docx)');

  let count = dv.getUint16(eocd + 10, true);
  let cdOff = dv.getUint32(eocd + 16, true);

  // Zip64: a .docx with many embedded fonts can exceed the 16-bit counters.
  if (count === 0xffff || cdOff === 0xffffffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x07064b50) {
        const z64 = Number(dv.getBigUint64(i + 8, true));
        if (dv.getUint32(z64, true) === 0x06064b50) {
          count = Number(dv.getBigUint64(z64 + 32, true));
          cdOff = Number(dv.getBigUint64(z64 + 48, true));
        }
        break;
      }
    }
  }

  const dec = new TextDecoder('utf-8');
  const entries = new Map();
  let p = cdOff;
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    let compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    let lho = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (compSize === 0xffffffff || lho === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const tag = dv.getUint16(e, true), size = dv.getUint16(e + 2, true);
        if (tag === 0x0001) {
          let q = e + 4;
          if (dv.getUint32(p + 24, true) === 0xffffffff) q += 8;       // uncompressed
          if (compSize === 0xffffffff) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (lho === 0xffffffff) lho = Number(dv.getBigUint64(q, true));
          break;
        }
        e += 4 + size;
      }
    }
    entries.set(name, { method, compSize, lho });
    p += 46 + nameLen + extraLen + cmtLen;
  }

  const out = new Map();
  for (const [name, e] of entries) {
    if (name.endsWith('/')) continue;
    const nl = dv.getUint16(e.lho + 26, true);
    const el = dv.getUint16(e.lho + 28, true);
    const start = e.lho + 30 + nl + el;
    const raw = bytes.subarray(start, start + e.compSize);
    if (e.method === 0) {
      out.set(name, raw.slice());
    } else if (e.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const buf = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
      out.set(name, new Uint8Array(buf));
    }
    // any other method: silently skipped, docx only ever uses 0 and 8
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tiny zip writer — stored (method 0). Valid everywhere, no edge cases.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;

  for (const { path, data } of files) {
    const nameBytes = enc.encode(path);
    const body = typeof data === 'string' ? enc.encode(data) : data;
    const crc = crc32(body);

    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0x0800, true);           // UTF-8 filename flag
    ldv.setUint16(8, 0, true);                // stored
    ldv.setUint16(10, 0, true);               // 00:00:00
    ldv.setUint16(12, 0x0021, true);          // 1980-01-01; 0 is not a legal
                                              // DOS date and some unzippers
                                              // warn or refuse on it
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, body.length, true);
    ldv.setUint32(22, body.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, body);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);               // stored
    cdv.setUint16(12, 0, true);               // 00:00:00
    cdv.setUint16(14, 0x0021, true);          // 1980-01-01
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, body.length, true);
    cdv.setUint32(24, body.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + body.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const edv = new DataView(end.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const deaccent = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function normKey(text) {
  let v = deaccent(text || '').toLowerCase().trim();
  v = v.replace(/[‐-―−]/g, '-');
  v = v.replace(/[:.;,]+$/, '');
  v = v.replace(/\s+/g, ' ');
  return v.trim();
}

function slugify(v) {
  v = deaccent(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return v.replace(/^-+|-+$/g, '') || 'page';
}

// `_` and `|` are deliberately absent. GFM does not treat intraword
// underscores as emphasis, so escaping them litters `client\_credentials`
// through every API doc; `|` only matters inside a table, where renderTable
// escapes it.
//
// `{` and `}` are here for the same reason `<` and `>` are. ReadMe compiles
// pages as MDX, where a brace opens a JavaScript expression: a sentence
// containing {"grant_type": "client_credentials"} does not render as text, it
// is evaluated, and the page fails to build. Backslash-escaping is the fix and
// is invariant under plain CommonMark, which renders \{ as {.
const MD_SPECIAL = /([\\`*\[\]<>{}])/g;
const LONE_UNDERSCORE = /(?<![0-9A-Za-z])_|_(?![0-9A-Za-z])/g;
// A bare URL is autolinked by GFM, and a backslash escape *inside* that link
// is not processed — `https://x/\{id\}` autolinks with the backslashes
// visible, and an escaped angle bracket still reaches MDX as a tag.
// Percent-encode instead, which is what these characters should be in a URL
// anyway.
const URL_UNSAFE = { '<': '%3C', '>': '%3E', '{': '%7B', '}': '%7D' };
const encodeUrlAngles = (t) =>
  (t || '').replace(/https?:\/\/[^\s)]*/g,
    (u) => u.replace(/[<>{}]/g, (c) => URL_UNSAFE[c]));
const esc = (t) => encodeUrlAngles(t || '').replace(MD_SPECIAL, '\\$1').replace(LONE_UNDERSCORE, '\\_');

// A markdown link target is delimited by parentheses and ended by whitespace,
// so a URL containing either silently truncates the link. Word hyperlinks to
// SharePoint and Confluence routinely contain both.
function encodeLinkTarget(url) {
  return String(url || '').trim()
    .replace(/[\s]/g, '%20')
    .replace(/</g, '%3C').replace(/>/g, '%3E')
    .replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function wrapEmph(piece, marker) {
  const stripped = piece.trim();
  if (!stripped) return piece;
  const lead = piece.slice(0, piece.length - piece.trimStart().length);
  const trail = piece.slice(piece.trimEnd().length);
  return lead + marker + stripped + marker + trail;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

const isW = (el, name) => el.namespaceURI === W && el.localName === name;
const wAttr = (el, name) => el.getAttributeNS(W, name);
const wFind = (el, name) => {
  for (const c of el.children) if (isW(c, name)) return c;
  return null;
};
const wFindDeep = (el, name) => {
  const list = el.getElementsByTagNameNS(W, name);
  return list.length ? list[0] : null;
};
const onFlag = (el) => {
  if (!el) return false;
  const v = wAttr(el, 'val');
  return v !== '0' && v !== 'false' && v !== 'off';
};

function parseXml(bytes) {
  const text = new TextDecoder('utf-8').decode(bytes);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('malformed XML inside the .docx');
  return doc;
}

// ---------------------------------------------------------------------------
// Style table
// ---------------------------------------------------------------------------

const HEADING_ID_RE = /^(?:heading|titulo|title|berschrift|kop|rubrik|otsikko|naslov|nagwek|zaglavlje|titre|titolo)[\s_-]*([1-9])$/;

function buildStyleTable(stylesBytes) {
  const table = new Map();
  if (!stylesBytes) return table;
  const doc = parseXml(stylesBytes);
  const raw = new Map();

  for (const style of doc.documentElement.children) {
    if (!isW(style, 'style')) continue;
    const sid = wAttr(style, 'styleId') || '';
    const nameEl = wFind(style, 'name');
    const name = (nameEl ? wAttr(nameEl, 'val') : sid) || sid;

    let level = null;
    const outline = wFindDeep(style, 'outlineLvl');
    if (outline && wAttr(outline, 'val') !== null) {
      const n = parseInt(wAttr(outline, 'val'), 10);
      if (!isNaN(n)) level = n + 1;
    }
    if (level === null) {
      for (const cand of [name, sid]) {
        const m = HEADING_ID_RE.exec(normKey(cand).replace(/\s/g, ''));
        if (m) { level = parseInt(m[1], 10); break; }
      }
    }

    let mono = false;
    const rfonts = wFindDeep(style, 'rFonts');
    if (rfonts) {
      for (const a of ['ascii', 'hAnsi', 'cs']) {
        const f = wAttr(rfonts, a);
        if (f && MONO_FONTS.has(f.trim().toLowerCase())) mono = true;
      }
    }
    const based = wFind(style, 'basedOn');
    raw.set(sid, {
      name, level, mono,
      basedOn: based ? wAttr(based, 'val') : null,
      toc: /^(toc|tdc|verzeichnis)\s*\d*$/.test(normKey(name)),
    });
  }

  // resolve basedOn chains for inherited heading levels
  for (const [sid, info] of raw) {
    const seen = new Set();
    let cur = info;
    while (cur.level === null && cur.basedOn && !seen.has(cur.basedOn)) {
      seen.add(cur.basedOn);
      const parent = raw.get(cur.basedOn);
      if (!parent) break;
      if (parent.level !== null) info.level = parent.level;
      cur = parent;
    }
    table.set(sid, info);
  }
  return table;
}

function buildNumberingFormats(bytes) {
  const result = new Map();
  if (!bytes) return result;
  const doc = parseXml(bytes);
  const abstract = new Map();
  for (const node of doc.documentElement.children) {
    if (!isW(node, 'abstractNum')) continue;
    const aid = wAttr(node, 'abstractNumId');
    const levels = new Map();
    for (const lvl of node.children) {
      if (!isW(lvl, 'lvl')) continue;
      const fmt = wFind(lvl, 'numFmt');
      levels.set(parseInt(wAttr(lvl, 'ilvl') || '0', 10), fmt ? wAttr(fmt, 'val') : 'decimal');
    }
    abstract.set(aid, levels);
  }
  for (const node of doc.documentElement.children) {
    if (!isW(node, 'num')) continue;
    const ref = wFind(node, 'abstractNumId');
    if (ref) result.set(wAttr(node, 'numId'), abstract.get(wAttr(ref, 'val')) || new Map());
  }
  return result;
}

// ---------------------------------------------------------------------------
// Inline runs -> markdown
// ---------------------------------------------------------------------------

function runText(run) {
  let out = '';
  for (const child of run.children) {
    if (isW(child, 't')) out += child.textContent || '';
    else if (isW(child, 'tab')) out += '\t';
    else if (isW(child, 'br') || isW(child, 'cr')) out += '\n';
    else if (isW(child, 'noBreakHyphen')) out += '-';
    else if (isW(child, 'sym')) {
      const ch = wAttr(child, 'char');
      if (ch) { const n = parseInt(ch, 16); if (!isNaN(n)) out += String.fromCharCode(n); }
    }
  }
  return out;
}

function runIsMono(run, styles, paraMono) {
  const rpr = wFind(run, 'rPr');
  if (rpr) {
    const rstyle = wFind(rpr, 'rStyle');
    if (rstyle) {
      const info = styles.get(wAttr(rstyle, 'val') || '');
      if (info && info.mono) return true;
    }
    const rfonts = wFind(rpr, 'rFonts');
    if (rfonts) {
      for (const a of ['ascii', 'hAnsi', 'cs']) {
        const f = wAttr(rfonts, a);
        if (f) return MONO_FONTS.has(f.trim().toLowerCase());
      }
    }
  }
  return paraMono;
}

function renderInline(para, ctx, plainMode) {
  let pstyleId = '';
  const ppr = wFind(para, 'pPr');
  if (ppr) {
    const ps = wFind(ppr, 'pStyle');
    if (ps) pstyleId = wAttr(ps, 'val') || '';
  }
  let paraMono = !!(ctx.styles.get(pstyleId) || {}).mono;
  if (ppr) {
    const rpr = wFind(ppr, 'rPr');
    const rfonts = rpr && wFind(rpr, 'rFonts');
    if (rfonts) {
      for (const a of ['ascii', 'hAnsi']) {
        const f = wAttr(rfonts, a);
        if (f && MONO_FONTS.has(f.trim().toLowerCase())) paraMono = true;
      }
    }
  }

  // Collect (formatting, text) spans, then coalesce neighbours sharing
  // formatting. Word splits one bold phrase across several w:r elements
  // (rsid, spell-check state, language marks); emitting each separately
  // produces garbage like "**I****niciación**".
  const spans = [], plainParts = [], images = [];
  let monoChars = 0, totalChars = 0;

  function emitRun(run) {
    if (!plainMode) {
      for (const blip of run.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'blip')) {
        const rid = blip.getAttributeNS(R_NS, 'embed') || blip.getAttributeNS(R_NS, 'link');
        if (rid) images.push(rid);
      }
    }
    const text = runText(run);
    if (!text) return;
    const rpr = wFind(run, 'rPr');
    let bold = false, italic = false, strike = false, vanish = false;
    if (rpr) {
      bold = onFlag(wFind(rpr, 'b'));
      italic = onFlag(wFind(rpr, 'i'));
      strike = onFlag(wFind(rpr, 'strike')) || onFlag(wFind(rpr, 'dstrike'));
      vanish = onFlag(wFind(rpr, 'vanish'));
    }
    if (vanish) return;
    const mono = runIsMono(run, ctx.styles, paraMono);
    const stripped = text.trim();
    totalChars += stripped.length;
    if (mono) monoChars += stripped.length;
    plainParts.push(text);
    const key = [bold, italic, strike, mono].join(',');
    const last = spans[spans.length - 1];
    if (last && last.key === key) last.chunks.push(text);
    else spans.push({ key, fmt: { bold, italic, strike, mono }, chunks: [text] });
  }

  for (const child of para.children) {
    if (isW(child, 'r')) emitRun(child);
    else if (isW(child, 'hyperlink')) {
      const rid = child.getAttributeNS(R_NS, 'id');
      const anchor = wAttr(child, 'anchor');
      let target = rid ? ctx.rels.get(rid) : (anchor ? '#' + anchor : null);
      if (target && target.startsWith('#')) target = null;  // internal Word bookmark
      let text = '';
      for (const run of child.children) if (isW(run, 'r')) text += runText(run);
      if (!text.trim()) continue;
      plainParts.push(text);
      totalChars += text.trim().length;
      if (plainMode) spans.push({ key: null, rendered: text });
      else if (target) {
        const lead = text.slice(0, text.length - text.trimStart().length);
        const trail = text.slice(text.trimEnd().length);
        spans.push({ key: null, rendered: lead + '[' + esc(text.trim()) + '](' + encodeLinkTarget(target) + ')' + trail });
      } else spans.push({ key: null, rendered: esc(text) });
    } else if (isW(child, 'smartTag') || isW(child, 'sdt') || isW(child, 'ins')) {
      for (const run of child.getElementsByTagNameNS(W, 'r')) emitRun(run);
    }
  }

  const parts = [];
  for (const span of spans) {
    if (span.key === null) { parts.push(span.rendered); continue; }
    const text = span.chunks.join('');
    if (plainMode) { parts.push(text); continue; }
    const stripped = text.trim();
    if (!stripped) { parts.push(text); continue; }
    let { bold, italic, strike, mono } = span.fmt;
    let piece;
    if (mono) {
      const lead = text.slice(0, text.length - text.trimStart().length);
      const trail = text.slice(text.trimEnd().length);
      const runs = stripped.match(/`+/g) || [];
      const fence = '`'.repeat(Math.max(0, ...runs.map((m) => m.length)) + 1);
      piece = lead + fence + stripped + fence + trail;
      bold = italic = false;  // emphasis inside a code span is not a thing
    } else piece = esc(text);
    if (strike) piece = wrapEmph(piece, '~~');
    if (bold && italic) piece = wrapEmph(piece, '***');
    else if (bold) piece = wrapEmph(piece, '**');
    else if (italic) piece = wrapEmph(piece, '*');
    parts.push(piece);
  }

  return {
    markdown: parts.join(''),
    plain: plainParts.join(''),
    monoChars, totalChars, images,
  };
}

// ---------------------------------------------------------------------------
// Block model
// ---------------------------------------------------------------------------

function paraIndent(para) {
  const ppr = wFind(para, 'pPr');
  const ind = ppr && wFind(ppr, 'ind');
  if (!ind) return 0;
  for (const a of ['left', 'start']) {
    const v = wAttr(ind, a);
    if (v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
  }
  return 0;
}

function paraNumbering(para, ctx) {
  const ppr = wFind(para, 'pPr');
  const numpr = ppr && wFind(ppr, 'numPr');
  if (!numpr) return null;
  const numid = wFind(numpr, 'numId');
  if (!numid) return null;
  const nid = wAttr(numid, 'val');
  if (nid === null || nid === '0') return null;
  const ilvl = wFind(numpr, 'ilvl');
  const level = parseInt((ilvl && wAttr(ilvl, 'val')) || '0', 10) || 0;
  const fmt = (ctx.numfmt.get(nid) || new Map()).get(level) || 'decimal';
  return { level, ordered: fmt !== 'bullet' && fmt !== 'none' };
}

function paraStyleId(para) {
  const ppr = wFind(para, 'pPr');
  const ps = ppr && wFind(ppr, 'pStyle');
  return ps ? (wAttr(ps, 'val') || '') : '';
}

function parseParagraph(para, ctx) {
  const info = ctx.styles.get(paraStyleId(para)) || {};
  if (info.toc) return { kind: 'toc' };

  if (info.level) {
    const inline = renderInline(para, ctx, true);
    return { kind: 'heading', level: info.level, text: inline.plain, images: [] };
  }

  const inline = renderInline(para, ctx, false);
  if (!inline.plain.trim() && !inline.images.length) return { kind: 'blank' };

  const isCode = inline.totalChars > 0 &&
    inline.monoChars >= Math.max(1, Math.floor(inline.totalChars * 0.8));
  if (isCode) {
    return { kind: 'code', text: inline.plain.replace(/\n+$/, ''), indent: paraIndent(para), images: inline.images };
  }

  const numbering = paraNumbering(para, ctx);
  if (numbering) {
    return { kind: 'list', text: inline.markdown.trim(), level: numbering.level, ordered: numbering.ordered, images: inline.images };
  }
  return { kind: 'para', text: inline.markdown.trim(), images: inline.images };
}

function parseTable(tbl, ctx) {
  const rows = [];
  for (const tr of tbl.children) {
    if (!isW(tr, 'tr')) continue;
    const cells = [];
    for (const tc of tr.children) {
      if (!isW(tc, 'tc')) continue;
      const pieces = [];
      for (const p of tc.children) {
        if (isW(p, 'p')) {
          const t = renderInline(p, ctx, false).markdown.trim();
          if (t) pieces.push(t);
        } else if (isW(p, 'tbl')) {
          // nested table: flatten, GFM has no nesting
          for (const np of p.getElementsByTagNameNS(W, 'p')) {
            const t = renderInline(np, ctx, false).markdown.trim();
            if (t) pieces.push(t);
          }
        }
      }
      let span = 1;
      const tcpr = wFind(tc, 'tcPr');
      const gs = tcpr && wFind(tcpr, 'gridSpan');
      if (gs) span = Math.max(1, parseInt(wAttr(gs, 'val') || '1', 10) || 1);
      cells.push(pieces.join('<br />').replace(/\|/g, '\\|'));
      for (let i = 1; i < span; i++) cells.push('');
    }
    rows.push(cells);
  }
  return { kind: 'table', rows };
}

function parseBody(documentBytes, ctx) {
  const doc = parseXml(documentBytes);
  const body = wFind(doc.documentElement, 'body');
  const blocks = [];
  if (!body) return blocks;
  for (const child of body.children) {
    if (isW(child, 'p')) blocks.push(parseParagraph(child, ctx));
    else if (isW(child, 'tbl')) blocks.push(parseTable(child, ctx));
    else if (isW(child, 'sdt')) {
      const content = wFind(child, 'sdtContent');
      if (!content) continue;
      for (const sub of content.children) {
        if (isW(sub, 'p')) blocks.push(parseParagraph(sub, ctx));
        else if (isW(sub, 'tbl')) blocks.push(parseTable(sub, ctx));
      }
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Cleanup passes
// ---------------------------------------------------------------------------

const NUM_PREFIX_RE = /^\s*(?:\d+(?:\.\d+)*\s*[.)\-–—]?|[a-zA-Z]\s*[.)]|[ivxlcdmIVXLCDM]+\s*[.)])\s+/;

function cleanHeadingText(text) {
  let t = (text || '').replace(/ /g, ' ').replace(/\t/g, '  ').trim();
  // Word's list engine *renders* "Paso 1 — Obtener Token" but only *stores*
  // "Paso 1" + whitespace + "Obtener Token" — the separator lives in the
  // numbering definition and never reaches the text layer. Restore the dash
  // BEFORE collapsing whitespace, or the halves fuse into "Paso 1 Obtener".
  t = t.replace(/^(Paso|Step|Etapa|Fase|Phase|Parte|Part)\s+(\d+(?:\.[0-9a-zA-Z]+)?)[ \t]{2,}/, '$1 $2 — ');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(NUM_PREFIX_RE, '');
  return t.replace(/^[\s.]+|[\s.]+$/g, '');
}

/**
 * Where a dropped section ends: the next heading at the same or a higher level.
 *
 * That rule alone is a trapdoor on PDFs. Levels there are inferred from font
 * size, and a "Contents" page is very often set in the largest font in the
 * document — larger than the chapter titles it lists. Its level-based extent
 * then runs to the last page and takes every chapter with it, silently. That is
 * not a hypothetical: it emptied six of eight real guides, each down to its
 * cover blurb.
 *
 * So when the level-based extent reaches the end of the document and there are
 * still headings inside it, end the section at the next heading of any level
 * instead. A section that swallows every remaining heading is a mis-levelled
 * heading, not a section boundary. The cost of the fallback is that a genuinely
 * last "Revision History" section keeps its subsections; the cost of not having
 * it is losing the document.
 */
function sectionExtent(blocks, start) {
  const level = blocks[start].level;
  for (let i = start + 1; i < blocks.length; i++) {
    if (blocks[i].kind === 'heading' && blocks[i].level <= level) return i;
  }
  for (let i = start + 1; i < blocks.length; i++) {
    if (blocks[i].kind === 'heading') return i;
  }
  return blocks.length;
}

function dropTocAndSections(blocks, dropSections, report) {
  const out = [];
  let skipTo = -1;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (i < skipTo) continue;
    if (block.kind === 'toc') { report.tocLines = (report.tocLines || 0) + 1; continue; }
    if (block.kind === 'heading') {
      const title = cleanHeadingText(block.text);
      if (dropSections.has(normKey(title))) {
        skipTo = sectionExtent(blocks, i);
        (report.droppedSections = report.droppedSections || []).push(title);
        continue;
      }
    }
    out.push(block);
  }
  return out;
}

function dropCover(blocks, report) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === 'heading' && cleanHeadingText(b.text)) {
      if (i) {
        const dropped = blocks.slice(0, i)
          .filter((x) => (x.kind === 'para' || x.kind === 'list') && (x.text || '').trim())
          .map((x) => x.text);
        if (dropped.length) report.coverLines = dropped;
      }
      return blocks.slice(i);
    }
  }
  return blocks;
}

function desmartenCode(text) {
  let fixed = 0;
  for (const [bad, good] of Object.entries(SMART_IN_CODE)) {
    const parts = text.split(bad);
    if (parts.length > 1) { fixed += parts.length - 1; text = parts.join(good); }
  }
  return { text, fixed };
}

function unwrapCode(lines) {
  lines = lines.map((l) => l.replace(/ /g, ' ').replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return '';

  // Rejoin shell continuations Word soft-wrapped mid-flag.
  const merged = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (merged.length && stripped === '\\') {
      if (!/\\$/.test(merged[merged.length - 1].replace(/\s+$/, '')))
        merged[merged.length - 1] = merged[merged.length - 1].replace(/\s+$/, '') + ' \\';
      continue;
    }
    const prev = merged.length ? merged[merged.length - 1].replace(/\s+$/, '') : '';
    // "--data \" + "-urlencode ..." -> "--data-urlencode ...". A fragment
    // starting with a *single* hyphen is a split flag; "--request" on its own
    // line is a real new flag and must not be glued on.
    if (merged.length && prev.endsWith('\\') && stripped.startsWith('-') &&
        !stripped.startsWith('--') && /--[A-Za-z][\w-]*\s*\\$/.test(prev)) {
      merged[merged.length - 1] = prev.slice(0, -1).replace(/\s+$/, '') + stripped;
      continue;
    }
    merged.push(line);
  }
  lines = merged;

  // A flag and its value split across two lines ("--cert \" / "/path/cert").
  const joined = [];
  for (const line of lines) {
    const prev = joined.length ? joined[joined.length - 1].replace(/\s+$/, '') : '';
    const stripped = line.trim();
    if (joined.length && prev.endsWith('\\') && stripped && !stripped.startsWith('-') &&
        /(?:^|\s)--?[A-Za-z][\w-]*\s*\\$/.test(prev)) {
      joined[joined.length - 1] = prev.slice(0, -1).replace(/\s+$/, '') + ' ' + stripped;
      continue;
    }
    joined.push(line);
  }
  lines = joined;

  while (lines.length && (lines[lines.length - 1].trim() === '\\' || !lines[lines.length - 1].trim())) lines.pop();

  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const shift = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l) => (l.trim() ? l.slice(shift) : ''))
    // Word indents JSON with tabs; two spaces read better in ReadMe.
    .map((l) => l.replace(/^\t+/, (m) => '  '.repeat(m.length)))
    .join('\n');
}

function mergeCodeBlocks(blocks, report) {
  const out = [];
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i].kind !== 'code') { out.push(blocks[i]); i++; continue; }
    const lines = [];
    let pendingBlanks = 0, j = i;
    while (j < blocks.length) {
      const cur = blocks[j];
      if (cur.kind === 'code') {
        for (let k = 0; k < pendingBlanks; k++) lines.push('');
        pendingBlanks = 0;
        lines.push(...cur.text.split('\n'));
        j++;
      } else if (cur.kind === 'blank') { pendingBlanks++; j++; }
      else break;
    }
    const { text, fixed } = desmartenCode(unwrapCode(lines));
    if (fixed) report.autocorrectFixes = (report.autocorrectFixes || 0) + fixed;
    out.push({ kind: 'code', text, images: [] });
    report.codeBlocks = (report.codeBlocks || 0) + 1;
    i = j;
  }
  return out;
}

function inferLanguage(text, recentHeading) {
  const head = text.replace(/^\s+/, '');
  const first = (head.split('\n', 1)[0] || '').trim();
  if (/^[\[{]/.test(head)) return 'json';
  if (/^(curl|wget|https?\s|\$\s|#!\/)/i.test(first)) return 'bash';
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S/.test(first)) return 'http';
  if (/^<\?xml|^<[A-Za-z]/.test(head)) return 'xml';
  if (/^[A-Za-z-]+:\s/.test(first)) return 'http';
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|WITH)\b/i.test(first)) return 'sql';
  if (/^[A-Z_][A-Z0-9_]*=/.test(first)) return 'bash';
  const hint = normKey(recentHeading || '');
  if (hint.includes('curl')) return 'bash';
  if (hint.includes('json') || hint.includes('payload')) return 'json';
  return '';
}

function detectCallout(text) {
  let inner = text.trim();
  // "**Nota:** guarde el token" is the same paragraph as "Nota: guarde el
  // token" — writers bold the label far more often than not, and matching
  // only the unbolded form missed most real callouts.
  inner = inner.replace(/^(\*{1,3}|_{1,2})\s*([^*_\n]{1,40}?)\s*\1\s*/, (m, mark, label) =>
    (/[:.—–-]$/.test(label) ? label + ' ' : label + ': '));
  for (const marker of ['***', '**', '*', '_']) {
    if (inner.length > 2 * marker.length && inner.startsWith(marker) && inner.endsWith(marker)) {
      inner = inner.slice(marker.length, -marker.length).trim();
      break;
    }
  }
  const glyphs = Object.keys(CALLOUT_EMOJI).sort((a, b) => b.length - a.length);
  for (const glyph of glyphs) {
    if (inner.startsWith(glyph)) {
      const rest = inner.slice(glyph.length).replace(/^️/, '').replace(/^[\s:—-]+|[\s]+$/g, '');
      return { emoji: CALLOUT_EMOJI[glyph], rest };
    }
  }
  for (const [pattern, emoji] of CALLOUT_WORDS) {
    const m = pattern.exec(inner);
    if (m) return { emoji, rest: inner.slice(m[0].length).trim() };
  }
  return null;
}

function convertCallouts(blocks, report) {
  return blocks.map((block) => {
    if (block.kind === 'para' && (block.text || '').trim()) {
      const hit = detectCallout(block.text);
      if (hit && hit.rest) {
        report.callouts = (report.callouts || 0) + 1;
        return { kind: 'callout', emoji: hit.emoji, text: hit.rest, images: [] };
      }
    }
    return block;
  });
}

const LABEL_SUFFIX_RE = /\s*[([]\s*(?:HTTP\s*)?[1-5]\d{2}(?:\s*[-–—/]\s*[A-Za-z ]+)?\s*[)\]]\s*$/i;
const labelStem = (title) => normKey((title || '').replace(LABEL_SUFFIX_RE, ''));

function demoteLabelHeadings(blocks, labels, labelStyle, report) {
  const out = [];
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const title = cleanHeadingText(block.text);
      if (!title) { report.emptyHeadings = (report.emptyHeadings || 0) + 1; continue; }
      if (labels.has(normKey(title)) || labels.has(labelStem(title))) {
        (report.demoted = report.demoted || []).push(title);
        // A heading escapes at render time; a paragraph does not, so a label
        // like "Response <200>" would reach MDX raw once demoted.
        const safe = escapeHeading(title);
        out.push({ kind: 'para', text: labelStyle === 'plain' ? safe : '**' + safe + '**', images: [] });
        continue;
      }
      block.text = title;
    }
    out.push(block);
  }
  return out;
}

function remapHeadingLevels(blocks, topLevel, maxLevel, report) {
  const used = [...new Set(blocks.filter((b) => b.kind === 'heading').map((b) => b.level))].sort((a, b) => a - b);
  if (!used.length) return blocks;
  const mapping = new Map();
  used.forEach((level, rank) => mapping.set(level, Math.min(6, maxLevel, topLevel + rank)));
  const collapsed = used.filter((k) => mapping.get(k) === Math.min(6, maxLevel));
  if (collapsed.length > 1) report.collapsedLevels = collapsed.map((k) => 'h' + k);
  report.headingMap = used.map((k) => 'h' + k + '→h' + mapping.get(k));
  for (const b of blocks) if (b.kind === 'heading') b.level = mapping.get(b.level);
  return blocks;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// ReadMe compiles pages as MDX, where a bare <angle> is parsed as a JSX tag
// and a bare {brace} as a JavaScript expression — either takes the whole page
// down with a syntax error. Heading text is emitted verbatim (escaping it
// earlier would corrupt slugs and label matching), so it gets escaped here at
// the last moment. Already-escaped characters are left alone so Markdown input
// that was written correctly does not come out with doubled backslashes.
function escapeHeading(text) {
  return String(text || '').replace(/(\\?)([<>{}])/g, (m, bs, ch) => (bs ? m : '\\' + ch));
}

// A fenced block has to open with more backticks than any fence inside it, or
// the first inner fence closes it and the rest of the snippet lands in the
// page as prose. Markdown documenting Markdown hits this immediately.
function fenceFor(text) {
  let n = 3;
  for (const m of String(text || '').matchAll(/^ {0,3}(`{3,})/gm)) {
    n = Math.max(n, m[1].length + 1);
  }
  return '`'.repeat(n);
}

function renderTable(rows) {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => r.concat(Array(width - r.length).fill('')));
  // ReadMe bolds the header row itself; strip Word's manual bold so it doesn't
  // render as literal asterisks. Only when the whole cell is one bold span —
  // "**a** and **b**" is not, and stripping its ends mangles it to "a** and **b".
  const header = rows[0].map((c) => {
    const t = c.trim();
    const m = /^\*\*([\s\S]+)\*\*$/.exec(t);
    return (m && !m[1].includes('**') ? m[1] : t) || ' ';
  });
  let body = rows.slice(1);
  if (!body.length) body = [Array(width).fill('')];
  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + Array(width).fill('---').join(' | ') + ' |',
  ];
  for (const row of body) lines.push('| ' + row.map((c) => c.trim() || ' ').join(' | ') + ' |');
  return lines.join('\n');
}

// Real ReadMe projects overwhelmingly use the component form — 12k+ instances
// of <Callout icon="📘" theme="info"> across the corpus I checked, against a
// few thousand blockquote-style ones. Both render; the component is the
// MDX-native spelling and survives round-tripping.
const CALLOUT_THEME = { '📘': 'info', '🚧': 'warn', '❗️': 'error', '👍': 'okay' };

function renderCallout(block, style) {
  const body = String(block.text || '').trim();
  if (style === 'blockquote') {
    return '> ' + block.emoji + ' ' + body.replace(/\n/g, '\n> ');
  }
  if (style === 'plain') return body;
  const theme = CALLOUT_THEME[block.emoji] || 'default';
  return '<Callout icon="' + block.emoji + '" theme="' + theme + '">\n' +
         body + '\n</Callout>';
}

function renderBlocks(blocks, imageUrls, calloutStyle) {
  const out = [];
  let recentHeading = '';
  // listIndents[level] is the exact indent a child at that level needs. A
  // nested item has to start at or past its parent's *content* column — three
  // for "1. ", two for "- " — or CommonMark reads it as a sibling and the
  // nesting silently disappears. A flat two spaces per level gets bullets
  // right and every numbered list wrong.
  const listIndents = [''];
  for (const block of blocks) {
    if (block.kind !== 'list' && block.kind !== 'blank') listIndents.length = 1;
    if (block.kind === 'blank') continue;
    if (block.kind === 'heading') {
      out.push('#'.repeat(block.level) + ' ' + escapeHeading(block.text));
      recentHeading = block.text;
    } else if (block.kind === 'para') {
      let text = block.text;
      for (const rid of block.images || []) {
        if (imageUrls[rid]) text = (text ? text + '\n' : '') + '![](' + imageUrls[rid] + ')';
      }
      if (text.trim()) out.push(text);
    } else if (block.kind === 'list') {
      const level = Math.max(0, Math.min(block.level || 0, listIndents.length - 1));
      const indent = listIndents[level];
      const marker = block.ordered ? '1.' : '-';
      // A hard break inside an item would end the list; ReadMe renders <br />.
      const text = String(block.text || '').replace(/\s*\n\s*/g, '<br />');
      out.push(indent + marker + ' ' + text);
      listIndents.length = level + 1;
      listIndents.push(indent + ' '.repeat(marker.length + 1));
    } else if (block.kind === 'callout') {
      out.push(renderCallout(block, calloutStyle));
    } else if (block.kind === 'code') {
      // Markdown input already carries its language; don't re-guess it.
      const lang = block.lang !== undefined ? block.lang
                                            : inferLanguage(block.text, recentHeading);
      const fence = fenceFor(block.text);
      out.push(fence + lang + '\n' + block.text + '\n' + fence);
    } else if (block.kind === 'table') {
      out.push(renderTable(block.rows));
    } else if (block.kind === 'mdxtable') {
      // Already ReadMe MDX, laid out the way their editor lays it out. Reflowing
      // or escaping it here would undo exactly what mdx-table.js just fixed.
      out.push(block.text);
    }
  }
  let body = out.join('\n\n');
  body = body.replace(/\n{3,}/g, '\n\n');
  body = body.replace(/^(\s*(?:-|1\.) .*)\n\n(?=\s*(?:-|1\.) )/gm, '$1\n');
  return body.trim() + '\n';
}

// ---------------------------------------------------------------------------
// Splitting / frontmatter
// ---------------------------------------------------------------------------

function splitBlocks(blocks, level) {
  const sections = [];
  let current = [], title = null;
  for (const block of blocks) {
    if (block.kind === 'heading' && block.level === level) {
      if (current.length || title) sections.push({ title, blocks: current });
      title = block.text; current = [];
      continue;
    }
    current.push(block);
  }
  if (current.length || title) sections.push({ title, blocks: current });
  return sections.filter((s) => s.title || s.blocks.some((b) => b.kind !== 'blank'));
}

// A newline inside a double-quoted YAML scalar is legal but folds; a title
// carrying one from a Word line break would silently lose the rest.
const yamlStr = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  .replace(/[\r\n]+/g, ' ').trim() + '"';

function frontmatter(title, extra, carry) {
  const lines = ['---', 'title: ' + yamlStr(title)];
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === null || v === undefined) continue;
    lines.push(k + ': ' + (typeof v === 'boolean' ? String(v) : yamlStr(v)));
  }
  for (const l of carry || []) lines.push(l);
  lines.push('---');
  return lines.join('\n') + '\n\n';
}

/**
 * The source page's own frontmatter, minus the keys this tool sets itself.
 * Nested blocks (`metadata:`, `next:`) come through whole — dropping a key
 * means dropping its indented children with it, not just its first line.
 */
function carryFrontmatter(raw, drop) {
  const out = [];
  let skipping = false;
  for (const line of String(raw || '').split('\n')) {
    const key = /^([A-Za-z_][\w.-]*)\s*:/.exec(line);
    if (key) skipping = drop.has(key[1].toLowerCase());
    else if (!/^\s+\S/.test(line)) skipping = false;   // not a continuation
    if (!skipping && line.trim()) out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

// title and hidden are set from the options; slug is the filename in a
// git-synced repo, not a frontmatter field.
const OWNED_FRONTMATTER = new Set(['title', 'hidden', 'slug']);

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function loadRels(zip) {
  const out = new Map();
  const bytes = zip.get('word/_rels/document.xml.rels');
  if (!bytes) return out;
  const doc = parseXml(bytes);
  for (const rel of doc.getElementsByTagNameNS(RELS_NS, 'Relationship')) {
    out.set(rel.getAttribute('Id'), rel.getAttribute('Target'));
  }
  return out;
}

function docTitle(zip, fallback) {
  const bytes = zip.get('docProps/core.xml');
  if (bytes) {
    try {
      const doc = parseXml(bytes);
      const el = doc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0];
      if (el && (el.textContent || '').trim()) return el.textContent.trim();
    } catch (e) { /* fall through */ }
  }
  return fallback;
}

function collectImages(zip, rels, blocks, stem, imageDir, report) {
  const wanted = [];
  const walk = (bs) => { for (const b of bs) for (const rid of b.images || []) if (!wanted.includes(rid)) wanted.push(rid); };
  walk(blocks);
  const urls = {}, files = [];
  wanted.forEach((rid, idx) => {
    const part = rels.get(rid);
    if (!part) return;
    const arc = part.startsWith('word/') ? part : 'word/' + part;
    const data = zip.get(arc) || zip.get(part);
    if (!data) { (report.missingImages = report.missingImages || []).push(part); return; }
    const base = part.split('/').pop();
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot) : '.png';
    const name = slugify(stem) + '-' + String(idx + 1).padStart(2, '0') + ext;
    const rel = imageDir + '/' + name;
    urls[rid] = rel;
    files.push({ path: rel, data });
  });
  if (files.length) report.images = files.length;
  return { urls, files };
}

/**
 * A zip that is NOT a .docx — i.e. a folder of documents someone zipped.
 * Returns the already-parsed zip so the caller does not decompress it twice;
 * on a 40 MB drop that second pass is seconds of frozen tab.
 */
async function looksLikeArchive(filename, bytes, arrayBuffer) {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null;
  if (/\.docx$/i.test(filename || '')) return null;
  try {
    const zip = await readZip(arrayBuffer);
    return zip.has('word/document.xml') ? null : zip;
  } catch (e) { return null; }
}

const DOC_MEMBER = /\.(docx|pdf|md|markdown|mdx|txt|html?|xhtml)$/i;
const SPEC_MEMBER = /\.(ya?ml|json)$/i;

/**
 * Convert every document inside a dropped .zip, preserving its folder layout,
 * and lay the results out the way ReadMe git-sync expects.
 */
async function convertArchive(arrayBuffer, filename, opts, parsedZip) {
  const report = { source: filename, kind: 'archive', members: [], warnings: [] };
  const zip = parsedZip || await readZip(arrayBuffer);

  const docs = [], specs = [];
  const names = [...zip.keys()].sort();
  for (const name of names) {
    const base = name.split('/').pop();
    // __MACOSX and dotfiles are packaging noise, not documents.
    if (!base || base.startsWith('.') || name.startsWith('__MACOSX/')) continue;
    if (SPEC_MEMBER.test(base) && !DOC_MEMBER.test(base)) {
      // Only treat it as a spec if it smells like one; a stray config is not.
      const head = new TextDecoder('utf-8').decode(zip.get(name).subarray(0, 400));
      if (/openapi|swagger/i.test(head)) specs.push({ path: name, data: zip.get(name) });
      continue;
    }
    if (!DOC_MEMBER.test(base)) continue;

    const bytes = zip.get(name);
    // `title` is per-document; inheriting the run-wide one would stamp the
    // same title on every page in the zip.
    const sub = { ...opts, category: '', split: 0, noFrontmatter: false, title: '' };
    sub.forceMarkdown = /\.(md|markdown|mdx|txt)$/i.test(base);
    try {
      const res = await convertDocument(bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength), base, sub);
      const page = res.files.find((f) => f.text !== undefined);
      if (!page) continue;
      const stem = base.replace(/\.[^.]+$/, '');
      docs.push({
        srcPath: name,
        // A page that already declared a slug keeps it: the filename is the
        // slug in a synced repo, so renaming breaks its published URL.
        slug: String((res.report.mdMeta || {}).slug || '').trim() ||
              slugify(window.gitSync.stripNumPrefix(stem)),
        body: page.text,
        // Images extracted from a member .docx travel with it. Without this
        // the page keeps its ![](images/…) references and the zip contains no
        // such file — a broken image on every synced page.
        assets: res.files.filter((f) => f.data !== undefined),
      });
      report.members.push({ name, kind: res.report.kind, ok: true });
      for (const k of ['codeBlocks', 'callouts', 'images', 'autocorrectFixes',
                       'mdEscapedTags', 'pdfTables'])
        if (res.report[k]) report[k] = (report[k] || 0) + res.report[k];
    } catch (err) {
      report.members.push({ name, ok: false, error: err.message || String(err) });
      report.warnings.push(name + ': ' + (err.message || err));
    }
  }

  if (!docs.length) {
    throw new Error('no .docx, .pdf, .html or .md files found inside this zip');
  }

  // Everything in ReadMe lives under a category. A zip of loose files has no
  // folder to name one after, so rather than drop those documents (which is
  // what silently happened), put them somewhere obvious and say so.
  const fallbackCategory = (opts.category || '').trim() || 'Documentation';
  if (docs.some((d) => !String(d.srcPath || '').includes('/'))) {
    (report.notes = report.notes || []).push(
      'documents at the top level of the zip went into the "' + fallbackCategory +
      '" category — set a category folder to name it something else.');
  }

  const built = window.gitSync.buildGitSync(docs, specs, {
    defaultCategory: fallbackCategory,
  });
  report.gitsync = built.report;
  report.warnings.push(...built.report.warnings);
  report.written = built.files.map((f) => f.path);
  return { files: built.files, report };
}

function looksLikeHtml(filename, bytes) {
  if (/\.(html?|xhtml)$/i.test(filename || '')) return true;
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 512)).trim().toLowerCase();
  return /^<!doctype html|^<html[\s>]|^<\?xml[^>]*>\s*<!doctype html/.test(head);
}

function looksLikeMarkdown(filename, bytes) {
  if (/\.(md|markdown|mdx|txt)$/i.test(filename || '')) return true;
  // A .docx is a zip and a PDF starts %PDF-; anything else that decodes as
  // text is treated as Markdown rather than rejected outright, so a file with
  // no extension or an unfamiliar one still converts instead of failing with
  // "not a zip".
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return false;   // PK zip
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512));
  if (head.indexOf('%PDF-') !== -1) return false;
  if (head.charCodeAt(0) === 0xd0 && head.charCodeAt(1) === 0xcf) return false;  // OLE2 .doc
  // A NUL in the first bytes means binary; text formats never contain one.
  for (let i = 0; i < Math.min(bytes.length, 512); i++) if (bytes[i] === 0) return false;
  return true;
}

function looksLikePdf(bytes) {
  // %PDF- may sit a few bytes in on files with a junk prefix.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.indexOf('%PDF-') !== -1;
}

/**
 * The shared tail of all four readers. Each one produces Block[]; from here
 * on the treatment is identical, which is the whole reason they share a block
 * model. Order matters: sections are dropped before the cover is found,
 * code is merged before callouts are detected in what is left, and headings
 * are remapped last so demoted labels are already gone.
 */
function applyPasses(blocks, opts, report) {
  blocks = dropTocAndSections(blocks, opts.dropSections, report);
  if (!opts.keepCover) blocks = dropCover(blocks, report);
  blocks = mergeCodeBlocks(blocks, report);
  if (!opts.noCallouts) blocks = convertCallouts(blocks, report);
  blocks = demoteLabelHeadings(blocks, opts.labels, opts.labelStyle, report);
  return remapHeadingLevels(blocks, opts.topLevel, opts.maxLevel, report);
}

/**
 * Convert one document. Dispatches on content, not just the extension, so a
 * PDF named .docx still works.
 * @returns {{files: Array<{path,data,text?}>, report: object}}
 */
async function convertDocument(arrayBuffer, filename, opts) {
  const stem = filename.replace(/\.[^.]+$/, '');
  const report = { source: filename };
  const head = new Uint8Array(arrayBuffer, 0, Math.min(1024, arrayBuffer.byteLength));

  const archiveZip = await looksLikeArchive(filename, head, arrayBuffer);
  if (archiveZip) {
    return convertArchive(arrayBuffer, filename, opts, archiveZip);
  }

  let blocks, zip = null, ctx = null;

  if (looksLikeHtml(filename, head)) {
    report.kind = 'html';
    if (!window.htmlExtract) throw new Error('the HTML reader did not load — reload the page');
    blocks = window.htmlExtract.htmlToBlocks(
      new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer)), report);
  } else if (opts.forceMarkdown || looksLikeMarkdown(filename, head)) {
    report.kind = 'markdown';
    if (!window.mdClean) throw new Error('the Markdown cleaner did not load — reload the page');
    const text = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer));
    blocks = window.mdClean.markdownToBlocks(text, report);
    if (!blocks.length) throw new Error('no content found in this Markdown file');
  } else if (looksLikePdf(head)) {
    report.kind = 'pdf';
    if (!window.pdfExtract) throw new Error('the PDF engine did not load — reload the page');
    blocks = await window.pdfExtract.pdfToBlocks(arrayBuffer, opts, report);
  } else {
    report.kind = 'docx';
    zip = await readZip(arrayBuffer);
    const documentBytes = zip.get('word/document.xml');
    if (!documentBytes) {
      if (zip.has('WordDocument') || zip.size === 0) {
        throw new Error('this is the older Word format — open it in Word and use ' +
                        'File \u2192 Save As \u2192 .docx, then try again');
      }
      throw new Error('no word/document.xml — not a .docx. ' +
                      '(.doc and .docm need a resave as .docx)');
    }
    ctx = {
      styles: buildStyleTable(zip.get('word/styles.xml')),
      numfmt: buildNumberingFormats(zip.get('word/numbering.xml')),
      rels: loadRels(zip),
    };
    blocks = parseBody(documentBytes, ctx);
  }

  report.blocksIn = blocks.length;
  blocks = applyPasses(blocks, opts, report);

  // "pasted" is a placeholder filename, not a real document title.
  const fallbackTitle = stem === 'pasted' ? '' : stem.replace(/[-_]+/g, ' ').trim();
  const title = opts.title || report.mdTitle || report.htmlTitle ||
                (zip ? docTitle(zip, fallbackTitle) : fallbackTitle);
  const { urls, files: imageFiles } = zip
    ? collectImages(zip, ctx.rels, blocks, stem, opts.imageDir, report)
    : { urls: {}, files: [] };

  // Markdown that already carried ReadMe frontmatter keeps it — excerpt, icon,
  // deprecated, the whole nested metadata block. And its slug drives the
  // filename, because in a synced repo the filename *is* the slug and
  // renaming the file breaks every inbound link to a published page.
  const carried = carryFrontmatter((report.mdMeta || {}).__raw, OWNED_FRONTMATTER);
  const carriedSlug = String((report.mdMeta || {}).slug || '').trim();

  const prefix = opts.category ? opts.category + '/' : '';
  const out = [];

  if (opts.split) {
    const splitLevel = Math.min(6, opts.topLevel + opts.split - 1);
    let sections = splitBlocks(blocks, splitLevel);
    if (sections.length <= 1) {
      (report.notes = report.notes || []).push(
        'split found no H' + splitLevel + ' headings; wrote a single page.');
      sections = [{ title, blocks }];
    }
    // _order.yaml carries the order, so the filenames do not need to — and
    // must not, because in a synced repo the filename is the slug and
    // "01-alpha.md" would publish at /01-alpha while _order.yaml said "alpha".
    const order = [];
    const used = new Set();
    sections.forEach((sec) => {
      const secTitle = sec.title || title;
      let slug = slugify(secTitle);
      if (used.has(slug)) {
        let n = 2;
        while (used.has(slug + '-' + n)) n++;
        slug = slug + '-' + n;
      }
      used.add(slug);
      const body = renderBlocks(sec.blocks, urls, opts.calloutStyle);
      const head = opts.noFrontmatter ? ''
        : frontmatter(secTitle, opts.hidden ? { hidden: true } : {});
      out.push({ path: prefix + slug + '.md', text: head + body });
      order.push(slug);
    });
    out.push({ path: prefix + '_order.yaml', text: order.map((s) => '- ' + s + '\n').join('') });
  } else {
    const body = renderBlocks(blocks, urls, opts.calloutStyle);
    const slug = carriedSlug || slugify(stem);
    const head = opts.noFrontmatter ? ''
      : frontmatter(title, opts.hidden ? { hidden: true } : {}, carried);
    out.push({ path: prefix + slug + '.md', text: head + body });
  }

  for (const img of imageFiles) out.push({ path: prefix + img.path, data: img.data });
  report.written = out.map((f) => f.path);
  return { files: out, report };
}

function defaultOptions() {
  return {
    category: '',
    split: 0,
    title: '',
    topLevel: 2,
    maxLevel: 3,
    imageDir: 'images',
    keepCover: false,
    dropSections: new Set(DEFAULT_DROP_SECTIONS),
    labels: new Set(DEFAULT_LABEL_HEADINGS),
    labelStyle: 'bold',
    noCallouts: false,
    noFrontmatter: false,
    hidden: true,
    // The single-file build inlines pdf.js and exposes it as blob: URLs;
    // the hosted build loads it from vendor/.
    calloutStyle: 'component',   // component | blockquote | plain
    forceMarkdown: false,
    pdfLibUrl: window.__PDFJS_LIB_URL__ || 'vendor/pdf.mjs',
    pdfWorkerUrl: window.__PDFJS_WORKER_URL__ || 'vendor/pdf.worker.mjs',
  };
}

window.docx2readme = { convertDocument, convertDocx: convertDocument, defaultOptions,
                       looksLikeMarkdown, looksLikeHtml, convertArchive,
                       applyPasses, renderBlocks,
                       escapeInline: esc,
                       makeZip, slugify, normKey, looksLikePdf,
                       DEFAULT_LABEL_HEADINGS, DEFAULT_DROP_SECTIONS };
