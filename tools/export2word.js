#!/usr/bin/env node
/* export2word — a ReadMe zip export -> one Word document per category.
 *
 *   node tools/export2word.js <export.zip> [outDir]
 *
 * WHY THIS IS A LOCAL TOOL AND NOT PART OF THE PAGE
 *
 *   A ReadMe zip export contains no images. Every <Image> in the Markdown is an
 *   https://files.readme.io/... URL, so the bytes have to be fetched. The hosted
 *   page cannot do that and should not be able to: its CSP is `connect-src
 *   'none'` and `img-src 'self' data: blob:`, and that guarantee is the product.
 *
 *   So the fetch lives here, outside the browser, where no such promise is made.
 *   Everything else — the reader, the passes, the writer, the zip — is the same
 *   shipped code the page runs, loaded through the same jsdom harness the tests
 *   use, so this converts exactly what the page would convert.
 *
 * ORDER COMES FROM _order.yaml, NOT THE FILESYSTEM. Sorting by filename puts
 * pages in an order no reader recognises; ReadMe's own sidebar order is the
 * whole point of the document.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const { makeWindow } = require('../tests/harness');

/* ------------------------------------------------------------------ unzip */

/** Minimal zip reader. Filenames are decoded UTF-8, which is what ReadMe writes
 *  (and what macOS's bundled `unzip` gets wrong on accented names). */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const body = buf.slice(start, start + compSize);
    if (!name.endsWith('/')) {
      out.set(name, method === 8 ? zlib.inflateRawSync(body) : body);
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/* ------------------------------------------------------------------ images */

function fetchImage(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        data: Buffer.concat(chunks),
        ext: (/\.(png|jpe?g|gif|webp)(?:$|\?)/i.exec(url) || [])[1] ||
             ((res.headers['content-type'] || '').split('/')[1] || 'png').split(';')[0],
      }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/* -------------------------------------------------------------------- main */

async function main() {
  const [zipPath, outDir = 'word-out'] = process.argv.slice(2);
  if (!zipPath) {
    console.error('usage: node tools/export2word.js <export.zip> [outDir]');
    process.exit(2);
  }
  const noImages = process.argv.includes('--no-images');

  const files = readZip(fs.readFileSync(zipPath));
  const win = makeWindow();

  const groups = win.readmeExport.parseExport(files, { includeHidden: false });

  fs.mkdirSync(outDir, { recursive: true });
  const report = [];

  for (const { category: cat, pages } of groups) {

    // Markdown -> Block[]. topLevel puts a page's own headings underneath its
    // title; maxLevel is 6 here, not the page default of 3, or a grandchild's
    // headings all collapse into one level and the structure disappears.
    const built = pages.map((pg) => {
      const rep = {};
      let blocks = win.mdClean.markdownToBlocks(pg.body, rep);
      blocks = win.docx2readme.applyPasses(blocks, Object.assign(
        {}, win.docx2readme.defaultOptions(),
        { topLevel: Math.min(6, pg.depth + 1), maxLevel: 6, noCallouts: true }), rep);
      return Object.assign({}, pg, { blocks });
    });

    const urls = win.readmeExport.imageUrls(built);
    const media = {};
    if (!noImages) {
      let got = 0;
      for (const u of urls) {
        const img = await fetchImage(u);
        if (img) { media[u] = img; got++; }
      }
      report.push({ cat, pages: built.length, images: urls.length, embedded: got });
    } else {
      report.push({ cat, pages: built.length, images: urls.length, embedded: 0 });
    }

    const parts = win.docxRender.renderDocx({ title: cat, pages: built }, { media });
    const blob = win.docx2readme.makeZip(parts);
    const buf = Buffer.from(await blob.arrayBuffer());
    const safe = win.readmeExport.safeName(cat);
    fs.writeFileSync(path.join(outDir, safe + '.docx'), buf);
  }

  console.log('category'.padEnd(38) + 'pages  images  embedded   file');
  for (const r of report) {
    console.log(r.cat.slice(0, 36).padEnd(38) +
      String(r.pages).padStart(5) + String(r.images).padStart(8) +
      String(r.embedded).padStart(10) + '   ' + r.cat + '.docx');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
