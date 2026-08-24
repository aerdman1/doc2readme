'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeWindow, enc } = require('./harness');

let win;
test.before(() => { win = makeWindow(); });

async function clean(md, over = {}) {
  const opts = Object.assign(win.docx2readme.defaultOptions(), { forceMarkdown: true }, over);
  const res = await win.docx2readme.convertDocument(enc(md), 'doc.md', opts);
  const page = res.files.find((f) => f.text !== undefined);
  return { md: page.text, body: page.text.replace(/^---[\s\S]*?---\n+/, ''), res };
}

test('a stray placeholder tag is escaped', async () => {
  const { body, res } = await clean('# T\n\nPass <YOUR_API_KEY> in the header.\n');
  assert.match(body, /\\<YOUR_API_KEY\\>/);
  assert.equal(res.report.mdEscapedTags, 1);
});

test('a placeholder inside a code span is left alone', async () => {
  const { body } = await clean('# T\n\nUse `<YOUR_API_KEY>` here.\n');
  assert.match(body, /`<YOUR_API_KEY>`/);
  assert.doesNotMatch(body, /\\</);
});

test('real components and closed HTML survive', async () => {
  const { body } = await clean('# T\n\n<Callout icon="📘" theme="info">\nHi\n</Callout>\n');
  assert.match(body, /<Callout icon="📘"/);
});

test('a void tag is self-closed for MDX', async () => {
  const { body } = await clean('# T\n\nline one<br>line two\n');
  assert.match(body, /<br \/>/);
});

test('an autolink is not mistaken for a JSX tag', async () => {
  const { body } = await clean('# T\n\nSee <https://example.com/docs> for more.\n');
  assert.match(body, /<https:\/\/example\.com\/docs>|\[https:\/\/example\.com\/docs\]/,
    'autolink was escaped into literal text: ' + JSON.stringify(body));
});

test('an HTML comment is removed or converted — MDX cannot parse one', async () => {
  const { body } = await clean('# T\n\n<!-- internal note -->\n\nVisible text.\n');
  assert.doesNotMatch(body, /<!--/, 'MDX fails to compile an HTML comment');
});

test('a bare curly brace is escaped so MDX does not read it as an expression', async () => {
  const { body } = await clean('# T\n\nSend {"id": 1} as the body.\n');
  assert.doesNotMatch(body, /[^\\]\{"id"/, 'unescaped { is a JSX expression to MDX');
});

test('a deliberate JSX attribute expression is left intact', async () => {
  const { body } = await clean('# T\n\n<Cards columns={2}>\ntext\n</Cards>\n');
  assert.match(body, /columns=\{2\}/);
});

test('fenced code keeps its language and contents verbatim', async () => {
  const { body } = await clean('# T\n\n```json\n{"a": "<b>"}\n```\n');
  assert.match(body, /```json\n\{"a": "<b>"\}\n```/);
});

test('a fence containing a nested fence is re-emitted with a longer fence', async () => {
  const { body } = await clean('# T\n\n````markdown\n```js\nx\n```\n````\n');
  const first = body.match(/^(`{3,})/m);
  assert.ok(first && first[1].length >= 4, 'nested fence broke out: ' + JSON.stringify(body));
});

test('existing frontmatter is kept, and the declared slug names the file', async () => {
  const src = '---\ntitle: Real Title\nslug: real-slug\nexcerpt: A summary\nicon: "fa-book"\n' +
    'metadata:\n  title: SEO Title\n  description: For search\n  keywords:\n    - api\n---\n\n# T\n\nx\n';
  const opts = Object.assign(win.docx2readme.defaultOptions(), { forceMarkdown: true });
  const res = await win.docx2readme.convertDocument(enc(src), 'doc.md', opts);
  const page = res.files.find((f) => f.text !== undefined);
  // In a synced repo the filename is the slug; a declared slug must survive or
  // every inbound link to the published page breaks.
  assert.equal(page.path, 'real-slug.md');
  assert.match(page.text, /title: "Real Title"/);
  assert.match(page.text, /excerpt: A summary/, 'excerpt was dropped');
  assert.match(page.text, /icon: "fa-book"/);
  assert.match(page.text, /metadata:\n {2}title: SEO Title\n {2}description: For search/,
    'the nested metadata block was flattened or lost');
  assert.doesNotMatch(page.text, /^slug:/m, 'slug is the filename, not a frontmatter field');
});

test('tables round-trip', async () => {
  const { body } = await clean('# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  assert.match(body, /\| a \| b \|/);
  assert.match(body, /\| 1 \| 2 \|/);
});

test('nested list indentation survives', async () => {
  const { body } = await clean('# T\n\n1. one\n    1. one-a\n2. two\n');
  const nested = body.split('\n').find((l) => l.includes('one-a'));
  assert.ok(/^ {3,}/.test(nested), 'nesting lost: ' + JSON.stringify(nested));
});

test('a wrapped list item stays part of its item', async () => {
  const { body } = await clean('# T\n\n- first line\n  continued here\n- second\n');
  assert.match(body, /- first line continued here|- first line\n {2,}continued here/,
    'continuation became a separate paragraph: ' + JSON.stringify(body));
});

test('blockquote emoji callouts normalise to the component form', async () => {
  const { body } = await clean('# T\n\n> 📘 Remember this\n');
  assert.match(body, /<Callout icon="📘" theme="info">/);
});

test('an empty markdown file fails with a clear message', async () => {
  await assert.rejects(() => clean('   \n\n'), /no content/i);
});
