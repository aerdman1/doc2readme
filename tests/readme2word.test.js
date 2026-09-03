/* readme2word.test.js — a ReadMe export -> Word.
 *
 * The shape that matters is not "does it produce a file" but "does it produce
 * the right file": pages in sidebar order, headings nested by nav depth, and
 * a list that Word actually renders as a list.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeWindow } = require('./harness');

const win = makeWindow();
const { parseExport, imageUrls, safeName } = win.readmeExport;
const { renderDocx } = win.docxRender;

const page = (title, body, extra) =>
  '---\ntitle: ' + title + '\n' + (extra || '') + '---\n' + body;

/** The shape ReadMe writes: _order.yaml at every level, index.md for a parent. */
function exportFiles() {
  return new Map(Object.entries({
    'docs/_order.yaml': '- Guides\n- Zebra\n',            // deliberately not alphabetical
    'docs/Guides/_order.yaml': '- second\n- first\n- parent\n- draft\n',
    'docs/Guides/second.md': page('Second', 'Body two.\n'),
    'docs/Guides/first.md': page('First', 'Body one.\n'),
    'docs/Guides/parent/_order.yaml': '- kid\n',
    'docs/Guides/parent/index.md': page('Parent', 'Parent body.\n'),
    'docs/Guides/parent/kid.md': page('Kid', '# Deep heading\n\nKid body.\n'),
    'docs/Guides/draft.md': page('Draft', 'Nope.\n', 'hidden: true\n'),
    'docs/Zebra/_order.yaml': '- only\n',
    'docs/Zebra/only.md': page('Only', 'Zebra body.\n'),
  }));
}

test('categories and pages follow _order.yaml, not the filesystem', () => {
  const groups = parseExport(exportFiles());
  assert.deepEqual(groups.map((g) => g.category), ['Guides', 'Zebra']);
  assert.deepEqual(groups[0].pages.map((p) => p.title),
    ['Second', 'First', 'Parent', 'Kid']);
});

test('nav depth is carried, so headings can nest under the page title', () => {
  const g = parseExport(exportFiles())[0];
  assert.deepEqual(g.pages.map((p) => [p.title, p.depth]),
    [['Second', 1], ['First', 1], ['Parent', 1], ['Kid', 2]]);
});

test('a page missing from _order.yaml is appended, not dropped', () => {
  const files = exportFiles();
  files.set('docs/Guides/_order.yaml', '- second\n');   // mentions one of four
  const titles = parseExport(files)[0].pages.map((p) => p.title);
  assert.equal(titles[0], 'Second');
  for (const t of ['First', 'Parent', 'Kid']) assert.ok(titles.includes(t), 'lost ' + t);
});

test('hidden pages are left out unless asked for', () => {
  const titles = (opts) => parseExport(exportFiles(), opts)[0].pages.map((p) => p.title);
  assert.ok(!titles({}).includes('Draft'));
  assert.ok(titles({ includeHidden: true }).includes('Draft'));
});

test('a .mdx page is read like a .md one', () => {
  const files = exportFiles();
  files.delete('docs/Zebra/only.md');
  files.set('docs/Zebra/only.mdx', page('Only', 'Zebra body.\n'));
  assert.equal(parseExport(files)[1].pages[0].title, 'Only');
});

/* ------------------------------------------------------------- the writer */

const build = (pages, opts) => {
  const parts = renderDocx({ title: 'Guides', pages }, opts || {});
  const byPath = Object.fromEntries(parts.map((p) => [p.path, p.data]));
  return { parts, byPath, doc: String(byPath['word/document.xml']) };
};

const blocks = (md) => win.mdClean.markdownToBlocks(md, {});

test('the part list is a valid docx skeleton', () => {
  const { byPath } = build([{ title: 'P', depth: 1, blocks: blocks('Hi.\n') }]);
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml',
                   'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']) {
    assert.ok(byPath[p], 'missing part ' + p);
  }
});

test('bullets carry a real glyph — an empty w:lvlText is an invisible list', () => {
  // Regression: w:lvlText="" is a structurally valid list whose markers do not
  // render, so five bullets read as five stray paragraphs.
  const { byPath } = build([{ title: 'P', depth: 1, blocks: blocks('- one\n- two\n') }]);
  const numbering = String(byPath['word/numbering.xml']);
  assert.ok(!/<w:lvlText w:val=""\/>/.test(numbering), 'bullet glyph is empty');
  assert.match(numbering, /<w:lvlText w:val=""\/>/);
});

test('a list item is one paragraph per item, numbered', () => {
  const { doc } = build([{ title: 'P', depth: 1, blocks: blocks('- one\n- two\n- three\n') }]);
  assert.equal((doc.match(/<w:numPr>/g) || []).length, 3);
});

test('a page title lands at its nav depth', () => {
  const { doc } = build([
    { title: 'Top', depth: 1, blocks: [] },
    { title: 'Nested', depth: 3, blocks: [] },
  ]);
  assert.match(doc, /Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Top</);
  assert.match(doc, /Heading3"\/><\/w:pPr><w:r><w:t xml:space="preserve">Nested</);
});

test('a table becomes a real w:tbl with a header row', () => {
  const { doc } = build([{ title: 'P', depth: 1,
    blocks: blocks('| a | b |\n| --- | --- |\n| 1 | 2 |\n') }]);
  assert.match(doc, /<w:tbl>/);
  assert.match(doc, /<w:tblHeader\/>/);
});

test('<Callout> survives as a shaded block, not literal tag text', () => {
  const { doc } = build([{ title: 'P', depth: 1,
    blocks: blocks('<Callout icon="📘">\nMind this.\n</Callout>\n') }]);
  assert.ok(!/&lt;Callout/.test(doc), 'callout leaked as escaped tag text');
  assert.match(doc, /Mind this\./);
});

test('an image embeds when its bytes are supplied', () => {
  // 1x1 PNG — enough for the header sniffer to read a size from.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const md = '<Image src="https://files.readme.io/x.png" />\n';
  const b = blocks(md);
  assert.deepEqual(imageUrls([{ blocks: b }]), ['https://files.readme.io/x.png']);

  const withBytes = build([{ title: 'P', depth: 1, blocks: b }],
    { media: { 'https://files.readme.io/x.png': { data: new Uint8Array(png), ext: 'png' } } });
  assert.match(withBytes.doc, /<w:drawing>/);
  assert.ok(withBytes.parts.some((p) => /^word\/media\//.test(p.path)));
});

test('a missing image degrades to a labelled placeholder, never silence', () => {
  const b = blocks('<Image src="https://files.readme.io/gone.png" />\n');
  const { doc } = build([{ title: 'P', depth: 1, blocks: b }], { media: {} });
  assert.ok(!/<w:drawing>/.test(doc));
  assert.match(doc, /\[image: /);
});

test('a filename that Windows would reject is cleaned', () => {
  assert.equal(safeName('API: Cuentas/Tarjetas'), 'API- Cuentas-Tarjetas');
});
