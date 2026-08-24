/* table-wizard.js — a visual editor for ReadMe tables.
 *
 * ReadMe's own editor has no field for column width anywhere in its data
 * model (confirmed against the ReadMe monorepo: the only table prop is
 * `align`). This tool still lets you set widths, because there are two real
 * places for them to live even though ReadMe's UI never exposes a control
 * for either:
 *
 *   - inline `style` on each `<Table>` cell — valid MDX, renders live in
 *     ReadMe's visual editor, but survives only until a human re-edits that
 *     table there. Nothing in ReadMe's schema is known to keep an
 *     unrecognised style property through a save.
 *   - a plain `<table>` pasted into a Custom HTML block — never parsed into
 *     ReadMe's table schema at all, so nothing can strip it, but the block
 *     shows as source in the editor rather than a live table.
 *
 * Three output formats exist because of that gap, not for completeness:
 * Markdown (alignment survives, via the GFM colon syntax, no width — no
 * pipe table has ever had one), `<Table>` JSX (alignment durable, width
 * best-effort), Custom HTML (both durable, not WYSIWYG afterward).
 *
 * The input side takes the same three formats back, plus the legacy
 * `[block:parameters]` format old ReadMe projects still carry — reading it
 * is migration, not encouragement; nothing here ever writes it.
 *
 * Cells hold a small whitelist of inline HTML (strong, em, code, a, br) and
 * nothing else. Anything wider a paste brings in — spans, divs, styles — is
 * unwrapped to its text on the way in, deliberately, so the three output
 * converters never have to guess what an arbitrary tag was for.
 *
 * Wrapped in one IIFE, like mdx-table.js: classic scripts share a global
 * scope, and build.py's check_globals() fails the build on a second
 * top-level declaration of the same name.
 */
'use strict';

(function () {
  const ALIGNS = ['left', 'center', 'right'];

  /* --------------------------------------------------------------- model */
  // { header: bool, cols: [{ align, width }], rows: [[cellHtml, ...], ...] }
  // rows[0] is the header row when header is true. Cell strings hold only
  // the whitelist above; every reader and writer in this file agrees on that.

  function makeCol(align, width) {
    return { align: ALIGNS.includes(align) ? align : 'left', width: width || null };
  }

  function emptyModel() {
    return {
      header: true,
      cols: [makeCol(), makeCol(), makeCol()],
      rows: [
        ['Column 1', 'Column 2', 'Column 3'],
        ['', '', ''],
      ],
    };
  }

  function demoModel() {
    return {
      header: true,
      cols: [makeCol('left', 160), makeCol('left', null), makeCol('center', 110)],
      rows: [
        ['Endpoint', 'Description', 'Auth required'],
        ['<code>GET /users</code>', 'List every user in the project. See <a href="https://docs.readme.com">the docs</a> for pagination.', 'Yes'],
        ['<code>POST /users</code>', 'Create a user. <strong>Idempotent</strong> when a client-supplied id is repeated.', 'Yes'],
        ['<code>GET /status</code>', 'Health check — no auth, safe to poll.', 'No'],
      ],
    };
  }

  function cloneModel(m) {
    return {
      header: m.header,
      cols: m.cols.map((c) => ({ ...c })),
      rows: m.rows.map((r) => r.slice()),
    };
  }

  // Every row is padded/trimmed to the same width so a caller never has to
  // special-case a short row — the paste sources (a hand-typed pipe table,
  // a scraped HTML table) are exactly where uneven rows come from.
  function normalizeWidth(model) {
    const width = Math.max(model.cols.length, ...model.rows.map((r) => r.length), 1);
    while (model.cols.length < width) model.cols.push(makeCol());
    model.cols.length = width;
    model.rows = model.rows.map((r) => {
      const row = r.slice(0, width);
      while (row.length < width) row.push('');
      return row;
    });
    return model;
  }

  /* ------------------------------------------------------------ detection */

  function detectFormat(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (/\[block:parameters\]/.test(t)) return 'magic';
    if (/<Table\b/.test(t)) return 'jsx';          // ReadMe's component: capital T
    if (/<table\b/i.test(t)) return 'html';
    if (looksLikePipeTable(t)) return 'markdown';
    return null;
  }

  const SEP_LINE = /^\s*\|?(\s*:?-{1,}:?\s*\|)*\s*:?-{1,}:?\s*\|?\s*$/;

  function looksLikePipeTable(t) {
    const lines = t.split(/\r\n?|\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].includes('|') && SEP_LINE.test(lines[i + 1])) return true;
    }
    return false;
  }

  function parseAny(text) {
    const fmt = detectFormat(text);
    if (fmt === 'markdown') return { format: fmt, model: parseMarkdown(text) };
    if (fmt === 'html') return { format: fmt, model: parseHtml(text) };
    if (fmt === 'jsx') return { format: fmt, model: parseJsx(text) };
    if (fmt === 'magic') return { format: fmt, model: parseMagicBlock(text) };
    return { format: null, model: null };
  }

  /* ------------------------------------------------------- markdown input */

  function splitPipeRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    // Split on an unescaped pipe only — a cell may legally read `a \| b`.
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  function sepToAlign(cell) {
    const c = cell.trim();
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  }

  function parseMarkdown(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let start = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].includes('|') && SEP_LINE.test(lines[i + 1])) { start = i; break; }
    }
    if (start < 0) return null;

    const header = splitPipeRow(lines[start]).map(inlineMdToHtml);
    const aligns = splitPipeRow(lines[start + 1]).map(sepToAlign);
    const bodyRows = [];
    for (let i = start + 2; i < lines.length; i++) {
      if (!lines[i].trim() || !lines[i].includes('|')) break;
      bodyRows.push(splitPipeRow(lines[i]).map(inlineMdToHtml));
    }

    const model = normalizeWidth({
      header: true,
      cols: header.map((_, i) => makeCol(aligns[i])),
      rows: [header, ...bodyRows],
    });
    return model;
  }

  /* ------------------------------------------------------------ html input */

  function parseHtml(text) {
    const doc = new DOMParser().parseFromString(String(text || ''), 'text/html');
    const table = doc.querySelector('table');
    if (!table) return null;
    const trs = [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
    if (!trs.length) return null;

    const rows = trs.map((tr) => [...tr.children].filter((c) => /^(td|th)$/i.test(c.tagName)));
    const hasHeaderTag = rows.some((r) => r.some((c) => c.tagName.toLowerCase() === 'th'));

    const first = rows[0] || [];
    const cols = first.map((c) => {
      const style = c.getAttribute('style') || '';
      const alignM = /text-align\s*:\s*(left|center|right)/i.exec(style);
      const widthM = /width\s*:\s*([\d.]+)px/i.exec(style);
      const align = (alignM && alignM[1]) || c.getAttribute('align') || 'left';
      return makeCol(align, widthM ? Math.round(parseFloat(widthM[1])) : null);
    });

    const model = normalizeWidth({
      header: hasHeaderTag || rows.length > 1,
      cols,
      rows: rows.map((r) => r.map((c) => sanitizeCellHtml(c.innerHTML))),
    });
    return model;
  }

  /* ------------------------------------------------------------- jsx input */
  // Reuses mdx-table.js's own parser rather than writing a second one — see
  // CLAUDE.md: "add a feature to the shared passes, not a reader."

  function parseJsx(text) {
    if (!window.mdxTable) return null;
    const parsed = window.mdxTable.parseTable(text);
    if (!parsed || !parsed.rows.length) return null;

    const alignMatch = /align\s*=\s*\{\s*\[([^\]]*)\]\s*\}/.exec(parsed.attrs || '');
    const topAligns = alignMatch
      ? alignMatch[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
      : [];

    const width = Math.max(...parsed.rows.map((r) => r.cells.length));
    const firstAttrs = parsed.rows[0].attrs || [];
    const cols = Array.from({ length: width }, (_, i) => {
      const cellAttrs = firstAttrs[i] || '';
      const alignM = /textAlign\s*:\s*["']?(left|center|right)/i.exec(cellAttrs);
      const widthM = /\bwidth\s*:\s*["']?(\d+)(?:px)?/i.exec(cellAttrs);
      return makeCol(topAligns[i] || (alignM && alignM[1]), widthM ? parseInt(widthM[1], 10) : null);
    });

    const rows = parsed.rows.map((r) => r.cells.map((src) => jsxCellToHtml(src)));
    const model = normalizeWidth({
      header: parsed.rows[0].header,
      cols,
      rows,
    });
    return model;
  }

  // Raw JSX cell source -> the same normalized markdown-ish text ReadMe's own
  // editor would have written -> HTML for the contenteditable grid. Reusing
  // mdx-table's cell parser means a table with a list or a broken tag in a
  // cell still loads instead of failing; the list itself is flattened to line
  // breaks here (this editor's cells are single-line rich text, not blocks).
  function jsxCellToHtml(src) {
    const stats = { repairedTags: 0, droppedBreaks: 0 };
    const blocks = window.mdxTable.parseCell(src, stats);
    const text = window.mdxTable.renderCell(blocks).replace(/\n+/g, ' ');
    return inlineMdToHtml(text);
  }

  /* --------------------------------------------------------- legacy input */
  // The old [block:parameters] format ReadMe's editor stopped writing years
  // ago, but still deserializes for backward compatibility — real customer
  // content still has it. Reading it here is migration, not support: nothing
  // in this file ever emits it again.

  function parseMagicBlock(text) {
    const m = /\[block:parameters\]\s*([\s\S]*?)\s*\[\/block\]/.exec(String(text || ''));
    if (!m) return null;
    let json;
    try { json = JSON.parse(m[1]); } catch (e) { return null; }
    const { data, cols, rows, align } = json || {};
    if (!data || !cols || rows === undefined) return null;

    const colsArr = Array.from({ length: cols }, (_, i) => makeCol(align && align[i]));
    const header = [];
    for (let c = 0; c < cols; c++) {
      header.push(inlineMdToHtml(stripLegacyHeaderBold(String(data['h-' + c] || ''))));
    }
    const body = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) row.push(inlineMdToHtml(String(data[r + '-' + c] || '')));
      body.push(row);
    }
    return normalizeWidth({ header: true, cols: colsArr, rows: [header, ...body] });
  }

  // The legacy tool wrote every header as **bold**; showing that literally in
  // an already-bold header row would double it.
  function stripLegacyHeaderBold(t) {
    const m = /^\*\*([\s\S]+)\*\*$/.exec(t.trim());
    return m ? m[1] : t;
  }

  /* --------------------------------------------------- inline conversions */

  // Plain markdown-ish text -> the small HTML whitelist. Code spans are
  // pulled out first so formatting markers and HTML escaping never look
  // inside one — `` `**not bold**` `` must stay literal.
  function inlineMdToHtml(text) {
    const codeStore = [];
    let t = String(text || '').replace(/`([^`\n]+)`/g, (m, c) => {
      codeStore.push(c);
      return '' + (codeStore.length - 1) + '';
    });
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    t = t.replace(/<br\s*\/?>/gi, '<br>'); // survives the escaping above unaffected; kept for clarity
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, '<em>$1</em>');
    t = t.replace(/(?<![_\w])_([^_]+)_(?![_\w])/g, '<em>$1</em>');
    t = t.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label, href) =>
      '<a href="' + href.replace(/"/g, '&quot;') + '">' + label + '</a>');
    t = t.replace(/\\([\\`*_\[\]<>{}|])/g, '$1'); // unescape what Markdown escaped
    t = t.replace(/(\d+)/g, (m, n) =>
      '<code>' + codeStore[+n].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code>');
    return t;
  }

  // Real DOM (from parsed HTML, or a live contenteditable cell) -> the
  // whitelist. Everything not on it is unwrapped to its text, not dropped —
  // losing a customer's words is worse than losing their <span> styling.
  function sanitizeCellHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html || '');
    const out = walkToHtml(tmp);
    return out.replace(/^(<br>)+|(<br>)+$/g, '').trim();
  }

  function walkToHtml(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === 'br') { out += '<br>'; continue; }
      const inner = walkToHtml(child);
      if (tag === 'strong' || tag === 'b') out += '<strong>' + inner + '</strong>';
      else if (tag === 'em' || tag === 'i') out += '<em>' + inner + '</em>';
      else if (tag === 'code') out += '<code>' + inner + '</code>';
      else if (tag === 'a') {
        const href = child.getAttribute('href') || '';
        out += href ? '<a href="' + href.replace(/"/g, '&quot;') + '">' + inner + '</a>' : inner;
      } else if (tag === 'p' || tag === 'div' || tag === 'li') {
        out += (out ? '<br>' : '') + inner;
      } else {
        out += inner; // span, font, and anything else: unwrap, keep the text
      }
    }
    return out;
  }

  // One walk, three sets of tag handlers — used by all three output
  // renderers so a bug in the walk itself only has to be fixed once.
  function walkCell(html, h) {
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html || '');
    const rec = (node) => {
      let out = '';
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += h.text(child.nodeValue); continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toLowerCase();
        if (tag === 'br') { out += h.br(); continue; }
        const inner = rec(child);
        if (tag === 'strong' || tag === 'b') out += h.strong(inner);
        else if (tag === 'em' || tag === 'i') out += h.em(inner);
        else if (tag === 'code') out += h.code(inner);
        else if (tag === 'a') out += h.link(inner, child.getAttribute('href') || '');
        else out += inner;
      }
      return out;
    };
    return rec(tmp);
  }

  const mdxSafe = (t) => (window.mdClean ? window.mdClean.escapeStrayTags(t, {}) : t);

  function cellToMarkdown(html) {
    return walkCell(html, {
      text: (t) => mdxSafe(t).replace(/\|/g, '\\|'),
      br: () => '<br>',
      strong: (i) => '**' + i + '**',
      em: (i) => '*' + i + '*',
      code: (i) => '`' + i + '`',
      link: (i, href) => '[' + i + '](' + href + ')',
    }).trim() || ' ';
  }

  function cellToJsx(html) {
    return walkCell(html, {
      text: (t) => mdxSafe(t),
      br: () => '<br />',
      strong: (i) => '**' + i + '**',
      em: (i) => '*' + i + '*',
      code: (i) => '`' + i + '`',
      link: (i, href) => '[' + i + '](' + href + ')',
    }).trim();
  }

  function cellToHtmlBlock(html) {
    return walkCell(html, {
      text: (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      br: () => '<br>',
      strong: (i) => '<strong>' + i + '</strong>',
      em: (i) => '<em>' + i + '</em>',
      code: (i) => '<code>' + i + '</code>',
      link: (i, href) => '<a href="' + href.replace(/"/g, '&quot;') + '">' + i + '</a>',
    }).trim();
  }

  /* -------------------------------------------------------------- output */

  function renderMarkdown(model) {
    const rows = model.rows;
    if (!rows.length) return '';
    const cells = rows.map((r) => r.map(cellToMarkdown));
    const width = model.cols.length;
    const sep = model.cols.map((c) =>
      c.align === 'center' ? ':---:' : c.align === 'right' ? '---:' : '---');
    const line = (r) => '| ' + r.join(' | ') + ' |';
    const out = [line(cells[0]), line(sep)];
    for (let i = 1; i < cells.length; i++) out.push(line(cells[i]));
    if (cells.length === 1) out.push(line(Array(width).fill(' ')));
    return out.join('\n');
  }

  const IND = '  ';

  function renderJsx(model, includeWidth) {
    if (includeWidth === undefined) includeWidth = true; // default for direct/programmatic callers
    const cells = model.rows.map((r) => r.map(cellToJsx));
    const align = model.cols.map((c) => '"' + c.align + '"').join(', ');
    const cellStyle = (col) => {
      const parts = ['textAlign: "' + model.cols[col].align + '"'];
      if (includeWidth && model.cols[col].width) parts.push('width: "' + model.cols[col].width + 'px"');
      return ' style={{ ' + parts.join(', ') + ' }}';
    };
    const section = (rowIdx, tag) => {
      const lines = [];
      rowIdx.forEach((ri, n) => {
        if (n) lines.push('');
        lines.push(IND + IND + '<tr>');
        cells[ri].forEach((cellText, ci) => {
          if (ci) lines.push('');
          lines.push(IND + IND + IND + '<' + tag + cellStyle(ci) + '>');
          lines.push(IND + IND + IND + IND + (cellText || ' '));
          lines.push(IND + IND + IND + '</' + tag + '>');
        });
        lines.push(IND + IND + '</tr>');
      });
      return lines;
    };

    const out = ['<Table align={[' + align + ']}>'];
    if (model.header) {
      out.push(IND + '<thead>');
      out.push(...section([0], 'th'));
      out.push(IND + '</thead>');
    }
    const bodyIdx = model.rows.map((_, i) => i).filter((i) => !model.header || i > 0);
    if (bodyIdx.length) {
      if (model.header) out.push('');
      out.push(IND + '<tbody>');
      out.push(...section(bodyIdx, 'td'));
      out.push(IND + '</tbody>');
    }
    out.push('</Table>');
    return out.join('\n');
  }

  function renderHtmlBlock(model) {
    const cells = model.rows.map((r) => r.map(cellToHtmlBlock));
    const cellStyle = (col, isHeader) => {
      const parts = [
        'border:1px solid #d0d7de', 'padding:8px 12px',
        'text-align:' + model.cols[col].align,
        'vertical-align:top',
      ];
      if (model.cols[col].width) parts.push('width:' + model.cols[col].width + 'px');
      if (isHeader) parts.push('background:#f6f8fa', 'font-weight:600');
      return parts.join(';');
    };
    const rowHtml = (ri, tag, isHeader) =>
      '  <tr>\n' + cells[ri].map((c, ci) =>
        '    <' + tag + ' style="' + cellStyle(ci, isHeader) + '">' + (c || '&nbsp;') + '</' + tag + '>').join('\n') +
      '\n  </tr>';

    const out = ['<table style="width:100%;border-collapse:collapse;">'];
    if (model.header) {
      out.push('<thead>');
      out.push(rowHtml(0, 'th', true));
      out.push('</thead>');
    }
    const bodyIdx = model.rows.map((_, i) => i).filter((i) => !model.header || i > 0);
    if (bodyIdx.length) {
      out.push('<tbody>');
      bodyIdx.forEach((ri) => out.push(rowHtml(ri, 'td', false)));
      out.push('</tbody>');
    }
    out.push('</table>');
    return out.join('\n');
  }

  const api = {
    ALIGNS, makeCol, emptyModel, demoModel, cloneModel, normalizeWidth,
    detectFormat, parseAny, parseMarkdown, parseHtml, parseJsx, parseMagicBlock,
    inlineMdToHtml, sanitizeCellHtml,
    renderMarkdown, renderJsx, renderHtmlBlock,
  };
  window.tableWizard = api;

  /* ==================================================================== */
  /* UI — only wires up if the page actually has the Tables panel. Keeping */
  /* every DOM query behind this guard is what lets harness.js load this   */
  /* file unconditionally in the test suite, the way it already does for   */
  /* mdx-table.js.                                                          */
  /* ==================================================================== */

  const root = typeof document !== 'undefined' ? document.getElementById('twRoot') : null;
  if (!root) return;

  const $ = (id) => document.getElementById(id);
  let model = emptyModel();
  let activeFmt = 'md';

  function setModel(next) {
    model = normalizeWidth(next);
    renderGrid();
    updateOutputs();
  }

  /* -------------------------------------------------------------- input */

  $('twLoadBtn').addEventListener('click', () => {
    const text = $('twPaste').value;
    const { format, model: parsed } = parseAny(text);
    if (!parsed) {
      $('twDetected').textContent = text.trim()
        ? "Could not find a table — checked for Markdown, HTML, ReadMe <Table>, and legacy [block:parameters]."
        : '';
      $('twDetected').className = 'hint err';
      return;
    }
    const label = { markdown: 'Markdown table', html: 'HTML table', jsx: 'ReadMe <Table> JSX',
                    magic: 'legacy [block:parameters] block — migrated, not preserved' }[format];
    $('twDetected').textContent = 'Loaded: ' + label + ' (' + parsed.cols.length + ' columns, ' +
      (parsed.rows.length - (parsed.header ? 1 : 0)) + ' data row(s)).';
    $('twDetected').className = 'hint';
    setModel(parsed);
  });

  $('twDemoBtn').addEventListener('click', () => {
    $('twPaste').value = '';
    $('twDetected').textContent = '';
    setModel(demoModel());
  });

  $('twHeader').addEventListener('change', () => {
    model.header = $('twHeader').checked;
    renderGrid();
    updateOutputs();
  });

  $('twAddRow').addEventListener('click', () => {
    model.rows.push(model.cols.map(() => ''));
    renderGrid();
    updateOutputs();
  });

  $('twAddCol').addEventListener('click', () => {
    model.cols.push(makeCol());
    model.rows.forEach((r) => r.push(''));
    renderGrid();
    updateOutputs();
  });

  /* --------------------------------------------------------- formatting */
  // execCommand is deprecated but still the only one-line way to toggle
  // bold/italic on a live selection across current browsers; code/link use a
  // manual Range wrap since there is no execCommand for either.

  let lastFocusedCell = null;
  function withSelection(fn) {
    if (!lastFocusedCell) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !lastFocusedCell.contains(sel.anchorNode)) return;
    fn(sel);
    lastFocusedCell.dispatchEvent(new Event('input', { bubbles: true }));
  }

  $('twBold').addEventListener('click', () => withSelection(() => document.execCommand('bold')));
  $('twItalic').addEventListener('click', () => withSelection(() => document.execCommand('italic')));
  $('twCode').addEventListener('click', () => withSelection((sel) => {
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    const code = document.createElement('code');
    try { range.surroundContents(code); } catch (e) { /* selection crosses tags — skip */ }
  }));
  $('twLink').addEventListener('click', () => withSelection((sel) => {
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    const href = prompt('Link URL:', 'https://');
    if (!href) return;
    const a = document.createElement('a');
    a.href = href;
    try { range.surroundContents(a); } catch (e) { /* selection crosses tags — skip */ }
  }));

  /* ----------------------------------------------------------- the grid */

  function renderGrid() {
    const grid = $('twGrid');
    grid.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'twtable';

    const headRow = document.createElement('tr');
    model.cols.forEach((col, ci) => headRow.append(buildHeaderCell(col, ci)));
    headRow.append(buildCornerCell('col'));
    table.append(headRow);

    let dataIndex = -1;
    model.rows.forEach((row, ri) => {
      const isHeaderRow = model.header && ri === 0;
      if (!isHeaderRow) dataIndex++;
      const tr = document.createElement('tr');
      tr.className = 'twrow' + (isHeaderRow ? ' twhead' : '') + (dataIndex % 2 === 1 ? ' twalt' : '');
      row.forEach((cellHtml, ci) => tr.append(buildCell(cellHtml, ri, ci, isHeaderRow)));
      tr.append(buildRowHandle(ri));
      table.append(tr);
    });

    grid.append(table);
  }

  // The six-dot grip is the same icon Notion/Linear/Trello use for a drag
  // handle — recognisable at a glance, unlike a Unicode braille character,
  // which renders thin and low-contrast in most UI fonts.
  const GRIP_SVG = '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
    '<circle cx="2.5" cy="2.5" r="1.5"/><circle cx="7.5" cy="2.5" r="1.5"/>' +
    '<circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/>' +
    '<circle cx="2.5" cy="13.5" r="1.5"/><circle cx="7.5" cy="13.5" r="1.5"/></svg>';

  function makeGripButton(title, onMouseDown) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'twgripbtn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = GRIP_SVG;
    btn.addEventListener('mousedown', onMouseDown);
    return btn;
  }

  function buildHeaderCell(col, ci) {
    const th = document.createElement('th');
    th.className = 'twcolhead';
    if (col.width) th.style.width = col.width + 'px';

    // Two fixed rows (controls, then width) rather than letting these wrap
    // inline — inline wrapping is what made narrow columns stagger their
    // controls onto a different line than wide ones.
    const top = document.createElement('div');
    top.className = 'twctrl-top';
    top.append(makeGripButton('Drag to reorder this column', (e) => startColDrag(e, ci)));

    const aligns = document.createElement('span');
    aligns.className = 'twaligns';
    ALIGNS.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'twalignbtn' + (col.align === a ? ' on' : '');
      b.title = a[0].toUpperCase() + a.slice(1) + '-align this column';
      b.textContent = { left: '⟸', center: '≡', right: '⟹' }[a];
      b.addEventListener('click', () => { model.cols[ci].align = a; renderGrid(); updateOutputs(); });
      aligns.append(b);
    });
    top.append(aligns);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'twrm';
    rm.innerHTML = '&times;';
    rm.title = 'Remove column';
    rm.disabled = model.cols.length <= 1;
    rm.addEventListener('click', () => {
      if (model.cols.length <= 1) return;
      model.cols.splice(ci, 1);
      model.rows.forEach((r) => r.splice(ci, 1));
      renderGrid();
      updateOutputs();
    });
    top.append(rm);
    th.append(top);

    const widthRow = document.createElement('div');
    widthRow.className = 'twctrl-width';
    const widthInput = document.createElement('input');
    widthInput.type = 'number';
    widthInput.min = '40';
    widthInput.placeholder = 'auto';
    widthInput.value = col.width || '';
    widthInput.title = 'Column width in pixels';

    // The editor keeps room for its own controls (drag handle, align
    // buttons, this input), so a column set narrower than that shows here
    // wider than it will actually render. Rather than let that misrepresent
    // the real width, say so — the Preview modal is where the true width
    // shows.
    const widthNote = document.createElement('span');
    widthNote.className = 'twwidthnote';
    widthNote.textContent = 'renders narrower — see Preview';
    widthNote.title = 'The editor can’t display a column this narrow — its own controls need more room than that. Click Preview to see the true width.';
    widthNote.hidden = true;
    const refreshWidthNote = () => {
      const w = model.cols[ci].width;
      widthNote.hidden = !(w && w < EDITOR_MIN_COL_DISPLAY);
    };
    refreshWidthNote();

    widthInput.addEventListener('input', () => {
      const v = parseInt(widthInput.value, 10);
      model.cols[ci].width = v > 0 ? v : null;
      th.style.width = model.cols[ci].width ? model.cols[ci].width + 'px' : '';
      refreshWidthNote();
      updateOutputs();
    });
    widthRow.append(widthInput, document.createTextNode('px'), widthNote);
    th.append(widthRow);

    const resizer = document.createElement('span');
    resizer.className = 'twresizer';
    resizer.title = 'Drag to resize this column';
    resizer.addEventListener('mousedown', (e) => startResize(e, ci, th, widthInput, refreshWidthNote));
    th.append(resizer);

    return th;
  }

  function buildCornerCell() {
    const th = document.createElement('th');
    th.className = 'twcorner';
    return th;
  }

  // Below this, the editor's own header controls no longer fit — see the
  // widthNote wired up in buildHeaderCell.
  const EDITOR_MIN_COL_DISPLAY = 150;

  function startResize(e, ci, th, widthInput, refreshWidthNote) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = th.getBoundingClientRect().width;
    const onMove = (ev) => {
      const w = Math.max(40, Math.round(startWidth + (ev.clientX - startX)));
      th.style.width = w + 'px';
      widthInput.value = w;
      model.cols[ci].width = w;
      refreshWidthNote();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const w = parseInt(widthInput.value, 10);
      model.cols[ci].width = w > 0 ? w : null;
      updateOutputs();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // Column and row reorder use plain mouse tracking, not HTML5 drag-and-drop —
  // dragstart/dragover/drop need real OS drag gestures and never fire from
  // synthetic mouse events, which also makes plain tracking the only kind
  // that is testable end-to-end. Mirrors startResize's approach above.
  function startColDrag(e, ci) {
    e.preventDefault();
    const heads = () => [...document.querySelectorAll('#twGrid .twcolhead')];
    let target = ci;
    const onMove = (ev) => {
      target = ci;
      for (const [i, cell] of heads().entries()) {
        const r = cell.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX < r.right) { target = i; break; }
      }
      heads().forEach((c, i) => c.classList.toggle('twdragover', i === target && i !== ci));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      heads().forEach((c) => c.classList.remove('twdragover'));
      if (target !== ci) {
        const [col] = model.cols.splice(ci, 1);
        model.cols.splice(target, 0, col);
        model.rows.forEach((r) => { const [c] = r.splice(ci, 1); r.splice(target, 0, c); });
        renderGrid();
        updateOutputs();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startRowDrag(e, ri) {
    e.preventDefault();
    const trs = () => [...document.querySelectorAll('#twGrid tr.twrow')];
    let target = ri;
    const onMove = (ev) => {
      target = ri;
      for (const [i, row] of trs().entries()) {
        const r = row.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY < r.bottom) { target = i; break; }
      }
      trs().forEach((row, i) => row.classList.toggle('twdragover', i === target && i !== ri));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      trs().forEach((row) => row.classList.remove('twdragover'));
      if (target !== ri) {
        const [row] = model.rows.splice(ri, 1);
        model.rows.splice(target, 0, row);
        renderGrid();
        updateOutputs();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function buildCell(cellHtml, ri, ci, isHeaderRow) {
    const cellTag = isHeaderRow ? 'th' : 'td';
    const cell = document.createElement(cellTag);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.className = 'tweditable';
    editable.style.textAlign = model.cols[ci].align;
    editable.innerHTML = cellHtml;
    editable.addEventListener('focus', () => { lastFocusedCell = editable; });
    editable.addEventListener('input', () => {
      model.rows[ri][ci] = sanitizeCellHtml(editable.innerHTML);
      updateOutputs();
    });
    // Sanitizing on every keystroke would fight the caret; do it once the
    // cell is done being typed in, when losing cursor position no longer matters.
    editable.addEventListener('blur', () => {
      const clean = sanitizeCellHtml(editable.innerHTML);
      model.rows[ri][ci] = clean;
      if (editable.innerHTML !== clean) editable.innerHTML = clean;
    });
    editable.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });
    cell.append(editable);
    return cell;
  }

  function buildRowHandle(ri) {
    const td = document.createElement('td');
    td.className = 'twrowhandle';
    td.append(makeGripButton('Drag to reorder this row', (e) => startRowDrag(e, ri)));

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'twrm';
    rm.innerHTML = '&times;';
    rm.title = 'Remove row';
    rm.disabled = model.rows.length <= 1;
    rm.addEventListener('click', () => {
      if (model.rows.length <= 1) return;
      model.rows.splice(ri, 1);
      renderGrid();
      updateOutputs();
    });
    td.append(rm);
    return td;
  }

  /* ---------------------------------------------------------- output tab */

  // The only documented prop on ReadMe's <Table> is `align` — confirmed
  // against ReadMe's own editor code, which has no width field anywhere.
  // `align` is therefore the default, "supported" JSX output; width is an
  // opt-in extra for people who understand it may not survive a re-edit.
  let includeJsxWidth = false;

  function jsxNote() {
    return includeJsxWidth
      ? 'Width is now included as inline style — it renders, but nothing in ReadMe’s schema guarantees it survives if this table is edited again in ReadMe’s visual editor.'
      : 'Paste directly into ReadMe’s editor — renders live. Only `align` is included: it’s the one prop ReadMe’s <Table> actually documents, so it always survives.';
  }

  const OUTPUT_NOTE = {
    md: () => 'Alignment survives (GFM colon syntax). Width has no representation in Markdown — no pipe table has ever had one.',
    jsx: jsxNote,
    html: () => 'Paste into a ReadMe Custom HTML block. Width and alignment are both real CSS and will not be stripped — but the block shows as source in the editor, not a live table, until published.',
  };

  document.querySelectorAll('#twTabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#twTabs button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      activeFmt = b.dataset.fmt;
      $('twJsxOpt').hidden = activeFmt !== 'jsx';
      updateOutputs();
    });
  });

  $('twIncludeWidth').addEventListener('change', () => {
    includeJsxWidth = $('twIncludeWidth').checked;
    updateOutputs();
  });

  function currentOutput() {
    if (activeFmt === 'jsx') return renderJsx(model, includeJsxWidth);
    if (activeFmt === 'html') return renderHtmlBlock(model);
    return renderMarkdown(model);
  }

  function updateOutputs() {
    $('twOutput').textContent = currentOutput();
    $('twOutputNote').textContent = OUTPUT_NOTE[activeFmt]();
    $('twOutputNote').classList.toggle('warn', activeFmt === 'jsx' && includeJsxWidth);
  }

  $('twCopyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentOutput());
      $('twCopyStatus').textContent = 'Copied.';
    } catch (e) {
      $('twCopyStatus').textContent = 'Could not copy — select the text above and copy manually.';
    }
    setTimeout(() => { $('twCopyStatus').textContent = ''; }, 2500);
  });

  /* ------------------------------------------------------------- preview */
  // Built straight from the model, not routed through the Markdown text —
  // Markdown has no width, so that path could only ever show alignment. This
  // sets real widths on real <th>/<td> elements via the CSSOM `style`
  // property, which is how the editable grid's own columns are already
  // sized (see startResize above) and is unaffected by this page's CSP:
  // style-src blocks a parsed style="" attribute, not a script setting
  // el.style.width directly. So what opens here is the table itself, at the
  // widths and alignment actually configured — not an approximation of it.
  function buildPreviewTable(m) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-tablewrap';
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');

    m.rows.forEach((row, ri) => {
      const isHeaderRow = m.header && ri === 0;
      const tr = document.createElement('tr');
      row.forEach((cellHtml, ci) => {
        const col = m.cols[ci] || makeCol();
        const cell = document.createElement(isHeaderRow ? 'th' : 'td');
        cell.style.textAlign = col.align;
        if (col.width) cell.style.width = col.width + 'px';
        cell.innerHTML = cellHtml; // this tool's own whitelist HTML only — no styles inside it
        tr.append(cell);
      });
      (isHeaderRow ? thead : tbody).append(tr);
    });
    if (thead.children.length) table.append(thead);
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }

  let twPreviewOpener = null;
  function openTwPreview() {
    const body = $('twPreviewBody');
    body.innerHTML = '';
    body.append(buildPreviewTable(model));
    $('twPreviewModal').hidden = false;
    document.body.style.overflow = 'hidden';
    twPreviewOpener = document.activeElement;
    $('twPreviewClose').focus();
  }
  function closeTwPreview() {
    if ($('twPreviewModal').hidden) return;
    $('twPreviewModal').hidden = true;
    document.body.style.overflow = '';
    const back = (twPreviewOpener && twPreviewOpener !== document.body && twPreviewOpener.focus)
      ? twPreviewOpener : $('twPreviewBtn');
    if (back && back.focus) back.focus();
    twPreviewOpener = null;
  }
  $('twPreviewBtn').addEventListener('click', openTwPreview);
  $('twPreviewClose').addEventListener('click', closeTwPreview);
  $('twPreviewModal').addEventListener('click', (e) => { if (e.target.id === 'twPreviewModal') closeTwPreview(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTwPreview(); });

  /* ------------------------------------------------------------- app nav */

  const docShell = $('docShell');
  $('navDocs').addEventListener('click', () => {
    $('navDocs').classList.add('on');
    $('navTables').classList.remove('on');
    docShell.hidden = false;
    root.hidden = true;
  });
  $('navTables').addEventListener('click', () => {
    $('navTables').classList.add('on');
    $('navDocs').classList.remove('on');
    docShell.hidden = true;
    root.hidden = false;
  });

  renderGrid();
  updateOutputs();
}());
