/* pdf-e2e.test.mjs — a real PDF, read by the real pdf.js in vendor/.
 *
 * pdf.test.js feeds synthetic glyph positions into the reconstruction rules,
 * which is where the guessing lives. This checks the other half: that the
 * shape pdf.js actually hands back for a real file is the shape those rules
 * expect. The two together are what stop a pdf.js upgrade from quietly
 * changing every PDF conversion.
 *
 * The fixture is generated, not committed — tests/fixtures/make-pdf.py.
 */
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeWindow } = require('./harness.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

function samplePdf() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doc2readme-')), 'sample.pdf');
  execFileSync('python3', [path.join(HERE, 'fixtures', 'make-pdf.py'), out], { stdio: 'pipe' });
  return out;
}

/** The same loop pdfToBlocks runs, with pdf.js imported the Node way. */
async function readPdf(win, file) {
  const lib = await import(pathToFileURL(path.join(ROOT, 'vendor', 'pdf.mjs')).href);
  lib.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(ROOT, 'vendor', 'pdf.worker.mjs')).href;
  const doc = await lib.getDocument({
    data: new Uint8Array(fs.readFileSync(file)),
    isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0,
  }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push(win.pdfExtract.groupLines(
      content.items.map((it) => win.pdfExtract.toItem(it, content.styles, viewport.height))));
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

let win, blocks, report, markdown;

test.before(async () => {
  win = makeWindow();
  const pages = await readPdf(win, samplePdf());
  assert.equal(pages.length, 3, 'pdf.js did not return three pages');
  report = { kind: 'pdf' };
  blocks = win.pdfExtract.linesToBlocks(pages, report, win.docx2readme.defaultOptions());
});

const kinds = () => blocks.map((b) => b.kind);
const textOf = () => blocks.map((b) => b.text || (b.rows || []).flat().join(' ')).join('\n');

test('the title page is dropped', () => {
  assert.ok(report.coverLines, 'no cover detected');
  assert.doesNotMatch(textOf(), /Integration Guide/);
});

test('the running header and page numbers are dropped', () => {
  assert.doesNotMatch(textOf(), /Confidential/);
  assert.ok(report.pdfFurnitureDropped >= 1);
});

test('font sizes become a heading ladder', () => {
  const heads = blocks.filter((b) => b.kind === 'heading').map((b) => b.text);
  assert.ok(heads.includes('Introduction'), 'headings found: ' + JSON.stringify(heads));
  assert.ok(heads.includes('Error codes'));
  const intro = blocks.find((b) => b.text === 'Introduction');
  const step = blocks.find((b) => b.text === 'Step 1 - Obtain a token');
  assert.ok(step && step.kind === 'heading', 'the smaller heading was not detected');
  assert.ok(step.level > intro.level, 'heading ladder is flat');
});

test('the Courier block becomes one code block', () => {
  const code = blocks.filter((b) => b.kind === 'code');
  assert.ok(code.length >= 1, 'no code detected: ' + JSON.stringify(kinds()));
  assert.match(code.map((c) => c.text).join('\n'), /curl -X POST/);
});

test('aligned columns become tables', () => {
  const tables = blocks.filter((b) => b.kind === 'table');
  assert.ok(tables.length >= 1, 'no table reconstructed: ' + JSON.stringify(kinds()));
  assert.deepEqual(tables[0].rows[0], ['Field', 'Type', 'Description']);
});

test('wrapped prose rejoins and hyphenation is repaired', () => {
  assert.match(textOf(), /wrapped across lines/,
    'hyphenated word not rejoined: ' + JSON.stringify(textOf().slice(0, 400)));
});

test('the whole conversion is MDX-safe', () => {
  const opts = win.docx2readme.defaultOptions();
  const cleaned = win.docx2readme.applyPasses(blocks, opts, report);
  markdown = win.docx2readme.renderBlocks(cleaned, {}, opts.calloutStyle);
  const prose = markdown.replace(/^ {0,3}(`{3,})[\s\S]*?\n {0,3}\1/gm, '');
  assert.doesNotMatch(prose, /(^|[^\\])<access_token>/, prose);
  assert.doesNotMatch(prose, /(^|[^\\])\{"amount"/, prose);
  assert.equal((markdown.match(/^ {0,3}`{3,}/gm) || []).length % 2, 0, 'unbalanced fences');
});
