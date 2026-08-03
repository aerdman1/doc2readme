/* build.test.js — the two artifacts have to match the sources.
 *
 * Both failure modes here are invisible in a browser until a user hits them:
 * a stale ?v= hash serves last week's app.js against this week's index.html
 * (which looks like broken code and is not), and a stale doc2readme.html hands
 * whoever downloaded the offline copy a converter without any of the fixes.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = ['styles.css', 'preview.js', 'md-clean.js', 'html-extract.js',
                'gitsync.js', 'pdf-extract.js', 'converter.js', 'app.js'];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const digest = (f) => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(ROOT, f))).digest('hex').slice(0, 8);

test('index.html cache-busting hashes are current — run `npm run build`', () => {
  const html = read('index.html');
  const stale = ASSETS.filter((a) => !html.includes(a + '?v=' + digest(a)));
  assert.deepEqual(stale, []);
});

test('doc2readme.html is built from the current sources — run `npm run build`', () => {
  const bundle = read('doc2readme.html');
  const stale = ASSETS.filter((a) => !bundle.includes(read(a)));
  assert.deepEqual(stale, []);
});

test('the single-file build keeps connect-src none — that is the privacy claim', () => {
  const bundle = read('doc2readme.html');
  const csp = /content="([^"]*connect-src[^"]*)"/.exec(bundle);
  assert.ok(csp, 'no Content-Security-Policy in the bundle');
  assert.match(csp[1], /connect-src 'none'/);
  assert.match(read('index.html'), /connect-src 'none'/);
  assert.match(read('vercel.json'), /connect-src 'none'/);
});

test('the single-file build references nothing outside itself', () => {
  const bundle = read('doc2readme.html')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '');
  const external = [...bundle.matchAll(/(?:src|href)="(?!data:|#)([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external, []);
});

test('vendored pdf.js is the legacy build, or PDFs break on supported browsers', () => {
  // The default build calls Promise.withResolvers (Chrome 119+). The page
  // advertises Chrome 103+, and on 103-118 a dropped PDF threw. The legacy
  // build carries the polyfills; this fails if it is ever swapped back.
  const lib = read(path.join('vendor', 'pdf.mjs'));
  assert.match(lib, /withResolvers\s*:\s*function withResolvers|withResolvers\s*=\s*function/,
    'vendor/pdf.mjs does not polyfill Promise.withResolvers — use legacy/build/');
  const stated = read('README.md') + read('index.html');
  assert.match(stated, /Chrome[^.]*103\+/,
    'the documented browser floor moved; recheck what pdf.js needs');
});

test('no two scripts declare the same global — the second would never run', () => {
  const decl = /^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm;
  const seen = new Map();
  const clashes = [];
  for (const file of ASSETS.filter((a) => a.endsWith('.js'))) {
    for (const m of read(file).matchAll(decl)) {
      if (seen.has(m[1])) clashes.push(m[1] + ': ' + seen.get(m[1]) + ' and ' + file);
      else seen.set(m[1], file);
    }
  }
  assert.deepEqual(clashes, []);
});
