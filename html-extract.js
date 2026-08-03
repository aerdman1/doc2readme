/* html-extract.js — HTML in, the same Block[] model out.
 *
 * The fourth source format, and a common one: Confluence and Zendesk exports,
 * old doc sites, static-site builds, and Word's own "Save as Web Page".
 *
 * HTML sits between .docx and PDF in how much it tells us. Unlike a PDF it
 * has real structure — an <h2> is genuinely a heading, a <table> genuinely a
 * table — so this is closer to the Word path than the PDF one. What it also
 * has is enormous amounts of chrome: navigation, sidebars, cookie banners,
 * "on this page" widgets, and in Word's case a blizzard of mso- spans. Most
 * of the work here is deciding what to throw away.
 *
 * Parsing is DOMParser, which every target browser already has.
 */
'use strict';

// Never content.
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
  'object', 'embed', 'link', 'meta', 'form', 'input', 'button', 'select',
  'textarea', 'audio', 'video', 'map', 'area',
  // Word/Office namespaced leftovers. DOMParser lowercases these to o:p etc.
  'o:p', 'o:smarttagtype', 'v:shape', 'v:shapetype', 'v:imagedata', 'v:stroke',
  'v:formulas', 'v:path', 'w:sdt', 'xml',
]);

// Page furniture. Removed wholesale — an export's sidebar is not
// documentation. <header> is deliberately not here: plenty of exports wrap the
// page title in one, so it goes through the same test as a class-named
// container below.
const CHROME_TAGS = new Set(['nav', 'aside', 'footer']);
const CHROME_HINT = /(^|[\s_-])(nav|navbar|sidebar|side-?bar|menu|breadcrumb|toc|table-of-contents|on-this-page|pagination|pager|footer|header|masthead|banner|cookie|consent|skip-link|search|social|share|related|feedback|rate-this|edit-this-page|advert|ad-)([\s_-]|$)/i;

const HEADING = /^h([1-6])$/;

/* ---- Word "Save as Web Page" ------------------------------------------
 * Word does not emit <h2>; it emits <p class=MsoHeading2>. It pads cells with
 * runs of &nbsp;, puts its table of contents in MsoToc1..9, splits long
 * blocks into CxSpFirst/Middle/Last continuations, litters the file with
 * <o:p> and VML, and points decorative images into a "<name>_files" sidecar
 * folder that never ships. Handling these is the difference between a usable
 * conversion and a page of empty paragraphs.
 */
const MSO_HEADING = /(?:^|\s)(?:Mso)?Heading([1-6])(?:CxSp\w+)?(?:\s|$)/i;
const MSO_TOC = /(?:^|\s)(?:Mso)?Toc\d?(?:CxSp\w+)?(?:\s|$)/i;
const MSO_LIST = /(?:^|\s)MsoListParagraph(?:CxSp\w+)?(?:\s|$)/i;
const WORD_SIDECAR = /(^|\/)[^/]+_files\//i;
// Leading glyphs Word writes as literal text instead of using a real list.
const WORD_BULLET = /^\s*(?:[•·▪◦‣∙o§]|[-–—])\s+/;

function msoHeadingLevel(el) {
  const m = MSO_HEADING.exec(el.getAttribute('class') || '');
  return m ? +m[1] : 0;
}
const MONO_TAGS = new Set(['code', 'kbd', 'samp', 'tt', 'var']);

/**
 * 'semantic' — the markup says so (<nav>, role="navigation"); always chrome.
 * 'named'    — only the class or id says so; a hint that needs corroborating.
 */
function chromeKind(el) {
  if (CHROME_TAGS.has(el.localName)) return 'semantic';
  const role = el.getAttribute('role') || '';
  if (/^(navigation|banner|contentinfo|complementary|search)$/i.test(role)) return 'semantic';
  const named = el.localName === 'header' ||
                CHROME_HINT.test(el.getAttribute('id') || '') ||
                CHROME_HINT.test(el.getAttribute('class') || '');
  if (!named) return null;
  // "article-header", "page-header" and "content-header" hold the page title;
  // dropping them loses the H1 and nobody can tell why. Navigation is what has
  // the links — a title block has a heading and almost none.
  const links = el.querySelectorAll('a[href]').length;
  const hasHeading = !!el.querySelector('h1, h2, h3, h4, h5, h6');
  return (links >= 3 || !hasHeading) ? 'named' : null;
}

function isChrome(el) {
  return chromeKind(el) !== null;
}

/** Prefer <main> / <article> when the document has one — that is the content. */
function pickRoot(doc) {
  for (const sel of ['main', 'article', '[role="main"]', '#content', '.markdown-body',
                     '#main-content', '.article-body', '.wiki-content']) {
    const el = doc.querySelector(sel);
    if (el && el.textContent.trim().length > 200) return el;
  }
  return doc.body || doc.documentElement;
}

function langFromClass(el) {
  const cls = (el.getAttribute('class') || '') + ' ' +
              ((el.firstElementChild && el.firstElementChild.getAttribute('class')) || '');
  const m = /(?:language|lang|highlight-source|brush:?)[-_ ]([a-z0-9+#]+)/i.exec(cls);
  if (m) return m[1].toLowerCase();
  const data = el.getAttribute('data-lang') || el.getAttribute('data-language') || '';
  return data.toLowerCase();
}

/* ------------------------------------------------------------------ inline */

function inlineOf(node, stats) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {                       // text
      // Word pads with runs of &nbsp;; treat them as ordinary spaces.
      out += escText(child.nodeValue.replace(/\u00a0/g, ' ').replace(/\s+/g, ' '));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.localName;
    if (DROP_TAGS.has(tag)) continue;
    if (tag === 'br') { out += '\n'; continue; }
    if (MONO_TAGS.has(tag)) {
      const t = child.textContent.replace(/\s+/g, ' ').trim();
      if (t) {
        const ticks = (t.match(/`+/g) || []).reduce((a, b) => Math.max(a, b.length), 0) + 1;
        out += '`'.repeat(ticks) + t + '`'.repeat(ticks);
      }
      continue;
    }
    if (tag === 'img') { out += imgMarkdown(child, stats); continue; }
    if (tag === 'a') {
      const href = (child.getAttribute('href') || '').trim();
      const text = inlineOf(child, stats).trim();
      if (!text) continue;
      // Anchors to nowhere, and in-page jumps whose target we are not keeping,
      // are noise; keep the words, drop the link.
      out += (href && !/^#/.test(href) && !/^javascript:/i.test(href))
        ? '[' + text + '](' + encodeTarget(href) + ')'
        : text;
      continue;
    }
    const inner = inlineOf(child, stats);
    if (!inner.trim()) { out += inner; continue; }
    if (tag === 'strong' || tag === 'b') out += wrapInline(inner, '**');
    else if (tag === 'em' || tag === 'i') out += wrapInline(inner, '*');
    else if (tag === 'del' || tag === 's' || tag === 'strike') out += wrapInline(inner, '~~');
    else out += inner;
  }
  return out;
}

function wrapInline(piece, marker) {
  const t = piece.trim();
  if (!t) return piece;
  const lead = piece.slice(0, piece.length - piece.trimStart().length);
  const trail = piece.slice(piece.trimEnd().length);
  return lead + marker + t + marker + trail;
}

function imgMarkdown(el, stats) {
  const src = (el.getAttribute('src') || el.getAttribute('data-src') || '').trim();
  if (!src) return '';
  // Word's sidecar folder holds spacer rules and tracking pixels, and is
  // almost never shipped alongside the .htm.
  if (WORD_SIDECAR.test(src)) { stats.wordSidecar = (stats.wordSidecar || 0) + 1; return ''; }
  const alt = (el.getAttribute('alt') || '').replace(/[[\]]/g, '');
  if (/^(https?:)?\/\//i.test(src) || /^data:/i.test(src)) {
    stats.absoluteImages = (stats.absoluteImages || 0) + 1;
  } else stats.relativeImages = (stats.relativeImages || 0) + 1;
  return '![' + escText(alt) + '](' + encodeTarget(src) + ')';
}

// converter.js owns escaping; reuse it so all four inputs escape identically.
function escText(text) {
  return window.docx2readme && window.docx2readme.escapeInline
    ? window.docx2readme.escapeInline(text)
    : String(text || '').replace(/([\\`*[\]<>{}])/g, '\\$1');
}

// Spaces and parentheses end a markdown link target early; SharePoint and
// Confluence URLs are full of both.
function encodeTarget(url) {
  return String(url || '').trim().replace(/\s/g, '%20')
    .replace(/</g, '%3C').replace(/>/g, '%3E')
    .replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/* ------------------------------------------------------------------ blocks */

function htmlToBlocks(html, report) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  if (!doc || !doc.body) throw new Error('could not parse this HTML');

  const titleEl = doc.querySelector('title');
  if (titleEl && titleEl.textContent.trim()) report.htmlTitle = titleEl.textContent.trim();

  const root = pickRoot(doc);
  report.htmlRoot = root.localName + (root.id ? '#' + root.id : '');

  const blocks = [];
  const stats = {};
  let dropped = 0;
  // A wrapper called "article-header" or "content-header" holds the page
  // title, not chrome. Anything holding a large share of the page's text is
  // the page, whatever it is named — drop it and the conversion comes back
  // empty for no visible reason.
  const rootChars = (root.textContent || '').trim().length;

  const walk = (node, listDepth) => {
    for (const el of node.children) {
      const tag = el.localName;
      if (DROP_TAGS.has(tag)) continue;
      const chrome = chromeKind(el);
      // A class-name hint never outvotes the fact that this element holds most
      // of the page's words — that is the page, whatever it is called.
      if (chrome === 'semantic' ||
          (chrome === 'named' && (el.textContent || '').trim().length < rootChars * 0.5)) {
        dropped++;
        continue;
      }

      // Word's TOC is a run of MsoToc paragraphs — ReadMe builds its own.
      if (MSO_TOC.test(el.getAttribute('class') || '')) { dropped++; continue; }

      const msoLevel = msoHeadingLevel(el);
      if (msoLevel && !HEADING.test(tag)) {
        const text = el.textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        if (text) {
          blocks.push({ kind: 'heading', level: msoLevel, text, images: [] });
          report.htmlWordHeadings = (report.htmlWordHeadings || 0) + 1;
        }
        continue;
      }

      // A Word "list" is a plain paragraph starting with a bullet glyph.
      if (MSO_LIST.test(el.getAttribute('class') || '')) {
        const raw = inlineOf(el, stats).replace(/\s*\n\s*/g, ' ').trim();
        const m = WORD_BULLET.exec(raw);
        if (m) {
          blocks.push({ kind: 'list', text: raw.slice(m[0].length).trim(),
                        level: 0, ordered: false, images: [] });
          report.htmlWordLists = (report.htmlWordLists || 0) + 1;
          continue;
        }
        if (raw) blocks.push({ kind: 'para', text: raw, images: [] });
        continue;
      }

      const h = HEADING.exec(tag);
      if (h) {
        const text = el.textContent.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        if (text) blocks.push({ kind: 'heading', level: +h[1], text, images: [] });
        continue;
      }

      if (tag === 'pre') {
        const text = (el.textContent || '').replace(/\s+$/, '');
        if (text.trim()) {
          blocks.push({ kind: 'code', text, lang: langFromClass(el), images: [] });
          report.htmlCodeBlocks = (report.htmlCodeBlocks || 0) + 1;
        }
        continue;
      }

      if (tag === 'table') { pushTable(el, blocks, stats, report); continue; }

      if (tag === 'ul' || tag === 'ol') {
        pushList(el, blocks, stats, tag === 'ol', listDepth || 0, report);
        continue;
      }

      if (tag === 'blockquote') {
        const text = inlineOf(el, stats).replace(/\s*\n\s*/g, ' ').trim();
        if (text) blocks.push({ kind: 'para', text, images: [] });
        continue;
      }

      if (tag === 'hr' || tag === 'br') continue;

      // An <img> sitting directly in the flow has no child nodes, so the
      // generic leaf path below renders it as the empty string and the
      // diagram vanishes without a word in the report.
      if (tag === 'img') {
        const md = imgMarkdown(el, stats);
        if (md) blocks.push({ kind: 'para', text: md, images: [] });
        continue;
      }

      if (tag === 'figure') {
        const img = el.querySelector('img');
        const cap = el.querySelector('figcaption');
        const parts = [];
        if (img) parts.push(imgMarkdown(img, stats));
        if (cap && cap.textContent.trim()) parts.push(escText(cap.textContent.trim()));
        if (parts.length) blocks.push({ kind: 'para', text: parts.join('\n'), images: [] });
        continue;
      }

      // A container: recurse. A leaf with text: emit a paragraph.
      const hasBlockKids = [...el.children].some((c) =>
        /^(p|div|section|h[1-6]|ul|ol|table|pre|blockquote|figure|article|main|dl)$/.test(c.localName));
      if (hasBlockKids) { walk(el, listDepth); continue; }

      const text = inlineOf(el, stats).replace(/[ \t]+/g, ' ').trim();
      if (text) blocks.push({ kind: 'para', text, images: [] });
    }
  };

  walk(root, 0);

  if (dropped) report.htmlChromeDropped = dropped;
  if (stats.wordSidecar) report.htmlWordSidecar = stats.wordSidecar;
  if (stats.absoluteImages) report.htmlAbsoluteImages = stats.absoluteImages;
  if (stats.relativeImages) report.htmlRelativeImages = stats.relativeImages;
  if (!blocks.length) throw new Error('no readable content found in this HTML');
  return blocks;
}

function pushList(listEl, blocks, stats, ordered, depth, report) {
  for (const li of listEl.children) {
    if (li.localName !== 'li') continue;
    const nested = [...li.children].filter((c) => c.localName === 'ul' || c.localName === 'ol');
    // A <pre> inside a list item is a code sample. Flattening it into the
    // sentence loses the fence, the language and every line break in it.
    const pres = [...li.children].filter((c) => c.localName === 'pre');
    const clone = li.cloneNode(true);
    for (const n of [...clone.children]) {
      if (/^(ul|ol|pre)$/.test(n.localName)) n.remove();
    }
    const text = inlineOf(clone, stats).replace(/\s*\n\s*/g, ' ').trim();
    if (text) {
      blocks.push({ kind: 'list', text, level: Math.min(3, depth), ordered, images: [] });
    }
    for (const pre of pres) {
      const code = (pre.textContent || '').replace(/\s+$/, '');
      if (!code.trim()) continue;
      blocks.push({ kind: 'code', text: code, lang: langFromClass(pre), images: [] });
      if (report) report.htmlCodeBlocks = (report.htmlCodeBlocks || 0) + 1;
    }
    for (const sub of nested) {
      pushList(sub, blocks, stats, sub.localName === 'ol', Math.min(3, depth + 1), report);
    }
  }
}

function pushTable(tableEl, blocks, stats, report) {
  const rows = [];
  for (const tr of tableEl.querySelectorAll('tr')) {
    // Skip rows belonging to a nested table; GFM cannot express those anyway.
    if (tr.closest('table') !== tableEl) continue;
    const cells = [];
    for (const cell of tr.children) {
      if (cell.localName !== 'td' && cell.localName !== 'th') continue;
      const text = inlineOf(cell, stats).replace(/\s*\n\s*/g, '<br />').trim();
      const span = parseInt(cell.getAttribute('colspan') || '1', 10) || 1;
      cells.push(text.replace(/\|/g, '\\|'));
      for (let i = 1; i < span; i++) cells.push('');
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return;
  blocks.push({ kind: 'table', rows });
  report.htmlTables = (report.htmlTables || 0) + 1;
}

window.htmlExtract = { htmlToBlocks, pickRoot, isChrome, chromeKind };
