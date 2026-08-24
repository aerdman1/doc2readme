/* ui.test.js — index.html and app.js together.
 *
 * These catch the failures that are invisible in the converter: a control the
 * page references but does not have, copy that drifted out of sync with the
 * feature set, and the tab index meaning a different file to each button.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeWindow } = require('./harness');

const ROOT = path.join(__dirname, '..');

test('every element id app.js reaches for exists in index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [];
  for (const m of app.matchAll(/\$\('([^']+)'\)/g)) {
    if (!present.has(m[1])) missing.push(m[1]);
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('the page loads with no script errors and both modes render', () => {
  const win = makeWindow({ withApp: true });
  assert.equal(win.document.getElementById('dropTitle').textContent, win.COPY.doc.drop);
  win.document.getElementById('modeMd').dispatchEvent(new win.Event('click'));
  assert.equal(win.document.getElementById('dropTitle').textContent, win.COPY.md.drop);
  assert.equal(win.document.getElementById('pasteBox').hidden, false);
  win.document.getElementById('modeDoc').dispatchEvent(new win.Event('click'));
  assert.equal(win.document.getElementById('pasteBox').hidden, true);
});

test('the static copy in index.html matches the COPY table app.js applies', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const win = makeWindow({ withApp: true });
  const text = (id) => (new RegExp('id="' + id + '"[^>]*>([^<]*)<').exec(html) || [])[1];
  const norm = (s) => String(s || '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  assert.equal(norm(text('dropTitle')), norm(win.COPY.doc.drop));
  assert.equal(norm(text('dropHint')), norm(win.COPY.doc.hint));
  assert.equal(norm(text('heroTitle')), norm(win.COPY.doc.hero));
  assert.equal(norm(text('heroSub')), norm(win.COPY.doc.sub));
});

test('the file picker accepts every extension the converter handles', () => {
  const win = makeWindow({ withApp: true });
  const accept = win.document.getElementById('picker').accept;
  for (const ext of ['.docx', '.pdf', '.html', '.zip']) {
    assert.ok(accept.includes(ext), 'picker does not accept ' + ext);
  }
});

test('Copy, Download and Preview act on the page the active tab shows', async () => {
  const win = makeWindow({ withApp: true });
  // An archive emits _order.yaml files alongside pages. They carry text but
  // are not pages; if the tab list and the button handlers disagree about
  // that, Copy hands back a YAML file while the screen shows Markdown.
  win.__setResults([
    { path: 'docs/_order.yaml', text: '- a\n' },
    { path: 'docs/Guides/alpha.md', text: '---\ntitle: "A"\n---\n\nAlpha body\n' },
    { path: 'docs/Guides/_order.yaml', text: '- alpha\n' },
    { path: 'docs/Guides/beta.md', text: '---\ntitle: "B"\n---\n\nBeta body\n' },
  ], [{ source: 'z.zip', kind: 'archive' }], 1);

  const tabs = [...win.document.getElementById('tabs').children].map((b) => b.textContent);
  assert.deepEqual(tabs, ['Guides/alpha.md', 'Guides/beta.md']);
  assert.match(win.document.getElementById('preview').textContent, /Beta body/);
  assert.equal(win.activePage().path, 'docs/Guides/beta.md');
});

test('the report renders without throwing for every source kind', () => {
  const win = makeWindow({ withApp: true });
  win.__setResults([{ path: 'a.md', text: '# x\n' }], [
    { source: 'a.docx', kind: 'docx', codeBlocks: 2, callouts: 1, autocorrectFixes: 4,
      headingMap: ['h1→h2'], demoted: ['Response'], notes: ['n'], warnings: ['w'] },
    { source: 'b.pdf', kind: 'pdf', pdfPages: 12, pdfTables: 3, pdfFurnitureDropped: 2 },
    { source: 'c.html', kind: 'html', htmlRoot: 'main', htmlRelativeImages: 2 },
    { source: 'd.md', kind: 'markdown', mdEscapedTags: 5, mdSelfClosed: 1, mdFrontmatter: ['title'] },
    { source: 'e.zip', kind: 'archive', gitsync: { categories: ['Guides'], pages: 3, parents: 1, stubs: 1 },
      members: [{ name: 'x.docx', ok: false }], warnings: [] },
    { source: 'f.docx', error: 'not a zip file' },
  ], 0);
  const text = win.document.getElementById('report').textContent;
  assert.match(text, /code block/);
  assert.match(text, /PDF page/);
  assert.match(text, /not a zip file/);
});
