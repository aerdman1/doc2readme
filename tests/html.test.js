'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeWindow, enc } = require('./harness');

let win;
test.before(() => { win = makeWindow(); });

async function conv(html, over = {}) {
  const opts = Object.assign(win.docx2readme.defaultOptions(), over);
  const res = await win.docx2readme.convertDocument(enc(html), 'page.html', opts);
  const page = res.files.find((f) => f.text !== undefined);
  return { md: page.text, body: page.text.replace(/^---[\s\S]*?---\n+/, ''), res };
}

const page = (body, head) =>
  `<!doctype html><html><head><title>Doc Title</title>${head || ''}</head><body>${body}</body></html>`;

test('navigation and footers are dropped, main content kept', async () => {
  const { body, res } = await conv(page(`
    <nav><a href="/x">Home</a></nav>
    <main><h1>Guide</h1><p>Real content that is long enough to be picked as the root of the page.</p></main>
    <footer>© 2025</footer>`));
  assert.doesNotMatch(body, /Home|© 2025/);
  assert.match(body, /Real content/);
  assert.equal(res.report.htmlTitle, 'Doc Title');
});

test('a content wrapper named like chrome is not thrown away', async () => {
  // Confluence, Zendesk and most static-site builders wrap the page title in
  // a "…-header" element. Name-matching alone deletes the H1.
  const { body } = await conv(page(
    `<main><div class="article-header"><h1>The Only Heading</h1></div>` +
    `<p>${'Body sentence. '.repeat(20)}</p></main>`));
  assert.match(body, /The Only Heading/, 'the page heading was dropped as chrome');
});

test('a sidebar full of links is still dropped', async () => {
  const { body, res } = await conv(page(
    `<main><div class="sidebar"><h2>In this section</h2><ul>` +
    `<li><a href="/a">A</a></li><li><a href="/b">B</a></li><li><a href="/c">C</a></li></ul></div>` +
    `<h1>Real</h1><p>${'Body sentence. '.repeat(20)}</p></main>`));
  assert.doesNotMatch(body, /In this section/);
  assert.ok(res.report.htmlChromeDropped >= 1);
});

test('Word MsoHeading paragraphs become real headings', async () => {
  const { body, res } = await conv(page(`
    <p class=MsoHeading1>Introducción</p>
    <p class=MsoNormal>${'Texto del documento. '.repeat(15)}</p>
    <p class=MsoToc1>1. Introducción<span>3</span></p>`));
  assert.match(body, /^## Introducción$/m);
  assert.ok(res.report.htmlWordHeadings >= 1);
  assert.doesNotMatch(body, /^.*MsoToc/m);
});

test('Word pseudo-list paragraphs become list items', async () => {
  const { body } = await conv(page(`
    <h1>T</h1>
    <p class=MsoListParagraph>· First item</p>
    <p class=MsoListParagraph>· Second item</p>
    <p>${'Filler. '.repeat(30)}</p>`));
  assert.match(body, /^- First item$/m);
  assert.match(body, /^- Second item$/m);
});

test('pre keeps its language class', async () => {
  const { body } = await conv(page(
    `<main><h1>T</h1><pre class="language-bash">curl https://x.test</pre>` +
    `<p>${'Filler text. '.repeat(20)}</p></main>`));
  assert.match(body, /```bash\ncurl https:\/\/x\.test\n```/);
});

test('a code block inside a list item is not flattened into the sentence', async () => {
  const { body } = await conv(page(
    `<main><h1>T</h1><ul><li>Run this:<pre>npm install</pre></li></ul>` +
    `<p>${'Filler text. '.repeat(20)}</p></main>`));
  assert.match(body, /```\nnpm install\n```/, 'the <pre> was inlined: ' + JSON.stringify(body));
});

test('a top-level image is not lost', async () => {
  const { body } = await conv(page(
    `<main><h1>T</h1><img src="https://cdn.test/a.png" alt="Diagram">` +
    `<p>${'Filler text. '.repeat(20)}</p></main>`));
  assert.match(body, /!\[Diagram\]\(https:\/\/cdn\.test\/a\.png\)/);
});

test('tables convert with colspan expanded', async () => {
  const { body } = await conv(page(
    `<main><h1>T</h1><table><tr><th colspan="2">Pair</th><th>Third</th></tr>` +
    `<tr><td>a</td><td>b</td><td>c</td></tr></table>` +
    `<p>${'Filler text. '.repeat(20)}</p></main>`));
  assert.match(body, /\| Pair \| {3}\| Third \|/);
  assert.match(body, /\| a \| b \| c \|/);
});

test('relative images are reported so they can be fixed', async () => {
  const { res } = await conv(page(
    `<main><h1>T</h1><img src="img/a.png"><p>${'Filler text. '.repeat(20)}</p></main>`));
  assert.equal(res.report.htmlRelativeImages, 1);
});

test('Word sidecar spacer images are skipped', async () => {
  const { res } = await conv(page(
    `<main><h1>T</h1><img src="Report_files/image001.gif"><p>${'Filler. '.repeat(30)}</p></main>`));
  assert.equal(res.report.htmlWordSidecar, 1);
  assert.ok(!res.report.htmlRelativeImages);
});

test('placeholders in HTML body text are escaped for MDX', async () => {
  const { body } = await conv(page(
    `<main><h1>T</h1><p>Authorization: Bearer &lt;YOUR_TOKEN&gt; and {"a":1}</p>` +
    `<p>${'Filler text. '.repeat(20)}</p></main>`));
  assert.match(body, /\\<YOUR_TOKEN\\>/);
  assert.doesNotMatch(body, /[^\\]\{"a"/, 'unescaped { is a JSX expression to MDX');
});

test('a link with parentheses in its href stays a working link', async () => {
  const { body } = await conv(page(
    `<main><h1>T</h1><p><a href="https://x.test/a(b)">link</a></p>` +
    `<p>${'Filler text. '.repeat(20)}</p></main>`));
  assert.doesNotMatch(body, /\]\(https:\/\/x\.test\/a\(b\)\)/, 'raw parens break the link');
});

test('an HTML file with no readable content fails clearly', async () => {
  await assert.rejects(() => conv(page('<nav>only chrome</nav>')), /no readable content/i);
});
