/* fixtures.test.js — the real documents sitting next to this repo.
 *
 * Synthetic fixtures test the rules; these test the reality. They are skipped
 * when the files are not present, so the suite still runs anywhere.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeWindow } = require('./harness');

const DIR = path.join(__dirname, '..', '..');
const has = (f) => fs.existsSync(path.join(DIR, f));
const load = (f) => {
  const b = fs.readFileSync(path.join(DIR, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

let win;
test.before(() => { win = makeWindow(); });

/** Anything that would stop the page compiling as MDX. */
function mdxHazards(markdown) {
  const body = String(markdown).replace(/^---[\s\S]*?\n---\n/, '');
  let scan = body.replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1?\2\s*$/gm, '');
  scan = scan.replace(/(`+)[^`\n]*\1/g, '');
  const out = [];
  for (const m of scan.matchAll(/(^|[^\\])<!--/g)) out.push('html comment');
  for (const m of scan.matchAll(/(^|[^\\])\{/g)) {
    if (/<[A-Za-z][^<>]*$/.test(scan.slice(Math.max(0, m.index - 80), m.index))) continue;
    out.push('bare { — ' + JSON.stringify(scan.slice(Math.max(0, m.index - 30), m.index + 30)));
  }
  for (const m of scan.matchAll(/(^|[^\\`])<\/?([A-Za-z][A-Za-z0-9._-]*)([^<>]*)>/g)) {
    if (win.mdClean.isKnownTag(m[2])) continue;
    out.push('unescaped <' + m[2] + '>');
  }
  return out;
}

const t = (name, file, fn) =>
  test(name, { skip: has(file) ? false : file + ' not present' }, fn);

t('RawFormat_Example.docx converts and is MDX-safe', 'RawFormat_Example.docx', async () => {
  const opts = win.docx2readme.defaultOptions();
  const res = await win.docx2readme.convertDocument(
    load('RawFormat_Example.docx'), 'RawFormat_Example.docx', opts);
  const page = res.files.find((f) => f.text !== undefined);
  assert.ok(page.text.length > 2000, 'suspiciously short output');
  assert.deepEqual(mdxHazards(page.text).slice(0, 5), []);
  // Every fence opens and closes.
  const fences = (page.text.match(/^ {0,3}`{3,}/gm) || []).length;
  assert.equal(fences % 2, 0, 'unbalanced code fences');
  // Tables are rectangular.
  for (const block of page.text.split(/\n\n+/)) {
    if (!/^\|/.test(block)) continue;
    const widths = new Set(block.trim().split('\n').map((r) => r.split(/(?<!\\)\|/).length));
    assert.equal(widths.size, 1, 'ragged table:\n' + block.slice(0, 300));
  }
});

t('markdownExample.md cleans and is MDX-safe', 'markdownExample.md', async () => {
  const opts = Object.assign(win.docx2readme.defaultOptions(), { forceMarkdown: true });
  const res = await win.docx2readme.convertDocument(
    load('markdownExample.md'), 'markdownExample.md', opts);
  const page = res.files.find((f) => f.text !== undefined);
  assert.ok(page.text.length > 1000);
  assert.deepEqual(mdxHazards(page.text).slice(0, 5), []);
  const fences = (page.text.match(/^ {0,3}`{3,}/gm) || []).length;
  assert.equal(fences % 2, 0, 'unbalanced code fences');
});

t('ReadMe_MD_Uploader.zip lays out for git-sync', 'ReadMe_MD_Uploader.zip', async () => {
  const opts = win.docx2readme.defaultOptions();
  const res = await win.docx2readme.convertDocument(
    load('ReadMe_MD_Uploader.zip'), 'ReadMe_MD_Uploader.zip', opts);
  assert.equal(res.report.kind, 'archive');
  assert.ok(res.files.some((f) => f.path === 'docs/_order.yaml'));
  const pages = res.files.filter((f) => /\.md$/.test(f.path));
  assert.ok(pages.length > 0, 'no pages produced');
  for (const p of pages) assert.deepEqual(mdxHazards(p.text).slice(0, 3), [], p.path);
  // Nothing lands outside the two folders ReadMe reads.
  for (const f of res.files) assert.match(f.path, /^(docs|reference)\//);
});
