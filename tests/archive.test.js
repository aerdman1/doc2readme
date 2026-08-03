'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeWindow, buildDocx, buildZip, heading, para } = require('./harness');

let win;
test.before(() => { win = makeWindow(); });

const bytesOf = (ab) => new Uint8Array(ab);

async function docxBytes(body, opts) {
  return bytesOf(await buildDocx(win, body, opts));
}

async function convertZip(members, over = {}) {
  const opts = Object.assign(win.docx2readme.defaultOptions(), over);
  const buf = await buildZip(win, members);
  const res = await win.docx2readme.convertDocument(buf, over.__zipName || 'docs.zip', opts);
  const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]));
  return { res, paths: res.files.map((f) => f.path).sort(), byPath };
}

test('a folder tree becomes categories, pages and _order.yaml files', async () => {
  const { paths, byPath } = await convertZip({
    'Getting Started/01-installation.md': '# Installation\n\nRun the installer.\n',
    'Getting Started/02-authentication/index.md': '# Authentication\n\nOverview.\n',
    'Getting Started/02-authentication/oauth.md': '# OAuth\n\nFlow.\n',
    'Reference/errors.md': '# Errors\n\nCodes.\n',
  });
  assert.ok(paths.includes('docs/_order.yaml'));
  assert.ok(paths.includes('docs/Getting Started/installation.md'));
  assert.ok(paths.includes('docs/Getting Started/authentication/index.md'));
  assert.ok(paths.includes('docs/Getting Started/authentication/oauth.md'));
  assert.ok(paths.includes('docs/Reference/errors.md'));
  assert.match(byPath['docs/Getting Started/_order.yaml'].text, /installation[\s\S]*authentication/);
  assert.match(byPath['docs/Getting Started/authentication/index.md'].text, /Overview/);
});

test('loose files at the top of a zip still land somewhere', async () => {
  const { res, paths } = await convertZip({
    'guide.md': '# Guide\n\nBody.\n',
    'faq.md': '# FAQ\n\nBody.\n',
  });
  const pages = paths.filter((p) => p.endsWith('.md'));
  assert.equal(pages.length, 2,
    'top-level documents were dropped instead of being given a category: ' + JSON.stringify(paths));
  assert.ok(!(res.report.gitsync.categories || []).includes(''));
});

test('mixed .docx, .md and .html in one zip all convert', async () => {
  const { res, paths } = await convertZip({
    'Guides/a.md': '# A\n\nmd body\n',
    'Guides/b.docx': await docxBytes(heading(1, 'B') + para('docx body')),
    'Guides/c.html': '<!doctype html><html><body><main><h1>C</h1><p>' +
      'html body long enough to be chosen as the root region of this page.</p></main></body></html>',
  });
  assert.equal(res.report.members.filter((m) => m.ok).length, 3,
    JSON.stringify(res.report.members));
  assert.ok(paths.includes('docs/Guides/a.md'));
  assert.ok(paths.includes('docs/Guides/b.md'));
  assert.ok(paths.includes('docs/Guides/c.md'));
});

test('an OpenAPI spec rides along in reference/', async () => {
  const { paths } = await convertZip({
    'Guides/a.md': '# A\n\nbody\n',
    'api/openapi.yaml': 'openapi: 3.0.0\ninfo:\n  title: X\n',
    'Guides/config.json': '{"unrelated": true}',
  });
  assert.ok(paths.includes('reference/openapi.yaml'));
  assert.ok(!paths.some((p) => p.endsWith('config.json')));
});

test('two documents that reduce to the same slug do not overwrite each other', async () => {
  const { res, paths } = await convertZip({
    'Guides/01-setup.md': '# Setup one\n\na\n',
    'Guides/setup.md': '# Setup two\n\nb\n',
  });
  const pages = paths.filter((p) => /^docs\/Guides\/.*\.md$/.test(p));
  assert.equal(pages.length, 2, JSON.stringify(paths));
  assert.ok(res.report.warnings.some((w) => /both became/.test(w)));
});

test('macOS packaging noise is ignored', async () => {
  const { paths } = await convertZip({
    'Guides/a.md': '# A\n\nbody\n',
    '__MACOSX/Guides/._a.md': 'junk',
    'Guides/.DS_Store': 'junk',
  });
  assert.ok(!paths.some((p) => /MACOSX|DS_Store/.test(p)));
});

test('images inside a zipped .docx are not silently lost', async () => {
  const drawing =
    `<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId5"/>` +
    `</w:drawing></w:r></w:p>`;
  const docx = bytesOf(await buildDocx(win, heading(1, 'T') + drawing, {
    rels: { rId5: 'media/image1.png' },
    extraFiles: { 'word/media/image1.png': 'PNGDATA' },
  }));
  const { paths, byPath } = await convertZip({ 'Guides/withimage.docx': docx });
  const page = Object.keys(byPath).find((p) => p.endsWith('withimage.md'));
  assert.ok(page, JSON.stringify(paths));
  if (/!\[\]\(/.test(byPath[page].text)) {
    assert.ok(paths.some((p) => /\.png$/.test(p)),
      'the page references an image the zip does not contain: ' + JSON.stringify(paths));
  }
});

test('a per-run title is not stamped onto every page in a zip', async () => {
  const { byPath } = await convertZip({
    'Guides/a.md': '# A\n\na\n',
    'Guides/b.md': '# B\n\nb\n',
  }, { title: 'One Title' });
  const titles = ['docs/Guides/a.md', 'docs/Guides/b.md']
    .map((p) => (byPath[p].text.match(/title: "(.*)"/) || [])[1]);
  assert.notDeepEqual(titles, ['One Title', 'One Title'],
    'every page in the zip got the same title');
});

test('a zip with nothing convertible fails clearly', async () => {
  await assert.rejects(() => convertZip({ 'notes.txt.bak': 'x', 'a/b.png': 'y' }),
    /no .*files found/i);
});

test('a nested folder deeper than ReadMe allows is flattened, not dropped', async () => {
  const { paths, res } = await convertZip({
    'Cat/a/b/c/d/deep.md': '# Deep\n\nbody\n',
  });
  assert.ok(paths.some((p) => /deep/.test(p)), JSON.stringify(paths));
  assert.ok(res.report.warnings.some((w) => /three page levels/.test(w)));
});
