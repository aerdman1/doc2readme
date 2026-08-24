/* table-wizard.test.js — parsing and rendering, not the drag UI.
 *
 * The interactive parts (resize, drag-to-reorder, the format toolbar) are
 * plain DOM event handlers with no branching logic worth a jsdom test; what
 * needs coverage is the four parsers and three renderers, since those are
 * where a real table's content could get silently mangled or lost.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeWindow } = require('./harness');

let win, tw;
test.before(() => { win = makeWindow(); tw = win.tableWizard; });

/* --------------------------------------------------------------- detect */

test('detects a Markdown pipe table', () => {
  const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
  assert.equal(tw.detectFormat(md), 'markdown');
});

test('detects an HTML table over a ReadMe <Table>', () => {
  assert.equal(tw.detectFormat('<table><tr><td>x</td></tr></table>'), 'html');
  assert.equal(tw.detectFormat('<Table><tbody><tr><td>x</td></tr></tbody></Table>'), 'jsx');
});

test('detects a legacy magic block', () => {
  assert.equal(tw.detectFormat('[block:parameters]\n{}\n[/block]'), 'magic');
});

test('does not misdetect prose that merely contains a pipe', () => {
  assert.equal(tw.detectFormat('cost is $5 | maybe $6, who knows'), null);
});

/* ---------------------------------------------------------- markdown in */

test('parses a Markdown table with alignment', () => {
  const md = '| Name | Count |\n| :--- | ----: |\n| a | 1 |\n| b | 2 |';
  const model = tw.parseMarkdown(md);
  assert.equal(model.cols.length, 2);
  assert.equal(model.cols[0].align, 'left');
  assert.equal(model.cols[1].align, 'right');
  assert.equal(model.rows.length, 3); // header + 2
  assert.equal(model.rows[0][0], 'Name');
  assert.equal(model.rows[1][1], '1');
});

test('parses inline formatting and a link inside a Markdown cell', () => {
  const md = '| A |\n| --- |\n| **bold** and [a link](https://x.test) and `code` |';
  const model = tw.parseMarkdown(md);
  assert.match(model.rows[1][0], /<strong>bold<\/strong>/);
  assert.match(model.rows[1][0], /<a href="https:\/\/x\.test">a link<\/a>/);
  assert.match(model.rows[1][0], /<code>code<\/code>/);
});

test('unescapes a literal pipe inside a cell', () => {
  const md = '| A |\n| --- |\n| a \\| b |';
  const model = tw.parseMarkdown(md);
  assert.equal(model.rows[1][0], 'a | b');
});

test('rejects prose that is not actually a table', () => {
  assert.equal(tw.parseMarkdown('just some text\nwith no pipes at all'), null);
});

/* -------------------------------------------------------------- html in */

test('parses an HTML table, reading width and alignment off the first row', () => {
  const html = '<table><tr>' +
    '<th style="text-align:center;width:80px">A</th>' +
    '<th style="text-align:right">B</th></tr>' +
    '<tr><td>1</td><td>2</td></tr></table>';
  const model = tw.parseHtml(html);
  assert.equal(model.cols[0].align, 'center');
  assert.equal(model.cols[0].width, 80);
  assert.equal(model.cols[1].align, 'right');
  assert.equal(model.rows[0][0], 'A');
});

test('unwraps a span/div/class soup in an HTML cell but keeps the text', () => {
  const html = '<table><tr><td><span class="x"><div>hello <b>world</b></div></span></td></tr></table>';
  const model = tw.parseHtml(html);
  assert.equal(model.rows[0][0], 'hello <strong>world</strong>');
});

test('returns null for HTML with no table', () => {
  assert.equal(tw.parseHtml('<p>no table here</p>'), null);
});

/* --------------------------------------------------------------- jsx in */

test('parses a ReadMe <Table> with an align prop', () => {
  const jsx = '<Table align={["left", "right"]}>\n' +
    '  <thead>\n    <tr>\n      <th>\n        A\n      </th>\n      <th>\n        B\n      </th>\n    </tr>\n  </thead>\n\n' +
    '  <tbody>\n    <tr>\n      <td>\n        **1**\n      </td>\n      <td>\n        2\n      </td>\n    </tr>\n  </tbody>\n</Table>';
  const model = tw.parseJsx(jsx);
  assert.equal(model.cols[0].align, 'left');
  assert.equal(model.cols[1].align, 'right');
  assert.equal(model.rows[0][0], 'A');
  assert.match(model.rows[1][0], /<strong>1<\/strong>/);
});

/* ------------------------------------------------------------- magic in */

test('migrates a legacy [block:parameters] table', () => {
  const block = '[block:parameters]\n' + JSON.stringify({
    data: { 'h-0': '**Name**', 'h-1': '**Count**', '0-0': 'a', '0-1': '1' },
    cols: 2, rows: 1, align: ['left', 'right'],
  }) + '\n[/block]';
  const model = tw.parseMagicBlock(block);
  assert.equal(model.cols[1].align, 'right');
  assert.equal(model.rows[0][0], 'Name'); // legacy **bold** header not double-bolded
  assert.equal(model.rows[1][0], 'a');
});

test('returns null for a magic block with no parseable JSON', () => {
  assert.equal(tw.parseMagicBlock('[block:parameters]\nnot json\n[/block]'), null);
});

/* -------------------------------------------------------------- output */

function threeCol() {
  return tw.normalizeWidth({
    header: true,
    cols: [tw.makeCol('left', null), tw.makeCol('center', 120), tw.makeCol('right', null)],
    rows: [['A', 'B', 'C'], ['1', '<strong>2</strong>', '<a href="https://x.test">3</a>']],
  });
}

test('renders Markdown with GFM alignment colons and no width', () => {
  const out = tw.renderMarkdown(threeCol());
  const lines = out.split('\n');
  assert.match(lines[0], /^\| A \| B \| C \|$/);
  assert.match(lines[1], /^\| --- \| :---: \| ---: \|$/);
  assert.doesNotMatch(out, /120/);
  assert.match(lines[2], /\*\*2\*\*/);
  assert.match(lines[2], /\[3\]\(https:\/\/x\.test\)/);
});

test('renders a ReadMe <Table> with an align prop and inline width style', () => {
  const out = tw.renderJsx(threeCol());
  assert.match(out, /^<Table align={\["left", "center", "right"\]}>$/m);
  assert.match(out, /width: "120px"/);
  assert.match(out, /<th /);
  assert.match(out, /<td /);
});

test('renders a Custom HTML block with real CSS width and alignment', () => {
  const out = tw.renderHtmlBlock(threeCol());
  assert.match(out, /<table /);
  assert.match(out, /width:120px/);
  assert.match(out, /text-align:right/);
  assert.match(out, /<strong>2<\/strong>/);
});

test('escapes a stray angle-bracket placeholder so MDX output still builds', () => {
  // Cells hold sanitized HTML, not raw text — inlineMdToHtml is what every
  // real parser runs input through, so a literal "<" arrives HTML-escaped,
  // exactly as it would from parseMarkdown/parseHtml/parseJsx.
  const model = tw.normalizeWidth({
    header: true,
    cols: [tw.makeCol()],
    rows: [['H'], [tw.inlineMdToHtml('<YOUR_TOKEN>')]],
  });
  const md = tw.renderMarkdown(model);
  const jsx = tw.renderJsx(model);
  assert.match(md, /\\<YOUR_TOKEN\\>/);
  assert.match(jsx, /\\<YOUR_TOKEN\\>/);
  // The Custom HTML block is never MDX-parsed, so no backslash-escaping there.
  const html = tw.renderHtmlBlock(model);
  assert.match(html, /&lt;YOUR_TOKEN&gt;/);
  assert.doesNotMatch(html, /\\</);
});

/* --------------------------------------------------------------- round trip */

test('a plain Markdown table round-trips through the model unchanged in shape', () => {
  const md = '| Name | Role |\n| --- | :---: |\n| Ada | Engineer |\n| Grace | Admiral |';
  const model = tw.parseMarkdown(md);
  const out = tw.renderMarkdown(model);
  const model2 = tw.parseMarkdown(out);
  assert.deepEqual(model2.cols.map((c) => c.align), model.cols.map((c) => c.align));
  assert.deepEqual(model2.rows, model.rows);
});
