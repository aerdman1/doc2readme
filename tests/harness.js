/* harness.js — load the browser modules into a jsdom window so they can be
 * tested in Node.
 *
 * The shipped code is deliberately dependency-free classic scripts that talk
 * to `window`. Rather than refactor that into modules (which would change what
 * ships), this stands up a real DOM, injects the handful of platform globals
 * Node has but jsdom does not (Blob, Response, DecompressionStream), and evals
 * each file in the window context in the same order index.html does.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

/* Every browser the page supports (Chrome 103+, Firefox 113+, Safari 16.4+)
 * has DecompressionStream('deflate-raw'), which is how a .docx gets unpacked.
 * Node only gained it in 20, so on older Node the shipped code is correct and
 * the runtime is not — stand in for it rather than weaken the code. */
const RawDeflateOk = (() => {
  try { new globalThis.DecompressionStream('deflate-raw'); return true; }
  catch (e) { return false; }
})();

class ShimDecompression {
  constructor(format) {
    const zlib = require('zlib');
    const inflate = format === 'deflate-raw' ? zlib.inflateRawSync
      : format === 'gzip' ? zlib.gunzipSync : zlib.inflateSync;
    const chunks = [];
    this.readable = new ReadableStream({
      start: (c) => { this._done = () => {
        const all = Buffer.concat(chunks.map((u) => Buffer.from(u)));
        c.enqueue(new Uint8Array(inflate(all)));
        c.close();
      }; },
    });
    this.writable = new WritableStream({
      write: (chunk) => { chunks.push(chunk); },
      close: () => this._done(),
    });
  }
}

// index.html loads these in this order; a test that loads them differently is
// not testing what ships.
const SCRIPTS = ['preview.js', 'md-clean.js', 'mdx-table.js', 'html-extract.js', 'gitsync.js',
                 'pdf-extract.js', 'converter.js', 'readme-export.js', 'docx-render.js', 'table-wizard.js'];

function makeWindow({ withApp = false } = {}) {
  const html = withApp
    ? fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
        // Let the harness control script execution order and error reporting.
        .replace(/<script src="[^"]*"><\/script>/g, '')
    : '<!doctype html><html><body></body></html>';

  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });
  const win = dom.window;

  // Platform pieces Node has and jsdom does not.
  win.DecompressionStream = RawDeflateOk ? globalThis.DecompressionStream : ShimDecompression;
  for (const name of ['Blob', 'Response', 'DecompressionStream', 'CompressionStream',
                      'TextEncoder', 'TextDecoder', 'ReadableStream', 'structuredClone']) {
    if (typeof globalThis[name] !== 'undefined' && typeof win[name] === 'undefined') {
      win[name] = globalThis[name];
    }
  }
  // jsdom's Blob and Node's Response do not interoperate; use Node's Blob.
  win.Blob = globalThis.Blob;

  for (const file of SCRIPTS) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    try {
      vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
    } catch (err) {
      throw new Error('failed loading ' + file + ': ' + err.message);
    }
  }

  if (withApp) {
    const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    vm.runInContext(src, dom.getInternalVMContext(), { filename: 'app.js' });
  }
  return win;
}

/* ---------------------------------------------------------------- fixtures */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Minimal but real styles.xml with Heading1..6 plus a mono "Code" style. */
function stylesXml(extra) {
  const heads = [1, 2, 3, 4, 5, 6].map((n) => `
    <w:style w:type="paragraph" w:styleId="Heading${n}">
      <w:name w:val="heading ${n}"/><w:pPr><w:outlineLvl w:val="${n - 1}"/></w:pPr>
    </w:style>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  ${heads}
  <w:style w:type="paragraph" w:styleId="Code">
    <w:name w:val="Code"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>
  ${extra || ''}
</w:styles>`;
}

function numberingXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
}

/* Small builders so a test reads like the document it describes. */
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const run = (text, o = {}) =>
  `<w:r><w:rPr>${o.bold ? '<w:b/>' : ''}${o.italic ? '<w:i/>' : ''}` +
  `${o.strike ? '<w:strike/>' : ''}${o.vanish ? '<w:vanish/>' : ''}` +
  `${o.font ? `<w:rFonts w:ascii="${o.font}" w:hAnsi="${o.font}"/>` : ''}</w:rPr>` +
  `<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;

const para = (text, o = {}) => {
  const ppr = [];
  if (o.style) ppr.push(`<w:pStyle w:val="${o.style}"/>`);
  if (o.numId) ppr.push(`<w:numPr><w:ilvl w:val="${o.ilvl || 0}"/><w:numId w:val="${o.numId}"/></w:numPr>`);
  if (o.indent) ppr.push(`<w:ind w:left="${o.indent}"/>`);
  const runs = Array.isArray(text) ? text.join('') : run(text, o);
  return `<w:p>${ppr.length ? `<w:pPr>${ppr.join('')}</w:pPr>` : ''}${runs}</w:p>`;
};

const heading = (level, text) => para(text, { style: 'Heading' + level });

const cell = (text, span) =>
  `<w:tc><w:tcPr>${span ? `<w:gridSpan w:val="${span}"/>` : ''}</w:tcPr>` +
  (Array.isArray(text) ? text.map((t) => para(t)).join('') : para(text)) + '</w:tc>';

const table = (rows) =>
  `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => (Array.isArray(c) && typeof c[1] === 'number'
    ? cell(c[0], c[1]) : cell(c))).join('')}</w:tr>`).join('')}</w:tbl>`;

/**
 * Build a real .docx ArrayBuffer from a body fragment. Uses the shipped zip
 * writer so the reader is exercised against bytes it did not itself create in
 * a special path.
 */
function buildDocx(win, bodyXml, opts = {}) {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`;

  const files = [
    { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { path: 'word/document.xml', data: doc },
    { path: 'word/styles.xml', data: stylesXml(opts.extraStyles) },
    { path: 'word/numbering.xml', data: numberingXml() },
  ];
  if (opts.rels) {
    files.push({
      path: 'word/_rels/document.xml.rels',
      data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        Object.entries(opts.rels).map(([id, target]) =>
          `<Relationship Id="${id}" Target="${xmlEsc(target)}" Type="x"/>`).join('') +
        '</Relationships>',
    });
  }
  if (opts.coreTitle) {
    files.push({
      path: 'docProps/core.xml',
      data: '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' + xmlEsc(opts.coreTitle) + '</dc:title></cp:coreProperties>',
    });
  }
  for (const [p, data] of Object.entries(opts.extraFiles || {})) files.push({ path: p, data });
  return blobToArrayBuffer(win.docx2readme.makeZip(files));
}

/** Build a plain .zip of arbitrary members (a "folder someone zipped"). */
function buildZip(win, members) {
  return blobToArrayBuffer(win.docx2readme.makeZip(
    Object.entries(members).map(([path, data]) => ({ path, data }))));
}

function blobToArrayBuffer(blob) {
  // makeZip returns a Blob built from Uint8Array chunks; read it synchronously
  // is not possible, so tests await this.
  return blob.arrayBuffer();
}

const enc = (text) => new TextEncoder().encode(text).buffer;

module.exports = { makeWindow, buildDocx, buildZip, enc, para, heading, run, table, cell, W };
