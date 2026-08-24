/* mdx.test.js — the cross-cutting guarantee.
 *
 * ReadMe compiles every page as MDX. A single unescaped `<` or `{` in body
 * text is not a cosmetic problem: the page fails to build and shows an error
 * instead of content. This suite pushes the same hostile text through all four
 * input formats and asserts the output cannot do that, so a fix to one reader
 * is not quietly missing from the other three.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeWindow, buildDocx, enc, heading, para, table } = require('./harness');

let win;
test.before(() => { win = makeWindow(); });

/**
 * Everything MDX chokes on, outside code fences and code spans:
 *   <Something>       an unclosed JSX element
 *   {expression}      a JS expression, usually an undefined identifier
 *   <!-- comment -->  not valid MDX at all
 */
function mdxHazards(markdown) {
  const body = String(markdown).replace(/^---[\s\S]*?\n---\n/, '');
  const hazards = [];
  // Strip fenced code, then code spans — both are opaque to MDX.
  let scan = body.replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1?\2\s*$/gm, '');
  scan = scan.replace(/(`+)[^`\n]*\1/g, '');
  for (const m of scan.matchAll(/(^|[^\\])<!--/g)) hazards.push('html comment: ' + m[0]);
  for (const m of scan.matchAll(/(^|[^\\])\{/g)) {
    // A JSX attribute expression inside a real tag is legitimate.
    const before = scan.slice(Math.max(0, m.index - 80), m.index);
    if (/<[A-Za-z][^<>]*$/.test(before)) continue;
    hazards.push('bare { at ' + JSON.stringify(scan.slice(m.index, m.index + 24)));
  }
  for (const m of scan.matchAll(/(^|[^\\`])<\/?([A-Za-z][A-Za-z0-9._-]*)([^<>]*)>/g)) {
    const name = m[2];
    if (win.mdClean.isKnownTag(name)) continue;
    hazards.push('unescaped tag <' + name + '>');
  }
  return hazards;
}

const HOSTILE_SENTENCE =
  'Send code=<authorization_code> with {"grant_type":"client_credentials"} ' +
  'and a <YOUR_API_KEY> header — see 5 < 6 > 4 for the range.';

test('the hazard detector itself is not asleep', () => {
  assert.ok(mdxHazards('Pass <YOUR_TOKEN> now').length > 0);
  assert.ok(mdxHazards('Send {"a":1}').length > 0);
  assert.equal(mdxHazards('Pass `<YOUR_TOKEN>` now').length, 0);
  assert.equal(mdxHazards('```\n<YOUR_TOKEN> {a}\n```\n').length, 0);
});

test('Word output is MDX-safe', async () => {
  const buf = await buildDocx(win,
    heading(1, 'Auth <v2> {beta}') +
    para(HOSTILE_SENTENCE) +
    para('Nota: use <Bearer {token}> in the header.') +
    table([['Campo <x>', 'Ejemplo {y}'], ['code', '<authorization_code>']]));
  const res = await win.docx2readme.convertDocument(buf, 'auth.docx', win.docx2readme.defaultOptions());
  const md = res.files.find((f) => f.text !== undefined).text;
  assert.deepEqual(mdxHazards(md), [], md);
});

test('Markdown output is MDX-safe', async () => {
  const src = '# Auth <v2> {beta}\n\n' + HOSTILE_SENTENCE + '\n\n' +
    '<!-- a comment MDX cannot parse -->\n\n' +
    '| Campo <x> | Ejemplo {y} |\n| --- | --- |\n| code | <authorization_code> |\n\n' +
    '- item with <Placeholder> and {braces}\n\n' +
    '```js\nconst x = {a: "<b>"};\n```\n';
  const opts = Object.assign(win.docx2readme.defaultOptions(), { forceMarkdown: true });
  const res = await win.docx2readme.convertDocument(enc(src), 'auth.md', opts);
  const md = res.files.find((f) => f.text !== undefined).text;
  assert.deepEqual(mdxHazards(md), [], md);
});

test('HTML output is MDX-safe', async () => {
  const html = '<!doctype html><html><head><title>T</title></head><body><main>' +
    '<h1>Auth &lt;v2&gt; {beta}</h1>' +
    '<p>' + HOSTILE_SENTENCE.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' +
    '<table><tr><th>Campo &lt;x&gt;</th><th>Ejemplo {y}</th></tr>' +
    '<tr><td>code</td><td>&lt;authorization_code&gt;</td></tr></table>' +
    '<p>' + 'Filler sentence to make this the main region. '.repeat(8) + '</p>' +
    '</main></body></html>';
  const res = await win.docx2readme.convertDocument(enc(html), 'auth.html', win.docx2readme.defaultOptions());
  const md = res.files.find((f) => f.text !== undefined).text;
  assert.deepEqual(mdxHazards(md), [], md);
});

test('markdown already containing ReadMe components stays valid and intact', async () => {
  const src = '# T\n\n<Callout icon="📘" theme="info">\nRead this.\n</Callout>\n\n' +
    '<Cards columns={2}>\n<Card title="A">a</Card>\n</Cards>\n\n' +
    'Inline <br> break and an image <img src="https://x.test/a.png" alt="a">\n';
  const opts = Object.assign(win.docx2readme.defaultOptions(), { forceMarkdown: true });
  const res = await win.docx2readme.convertDocument(enc(src), 'c.md', opts);
  const md = res.files.find((f) => f.text !== undefined).text;
  assert.match(md, /<Callout icon="📘" theme="info">/);
  assert.match(md, /columns=\{2\}/);
  assert.match(md, /<br \/>/);
  assert.deepEqual(mdxHazards(md).filter((h) => !/Cards|Card/.test(h)), [], md);
});

test('every emitted page starts with parseable frontmatter', async () => {
  const buf = await buildDocx(win, heading(1, 'A "quoted" — title') + para('x'));
  const res = await win.docx2readme.convertDocument(buf, 'a.docx', win.docx2readme.defaultOptions());
  const md = res.files.find((f) => f.text !== undefined).text;
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'no frontmatter');
  for (const line of fm[1].split('\n')) {
    assert.match(line, /^[a-z][\w-]*: (".*"|true|false)$/, 'unparseable frontmatter line: ' + line);
  }
});
