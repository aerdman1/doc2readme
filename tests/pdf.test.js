/* pdf.test.js — the PDF heuristics, exercised without pdf.js.
 *
 * pdf.js's job is turning a PDF into positioned glyphs; that is well tested
 * upstream. What is worth testing here is the reconstruction on top of it, so
 * these feed synthetic text items — the exact shape pdf.js hands back — into
 * groupLines/detectTable/linesToBlocks.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeWindow } = require('./harness');

let win;
test.before(() => { win = makeWindow(); });

/** A pdf.js text item: transform is [a,b,c,d,x,y] with y measured from bottom. */
const item = (str, x, yTop, { size = 10, font = 'Helvetica', w } = {}) => ({
  str, width: w === undefined ? str.length * size * 0.5 : w, height: size,
  transform: [size, 0, 0, size, x, 800 - yTop], fontName: font, hasEOL: false,
});

const lines = (items) =>
  win.pdfExtract.groupLines(items.map((raw) => win.pdfExtract.toItem(raw, {}, 800)));

test('items on the same baseline become one line, in x order', () => {
  const ls = lines([item('world', 150, 100), item('Hello', 100, 100)]);
  assert.equal(ls.length, 1);
  assert.match(ls[0].text, /^Hello\s+world$/);
});

test('a bigger font becomes a heading, body text does not', () => {
  const ls = lines([
    item('Chapter One', 72, 100, { size: 20 }),
    item('This is ordinary body copy that runs on for a while.', 72, 130),
    item('More ordinary body copy at the usual size here.', 72, 150),
  ]);
  const report = {};
  const blocks = win.pdfExtract.linesToBlocks([ls], report, { keepCover: true });
  assert.equal(blocks[0].kind, 'heading');
  assert.equal(blocks[0].text, 'Chapter One');
  assert.ok(blocks.slice(1).every((b) => b.kind === 'para'));
});

test('monospace lines become a single code block', () => {
  const ls = lines([
    item('curl -X POST \\', 72, 100, { font: 'CourierNew' }),
    item('  -d @body.json', 72, 116, { font: 'CourierNew' }),
  ]);
  const blocks = win.pdfExtract.linesToBlocks([ls], {}, { keepCover: true });
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.kind === 'code'));
});

test('columns separated by wide gutters become a table', () => {
  const mk = (a, b, c, y) => [item(a, 72, y), item(b, 220, y), item(c, 380, y)];
  const ls = lines([...mk('Field', 'Type', 'Required', 100),
                    ...mk('id', 'string', 'yes', 120),
                    ...mk('name', 'string', 'no', 140)]);
  const report = {};
  const blocks = win.pdfExtract.linesToBlocks([ls], report, { keepCover: true });
  assert.equal(blocks[0].kind, 'table');
  assert.deepEqual(blocks[0].rows[0], ['Field', 'Type', 'Required']);
  assert.equal(report.pdfTables, 1);
});

test('two lines of prose are not turned into a table', () => {
  const ls = lines([
    item('Some ordinary sentence with words', 72, 100),
    item('Another ordinary sentence follows', 72, 120),
  ]);
  const blocks = win.pdfExtract.linesToBlocks([ls], {}, { keepCover: true });
  assert.ok(blocks.every((b) => b.kind !== 'table'));
});

test('repeated running heads and page numbers are dropped', () => {
  const mkPage = (n) => lines([
    item('Celcoin — Confidential', 72, 40),
    item('Content of page ' + n + ' goes here and is unique.', 72, 200),
    item(String(n), 300, 760),
  ]);
  const report = {};
  const blocks = win.pdfExtract.linesToBlocks([mkPage(1), mkPage(2), mkPage(3)], report,
    { keepCover: true });
  const text = blocks.map((b) => b.text).join('\n');
  assert.doesNotMatch(text, /Confidential/);
  assert.ok(report.pdfFurnitureDropped >= 1);
});

test('wrapped lines rejoin into one paragraph', () => {
  const ls = lines([
    item('This sentence is split across two', 72, 100, { w: 400 }),
    item('lines by the PDF layout engine.', 72, 114, { w: 300 }),
  ]);
  const blocks = win.pdfExtract.linesToBlocks([ls], {}, { keepCover: true });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /split across two lines by/);
});

test('a word hyphenated across a line break is rejoined without the hyphen', () => {
  const ls = lines([
    item('The authorization proce-', 72, 100, { w: 400 }),
    item('dure requires a token.', 72, 114, { w: 300 }),
  ]);
  const blocks = win.pdfExtract.linesToBlocks([ls], {}, { keepCover: true });
  assert.match(blocks[0].text, /procedure requires/,
    'hyphenation not repaired: ' + JSON.stringify(blocks[0].text));
});

test('bullets become list items', () => {
  const ls = lines([
    item('• First point', 72, 100),
    item('• Second point', 72, 120),
  ]);
  const blocks = win.pdfExtract.linesToBlocks([ls], {}, { keepCover: true });
  assert.deepEqual(blocks.map((b) => b.kind), ['list', 'list']);
  assert.equal(blocks[0].text, 'First point');
});

test('a title page is dropped', () => {
  const cover = lines([
    item('Open Finance API', 120, 300, { size: 28 }),
    item('Integration Guide', 130, 350, { size: 22 }),
  ]);
  const rest = lines([
    item('Introduction', 72, 100, { size: 16 }),
    item('Ordinary body copy on the second page of the document.', 72, 130),
  ]);
  const report = {};
  const blocks = win.pdfExtract.linesToBlocks([cover, rest], report, {});
  assert.ok(report.coverLines);
  assert.doesNotMatch(blocks.map((b) => b.text).join('\n'), /Integration Guide/);
});

test('angle brackets and braces in PDF text are escaped for MDX', () => {
  const ls = lines([
    item('Send code=<authorization code> and {"id":1} in the body.', 72, 100),
    item('A second line so this is a real paragraph run.', 72, 120),
  ]);
  const blocks = win.pdfExtract.linesToBlocks([ls], {}, { keepCover: true });
  const text = blocks.map((b) => b.text).join('\n');
  assert.doesNotMatch(text, /[^\\]<authorization/);
  assert.doesNotMatch(text, /[^\\]\{"id"/);
});

test('a table cell with a placeholder is escaped', () => {
  const mk = (a, b, y) => [item(a, 72, y), item(b, 260, y)];
  const ls = lines([...mk('Param', 'Value', 100),
                    ...mk('code', '<authorization code>', 120),
                    ...mk('state', '{opaque}', 140)]);
  const blocks = win.pdfExtract.linesToBlocks([ls], {}, { keepCover: true });
  const t = blocks.find((b) => b.kind === 'table');
  assert.ok(t, 'no table detected');
  const flat = t.rows.flat().join(' ');
  assert.doesNotMatch(flat, /[^\\]<authorization/);
  assert.doesNotMatch(flat, /[^\\]\{opaque/);
});
