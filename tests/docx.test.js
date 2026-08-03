'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeWindow, buildDocx, heading, para, run, table } = require('./harness');

let win;
test.before(() => { win = makeWindow(); });

async function convert(bodyXml, over = {}, docOpts = {}) {
  const opts = Object.assign(win.docx2readme.defaultOptions(), over);
  const buf = await buildDocx(win, bodyXml, docOpts);
  const res = await win.docx2readme.convertDocument(buf, over.__name || 'doc.docx', opts);
  const page = res.files.find((f) => f.text !== undefined);
  return { md: page.text, body: page.text.replace(/^---[\s\S]*?---\n+/, ''), res };
}

test('headings remap to h2.. and keep their order', async () => {
  const { body } = await convert(
    heading(1, 'Overview') + para('a') + heading(2, 'Details') + para('b') +
    heading(3, 'Deep') + para('c'));
  assert.match(body, /^## Overview$/m);
  assert.match(body, /^### Details$/m);
  // maxLevel defaults to 3, so h3 collapses onto h3 rather than becoming h4.
  assert.match(body, /^### Deep$/m);
});

test('bold split across runs is coalesced, not double-marked', async () => {
  const { body } = await convert(
    heading(1, 'T') + para([run('Ini', { bold: true }), run('ciación', { bold: true })]));
  assert.match(body, /\*\*Iniciación\*\*/);
  assert.doesNotMatch(body, /\*\*\*\*/);
});

test('hidden (vanish) runs are dropped', async () => {
  const { body } = await convert(heading(1, 'T') + para([run('keep '), run('SECRET', { vanish: true })]));
  assert.doesNotMatch(body, /SECRET/);
});

test('monospace paragraphs become one fenced block with a language', async () => {
  const { body } = await convert(
    heading(1, 'T') +
    para('curl -X POST https://api.example.com \\', { font: 'Consolas' }) +
    para('  -H "Content-Type: application/json"', { font: 'Consolas' }));
  assert.match(body, /```bash\n/);
  assert.equal((body.match(/```/g) || []).length, 2, 'should be a single fence pair');
});

test('curly quotes inside code are repaired', async () => {
  const { body, res } = await convert(
    heading(1, 'T') + para('curl -H “Authorization: Bearer x”', { font: 'Courier New' }));
  assert.match(body, /-H "Authorization: Bearer x"/);
  assert.ok(res.report.autocorrectFixes >= 2);
});

test('a code fence is widened when the code itself contains backticks', async () => {
  const { body } = await convert(
    heading(1, 'T') + para('```json', { font: 'Consolas' }) + para('{}', { font: 'Consolas' }) +
    para('```', { font: 'Consolas' }));
  const opener = body.match(/^(`{3,})/m);
  assert.ok(opener && opener[1].length >= 4,
    'fence must be longer than the backtick run inside it, got: ' + JSON.stringify(body));
});

test('bulleted and numbered lists keep their nesting', async () => {
  const { body } = await convert(
    heading(1, 'T') +
    para('one', { numId: 2, ilvl: 0 }) +
    para('one-a', { numId: 2, ilvl: 1 }) +
    para('bullet', { numId: 1, ilvl: 0 }));
  const lines = body.split('\n');
  const nested = lines.find((l) => l.includes('one-a'));
  // "1. one" puts its content at column 3, so a child needs at least 3 spaces
  // or CommonMark reads it as a sibling and the nesting is lost.
  assert.ok(/^ {3,}/.test(nested), 'nested ordered item under-indented: ' + JSON.stringify(nested));
});

test('tables render with a header row and expanded merged cells', async () => {
  const { body } = await convert(
    heading(1, 'T') + table([[['Campo', 2], 'Tipo'], ['id', 'x', 'string']]));
  assert.match(body, /\| Campo \| {3}\| Tipo \|/);
  assert.match(body, /\| --- \| --- \| --- \|/);
});

test('a table header cell with several bold phrases is not mangled', async () => {
  const { body } = await convert(heading(1, 'T') + table([
    [[[run('a', { bold: true }), run(' and '), run('b', { bold: true })]]], ['x']]));
  assert.doesNotMatch(body, /\| a\*\* and \*\*b \|/);
});

test('table cell pipes are escaped', async () => {
  const { body } = await convert(heading(1, 'T') + table([['a|b', 'c'], ['d', 'e']]));
  assert.match(body, /a\\\|b/);
});

test('the cover page before the first heading is dropped', async () => {
  const { body, res } = await convert(
    para('Confidential — internal only') + para('v1.4') + heading(1, 'Real Title') + para('body'));
  assert.doesNotMatch(body, /Confidential/);
  assert.ok(res.report.coverLines);
});

test('revision history and table of contents sections are dropped whole', async () => {
  const { body } = await convert(
    heading(1, 'Intro') + para('keep me') +
    heading(1, 'Revision History') + para('1.0 first draft') +
    heading(1, 'Next') + para('also keep'));
  assert.doesNotMatch(body, /first draft/);
  assert.match(body, /keep me/);
  assert.match(body, /also keep/);
});

test('boilerplate headings are demoted to bold text', async () => {
  const { body } = await convert(
    heading(1, 'Endpoint') + heading(2, 'Example request') + para('x'));
  assert.doesNotMatch(body, /^#+ Example request/m);
  assert.match(body, /^\*\*Example request\*\*$/m);
});

test('a demoted heading is escaped before it reaches MDX', async () => {
  const opts = win.docx2readme.defaultOptions();
  opts.labels.add(win.docx2readme.normKey('Send <token>'));
  const { body } = await convert(heading(1, 'Endpoint') + heading(2, 'Send <token>') + para('x'), opts);
  assert.doesNotMatch(body, /\*\*Send <token>\*\*/, 'demoted heading text reaches MDX unescaped');
});

test('a heading with an angle bracket or brace cannot break the MDX build', async () => {
  const { body } = await convert(heading(1, 'Call GET /users/<id>') + para('x') +
    heading(2, 'Payload {id}') + para('y'));
  assert.doesNotMatch(body, /^#+ .*[^\\]<id>/m);
  assert.doesNotMatch(body, /^#+ .*[^\\]\{id\}/m);
});

test('a note paragraph becomes a ReadMe Callout component', async () => {
  const { body } = await convert(heading(1, 'T') + para('Nota: guarde el token.'));
  assert.match(body, /<Callout icon="📘" theme="info">/);
  assert.match(body, /guarde el token\./);
});

test('callout style can be a blockquote instead', async () => {
  const { body } = await convert(heading(1, 'T') + para('⚠️ Cuidado con esto'),
    { calloutStyle: 'blockquote' });
  assert.match(body, /^> 🚧 Cuidado con esto$/m);
});

test('hyperlinks keep their target and escape their text', async () => {
  const { body } = await convert(
    heading(1, 'T') +
    `<w:p><w:hyperlink r:id="rId9"><w:r><w:t>API docs</w:t></w:r></w:hyperlink></w:p>`,
    {}, { rels: { rId9: 'https://example.com/a(b) c' } });
  assert.match(body, /\[API docs\]\(/);
  assert.doesNotMatch(body, /\]\(https:\/\/example\.com\/a\(b\) c\)/,
    'unencoded parens/spaces break the link target');
});

test('images are extracted and referenced relatively', async () => {
  const drawing =
    `<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId5"/>` +
    `</w:drawing></w:r></w:p>`;
  const opts = Object.assign(win.docx2readme.defaultOptions(), {});
  const buf = await buildDocx(win, heading(1, 'T') + drawing, {
    rels: { rId5: 'media/image1.png' },
    extraFiles: { 'word/media/image1.png': '\x89PNG-fake' },
  });
  const res = await win.docx2readme.convertDocument(buf, 'guide.docx', opts);
  const page = res.files.find((f) => f.text !== undefined);
  assert.match(page.text, /!\[\]\(images\/guide-01\.png\)/);
  assert.ok(res.files.some((f) => f.path === 'images/guide-01.png'));
});

test('the document title comes from docProps when present', async () => {
  const { md } = await convert(heading(1, 'T') + para('x'), {}, { coreTitle: 'Open Finance API' });
  assert.match(md, /title: "Open Finance API"/);
});

test('splitting produces one file per top-level heading plus an _order.yaml', async () => {
  const opts = Object.assign(win.docx2readme.defaultOptions(), { split: 1 });
  const buf = await buildDocx(win,
    heading(1, 'Alpha') + para('a') + heading(1, 'Beta') + para('b'));
  const res = await win.docx2readme.convertDocument(buf, 'doc.docx', opts);
  const paths = res.files.map((f) => f.path);
  // The filename is the slug in a synced repo, so it must not carry the
  // ordering prefix — _order.yaml is what carries the order, and its entries
  // have to match the filenames exactly.
  assert.deepEqual(paths, ['alpha.md', 'beta.md', '_order.yaml']);
  const order = res.files.find((f) => f.path === '_order.yaml').text;
  assert.equal(order, '- alpha\n- beta\n');
});

test('two sections with the same title get distinct filenames', async () => {
  const opts = Object.assign(win.docx2readme.defaultOptions(), { split: 1 });
  const buf = await buildDocx(win,
    heading(1, 'Errors') + para('a') + heading(1, 'Errors') + para('b'));
  const res = await win.docx2readme.convertDocument(buf, 'doc.docx', opts);
  const pages = res.files.filter((f) => /\.md$/.test(f.path)).map((f) => f.path);
  assert.equal(new Set(pages).size, 2, 'one section overwrote the other: ' + pages);
});

test('an old .doc is rejected with an actionable message', async () => {
  // The real OLE2 compound-file signature a .doc starts with.
  const ole = new Uint8Array(600);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  const buf = ole.buffer;
  await assert.rejects(
    () => win.docx2readme.convertDocument(buf, 'old.doc', win.docx2readme.defaultOptions()),
    /Save As|not a zip/i);
});

test('a bolded label still reads as a callout', async () => {
  const { body } = await convert(heading(1, 'T') + para([
    run('Importante:', { bold: true }), run(' revise el certificado.')]));
  assert.match(body, /<Callout icon="🚧" theme="warn">/);
  assert.match(body, /revise el certificado\./);
  assert.doesNotMatch(body, /\*\*Importante/);
});

test('a brace in a URL is percent-encoded, not backslash-escaped', async () => {
  const { body } = await convert(heading(1, 'T') +
    para('Call https://api.test/v1/{userId}/orders to list them.'));
  assert.match(body, /https:\/\/api\.test\/v1\/%7BuserId%7D\/orders/);
  assert.doesNotMatch(body, /\\\{userId/);
});
