/* md-clean.js — Markdown in, the same Block[] model out.
 *
 * For people who already have Markdown: exports from another docs tool, a
 * git-synced folder, or something a writer hand-wrote. Parsing it into the
 * same Block[] shape that converter.js builds from .docx means every existing
 * pass applies unchanged — heading remap, label demotion, callout conversion,
 * AutoCorrect repair inside code, MDX escaping, splitting.
 *
 * The MDX escaping is the real reason this exists. Markdown written for
 * GitHub happily contains `<YOUR_TOKEN>` in body text; ReadMe compiles pages
 * as MDX, where that is a JSX tag and a syntax error takes the whole page
 * down. Round-tripping through here fixes it.
 */
'use strict';

// Tags that are real HTML/ReadMe components and must survive untouched.
// Anything else in angle brackets is a placeholder like <YOUR_TOKEN> and gets
// escaped. Sourced from what real ReadMe projects actually use.
const KNOWN_TAGS = new Set([
  // ReadMe components
  'callout', 'accordion', 'accordions', 'tabs', 'tab', 'card', 'cards',
  'column', 'columns', 'image', 'embed', 'anchor', 'table', 'htmlblock',
  'glossary', 'recipe', 'code', 'terminal',
  // plain HTML that shows up in docs
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'col', 'colgroup',
  'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'iframe', 'img', 'ins',
  'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'u', 'ul', 'var', 'video', 'source', 'picture',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'col', 'source', 'wbr', 'embed', 'area']);

function isKnownTag(name) {
  return KNOWN_TAGS.has(String(name || '').toLowerCase());
}

/**
 * Escape angle brackets that MDX would read as a JSX tag, leaving genuine
 * markup alone. `<YOUR_TOKEN>` becomes `\<YOUR_TOKEN\>`; `<br>` becomes
 * `<br />`; `<Callout ...>` is untouched.
 */
function escapeStrayTags(text, stats) {
  // Code spans are already safe from MDX and do not process backslash
  // escapes, so escaping inside one renders a literal `\<id\>`. Split them
  // out, escape only around them, put them back verbatim.
  const parts = String(text || '').split(/(`+[^`]*`+)/);
  return parts.map((part, i) => (i % 2 ? part : escapeOutsideCode(part, stats))).join('');
}

function escapeOutsideCode(text, stats) {
  return String(text || '').replace(
    /<\/?([A-Za-z][A-Za-z0-9._-]*)((?:"[^"]*"|'[^']*'|[^'">])*)\/?>/g,
    (m, name, attrs) => {
      if (!isKnownTag(name)) {
        stats.escapedTags = (stats.escapedTags || 0) + 1;
        return m.replace(/</g, '\\<').replace(/>/g, '\\>');
      }
      // A known tag name is only real markup if it actually closes. Prose like
      // "a real <Callout> is fine" is an unterminated JSX element and fails to
      // build, so treat a lone opening tag as text.
      const lower = name.toLowerCase();
      if (!VOID_TAGS.has(lower) && m[1] !== '/' && !/\/\s*>$/.test(m)) {
        const closes = new RegExp('</\\s*' + name + '\\s*>', 'i').test(text);
        if (!closes) {
          stats.escapedTags = (stats.escapedTags || 0) + 1;
          return m.replace(/</g, '\\<').replace(/>/g, '\\>');
        }
      }
      if (VOID_TAGS.has(name.toLowerCase()) && !/\/\s*>$/.test(m) && m[1] !== '/') {
        stats.selfClosed = (stats.selfClosed || 0) + 1;
        return '<' + name + attrs.replace(/\s+$/, '') + ' />';
      }
      return m;
    });
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function stripFrontmatter(text, meta) {
  const m = FRONTMATTER.exec(text);
  if (!m) return text;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return text.slice(m[0].length);
}

function splitRow(row) {
  const out = [];
  let cur = '', esc = false;
  const body = row.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  for (const ch of body) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; cur += ch; continue; }
    if (ch === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Blockquote callouts (> 📘 ...) and <Callout> components both appear in the
// wild; normalise either into the internal callout block.
const CALLOUT_GLYPHS = {
  '📘': '📘', 'ℹ️': '📘', 'ℹ': '📘', '💡': '📘',
  '🚧': '🚧', '⚠️': '🚧', '⚠': '🚧',
  '❗️': '❗️', '❗': '❗️', '🛑': '❗️',
  '👍': '👍', '✅': '👍',
};

function markdownToBlocks(text, report) {
  const meta = {};
  let src = stripFrontmatter(String(text || '').replace(/\r\n?/g, '\n'), meta);
  if (Object.keys(meta).length) report.mdFrontmatter = Object.keys(meta);

  const lines = src.split('\n');
  const blocks = [];
  const stats = {};
  let i = 0;

  const pushPara = (buf) => {
    const t = escapeStrayTags(buf.join(' ').trim(), stats);
    if (t) blocks.push({ kind: 'para', text: t, images: [] });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // fenced code — contents are never escaped or reflowed
    const fence = /^(\s*)(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const close = new RegExp('^\\s*' + marker + '{' + fence[2].length + ',}\\s*$');
      const buf = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push({ kind: 'code', text: buf.join('\n'), lang: fence[3] || '', images: [] });
      report.mdCodeBlocks = (report.mdCodeBlocks || 0) + 1;
      continue;
    }

    // <Callout ...> ... </Callout>  -> internal callout block
    const co = /^\s*<Callout\b([^>]*)>\s*$/i.exec(line);
    if (co) {
      const icon = (/icon\s*=\s*"([^"]*)"/.exec(co[1]) || [])[1] || '📘';
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*<\/Callout>\s*$/i.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push({
        kind: 'callout',
        emoji: CALLOUT_GLYPHS[icon] || icon,
        text: escapeStrayTags(buf.join('\n').replace(/^#+\s*/, '').trim(), stats),
        images: [],
      });
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2].trim(), images: [] });
      i++;
      continue;
    }
    // setext heading
    if (i + 1 < lines.length && /^\s*(=+|-+)\s*$/.test(lines[i + 1]) && line.trim()) {
      blocks.push({
        kind: 'heading',
        level: lines[i + 1].trim()[0] === '=' ? 1 : 2,
        text: line.trim(), images: [],
      });
      i += 2;
      continue;
    }

    // table
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push({
        kind: 'table',
        rows: rows.map((r) => r.map((c) => escapeStrayTags(c, stats))),
      });
      report.mdTables = (report.mdTables || 0) + 1;
      continue;
    }

    // blockquote — emoji callout or plain quote
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const body = buf.join('\n').trim();
      const chars = [...body];
      const glyph = (chars[1] === '️' ? chars[0] + chars[1] : chars[0]);
      if (CALLOUT_GLYPHS[glyph]) {
        blocks.push({
          kind: 'callout',
          emoji: CALLOUT_GLYPHS[glyph],
          text: escapeStrayTags(body.slice(glyph.length).replace(/^[\s:—-]+/, '').trim(), stats),
          images: [],
        });
      } else {
        blocks.push({ kind: 'para', text: escapeStrayTags(body, stats), images: [] });
      }
      continue;
    }

    // horizontal rule
    if (/^\s*(\*\s*){3,}$|^\s*(-\s*){3,}$|^\s*(_\s*){3,}$/.test(line)) { i++; continue; }

    // list
    const li = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (li) {
      while (i < lines.length) {
        const m2 = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[i]);
        if (!m2) break;
        blocks.push({
          kind: 'list',
          text: escapeStrayTags(m2[3].trim(), stats),
          level: Math.min(3, Math.floor(m2[1].replace(/\t/g, '  ').length / 2)),
          ordered: /\d/.test(m2[2]),
          images: [],
        });
        i++;
      }
      continue;
    }

    // standalone image line stays a paragraph; the renderer passes it through
    const buf = [];
    while (i < lines.length && lines[i].trim() &&
           !/^(\s*#{1,6}\s|\s*(`{3,}|~{3,})|\s*\||\s*>|\s*<Callout\b)/i.test(lines[i]) &&
           !/^(\s*)([-*+]|\d{1,3}[.)])\s+/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    if (buf.length) pushPara(buf);
    else i++;
  }

  if (stats.escapedTags) report.mdEscapedTags = stats.escapedTags;
  if (stats.selfClosed) report.mdSelfClosed = stats.selfClosed;
  report.mdTitle = meta.title || '';
  return blocks;
}

window.mdClean = { markdownToBlocks, escapeStrayTags, isKnownTag };
