/* mdx-table.test.js — the table cleaner.
 *
 * The fixtures here are written to reproduce the *shapes* found in real
 * migrated ReadMe tables (a `<ul>` typed where `</ul>` was meant, a closer
 * truncated mid-name, `<br />` used as list spacing). None of them is anyone's
 * document: this repo is public.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeWindow, enc } = require('./harness');

let win;
test.before(() => { win = makeWindow(); });

const clean = (src) => win.mdxTable.cleanTable(src).text;

function table(cell) {
  return '<Table>\n  <thead>\n    <tr>\n      <th>\n        H\n      </th>\n    </tr>\n' +
         '  </thead>\n\n  <tbody>\n    <tr>\n      <td>\n' + cell + '\n      </td>\n' +
         '    </tr>\n  </tbody>\n</Table>';
}

// The bug that started this: escapeStrayTags sees one block at a time, so the
// opening <Table> looked unterminated and the whole table came out as text.
test('a <Table> is rebuilt, not escaped into literal text', async () => {
  const md = '# T\n\n' + table('        <ul><li>one</li><li>two</li></ul>') + '\n';
  const opts = Object.assign(win.docx2readme.defaultOptions(), { forceMarkdown: true });
  const res = await win.docx2readme.convertDocument(enc(md), 'doc.md', opts);
  const body = res.files.find((f) => f.text !== undefined).text;
  assert.doesNotMatch(body, /\\<Table\\>|\\<ul\\>/);
  assert.match(body, /^<Table>$/m);
  assert.match(body, /^ {8}- one$/m);
  assert.equal(res.report.mdxTables, 1);
});

test('an HTML list in a cell becomes a Markdown list', () => {
  const out = clean(table('        <ul><li>one</li><li>two</li></ul>'));
  assert.match(out, /^ {8}- one\n {8}- two$/m);
  assert.doesNotMatch(out, /<ul>|<li>/);
});

test('<br /> used as list spacing is dropped', () => {
  const out = clean(table('        <ul><li>one</li><br /><li>two</li><br /></ul>'));
  assert.match(out, /^ {8}- one\n {8}- two$/m);
  assert.doesNotMatch(out, /<br/);
});

test('<br /> between prose is a paragraph break', () => {
  const out = clean(table('        **A:**<br />**B:**'));
  assert.match(out, /^ {8}\*\*A:\*\*\n\n {8}\*\*B:\*\*$/m);
});

test('a <ul> typed where </ul> was meant closes the list instead of nesting', () => {
  const out = clean(table('        <ul><li>one</li><ul><br /><br />after'));
  assert.match(out, /^ {8}- one$/m);
  assert.match(out, /^ {8}after$/m);        // not indented under the list
});

test('a list opened directly inside a list nests under the previous item', () => {
  const out = clean(table(
    '        <ul><li>parent</li>\n        <ul><li>child</li></ul>\n        <li>sibling</li></ul>'));
  assert.match(out, /^ {8}- parent\n {10}- child\n {8}- sibling$/m);
});

test('a closer truncated mid-name still closes', () => {
  // `</li   <li>` and `</st` for `</strong>`, both seen in migrated tables.
  const out = clean(table('        <ul><li>one</li   <li><strong>two</st</ul>'));
  assert.match(out, /^ {8}- one\n {8}- \*\*two\*\*$/m);
});

test('prose after a blank line ends a list whose </ul> was lost', () => {
  const out = clean(table('        <ul><li>one</li></\n\n        After the list.'));
  assert.match(out, /^ {8}- one\n\n {8}After the list\.$/m);
});

test('a blank line between items keeps one list', () => {
  const out = clean(table('        <ul><li>one</li>\n\n        <li>two</li></ul>'));
  assert.match(out, /^ {8}- one\n {8}- two$/m);
});

test('a closing tag with no opener is read as the opener it was meant to be', () => {
  const out = clean(table('        <ul><li>Add </b>Name</b> here</li></ul>'));
  assert.match(out, /^ {8}- Add \*\*Name\*\* here$/m);
});

test('an orphan closing tag with no partner is dropped', () => {
  const out = clean(table('        <ul><li>one</b></li></ul>'));
  assert.match(out, /^ {8}- one$/m);
  assert.doesNotMatch(out, /\*\*/);
});

test('bold, italic, code and links survive as Markdown', () => {
  const out = clean(table(
    '        <ul><li><b>b</b> <i>i</i> <code>c</code> <a href="https://x.test">l</a></li></ul>'));
  assert.match(out, /- \*\*b\*\* \*i\* `c` \[l\]\(https:\/\/x\.test\)/);
});

test('a tag with no Markdown spelling is passed through, closed', () => {
  const out = clean(table('        <ul><li>x<sup>2</sup></li></ul>'));
  assert.match(out, /- x<sup>2<\/sup>/);
});

/* ---------------------------------------------------------------- ReadMe rules */

test('a table whose every cell is inline becomes a pipe table', () => {
  const out = clean('<Table>\n  <thead>\n    <tr>\n      <th>A</th>\n      <th>B</th>\n' +
                    '    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td>1</td>\n' +
                    '      <td>2</td>\n    </tr>\n  </tbody>\n</Table>');
  assert.match(out, /^\| A \| B \|$/m);
  assert.match(out, /^\| 1 \| 2 \|$/m);
  assert.doesNotMatch(out, /<Table>/);
});

test('a pipe in an inline cell is escaped', () => {
  const out = clean('<Table><thead><tr><th>A</th></tr></thead>' +
                    '<tbody><tr><td>a | b</td></tr></tbody></Table>');
  assert.match(out, /a \\\| b/);
});

test('one cell with block content keeps the whole table as JSX', () => {
  const out = clean('<Table>\n  <thead>\n    <tr>\n      <th>A</th>\n      <th>B</th>\n' +
                    '    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td>plain</td>\n' +
                    '      <td><ul><li>a</li></ul></td>\n    </tr>\n  </tbody>\n</Table>');
  assert.match(out, /^<Table>$/m);
  assert.match(out, /^ {8}plain$/m);
});

test('the emitted layout is ReadMe\'s: two-space steps, blank line between siblings', () => {
  const out = clean('<Table><thead><tr><th>A</th><th>B</th></tr></thead>' +
                    '<tbody><tr><td><ul><li>x</li></ul></td><td>b</td></tr></tbody></Table>');
  assert.match(out, /<Table>\n {2}<thead>\n {4}<tr>\n {6}<th>\n {8}A\n {6}<\/th>\n\n {6}<th>/);
  assert.match(out, /<\/thead>\n\n {2}<tbody>/);
  assert.ok(out.endsWith('</Table>'), 'ends with the closing tag');
});

test('align on <Table> and style on a cell are carried through', () => {
  const out = clean('<Table align={["left","right"]}><thead><tr>' +
                    '<th style={{ textAlign: "left" }}>A</th><th>B</th></tr></thead><tbody><tr>' +
                    '<td><ul><li>x</li></ul></td><td>b</td></tr></tbody></Table>');
  assert.match(out, /<Table align=\{\["left","right"\]\}>/);
  assert.match(out, /<th style=\{\{ textAlign: "left" \}\}>/);
});

test('colspan is given its React spelling so it reaches the DOM', () => {
  const out = clean('<Table><thead><tr><th colspan="2">A</th></tr></thead>' +
                    '<tbody><tr><td><ul><li>x</li></ul></td></tr></tbody></Table>');
  assert.match(out, /<th colSpan=\{2\}>/);
});

/* ------------------------------------------------------------- MDX hazards */

test('a code span containing angle brackets is left exactly as written', () => {
  const out = clean(table('        <ul><li>Send `<YOUR_TOKEN>` in the header</li></ul>'));
  assert.match(out, /- Send `<YOUR_TOKEN>` in the header/);
  assert.doesNotMatch(out, /\\</);
});

test('a placeholder tag in cell prose is escaped, since the table skips md-clean', () => {
  const out = clean(table('        <ul><li>Send <YOUR_TOKEN> in the header</li></ul>'));
  assert.match(out, /\\<YOUR_TOKEN\\>/);
});

test('braces in a cell are escaped — MDX would read them as an expression', () => {
  const out = clean(table('        <ul><li>pass {token} here</li></ul>'));
  assert.match(out, /\\\{token\\\}/);
});

test('a code fence in a cell keeps its lines and keeps the table as JSX', () => {
  const out = clean(table('        ```js\n        const x = 1;\n        ```'));
  assert.match(out, /^ {8}```js\n {8}const x = 1;\n {8}```$/m);
  assert.match(out, /^<Table>$/m);
});

/* ------------------------------------------------------------------- shape */

test('cleaning is idempotent — a clean table is left alone', () => {
  const once = clean(table('        <ul><li>one</li><br /><li>two</li></ul>'));
  const twice = win.mdxTable.cleanTable(once).text;
  assert.equal(twice, once);
});

test('an unterminated <Table> is left untouched rather than guessed at', () => {
  const src = '<Table>\n  <tbody>\n    <tr>\n      <td>x</td>\n';
  assert.equal(win.mdxTable.cleanMdxTables(src, {}).text, src);
});

test('two tables in one document are both rebuilt', () => {
  const doc = table('        <ul><li>a</li></ul>') + '\n\ntext\n\n' +
              table('        <ul><li>b</li></ul>');
  const res = win.mdxTable.cleanMdxTables(doc, {});
  assert.equal(res.stats.tables, 2);
  assert.match(res.text, /^ {8}- a$/m);
  assert.match(res.text, /^ {8}- b$/m);
  assert.match(res.text, /^text$/m);
});

test('list closers orphaned after a table are dropped, not left to fail the build', async () => {
  const md = '# T\n\n' + table('        <ul><li>a</li></ul>') + '\n\n</li></ul>\n';
  const opts = Object.assign(win.docx2readme.defaultOptions(), { forceMarkdown: true });
  const res = await win.docx2readme.convertDocument(enc(md), 'doc.md', opts);
  const body = res.files.find((f) => f.text !== undefined).text;
  assert.doesNotMatch(body, /<\/li>|<\/ul>/);
  assert.equal(res.report.mdOrphanClosers, 1);
});

test('a Markdown pipe table still goes down the pipe-table path', async () => {
  const md = '# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  const opts = Object.assign(win.docx2readme.defaultOptions(), { forceMarkdown: true });
  const res = await win.docx2readme.convertDocument(enc(md), 'doc.md', opts);
  const body = res.files.find((f) => f.text !== undefined).text;
  assert.match(body, /^\| A \| B \|$/m);
  assert.equal(res.report.mdTables, 1);
});
