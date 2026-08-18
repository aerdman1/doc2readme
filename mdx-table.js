/* mdx-table.js — rebuild a ReadMe MDX <Table> whose cells are broken HTML.
 *
 * ReadMe's editor promotes a table to `<Table>` JSX the moment any cell holds
 * block content, and it writes Markdown inside `<td>`. But it *preserves* any
 * `<ul>/<li>` it finds there verbatim, so a table that arrived from the legacy
 * (RDMD) compatibility migration keeps whatever HTML that migration inlined —
 * `tableListsToInlineHtml()` renders the cell to HTML and strips the newlines.
 * Hand-editing that soup is how it ends up with unclosed `</li`, a `<ul>` typed
 * where `</ul>` was meant, `<br />` used as list spacing, and truncated tags.
 *
 * That still renders, badly, and it is nearly uneditable. This turns it back
 * into what ReadMe's own editor would have written: Markdown lists inside
 * `<td>`, one blank line between blocks, nesting by two spaces.
 *
 * Two rules from ReadMe's own serializer are reproduced deliberately:
 *   - a table whose every cell is inline-only becomes a GFM pipe table;
 *     anything else stays `<Table>`. (Their test names it "serializes to GFM
 *     when all cells are phrasing-only".) Emitting the form the editor would
 *     emit means the next human save produces no diff.
 *   - `<Table>` layout is 2-space steps with a blank line between siblings.
 *
 * It cannot invent content. Where the source HTML was truncated so badly that
 * text was lost, the text stays lost — the cleaner reports the count of tags it
 * had to repair so a human knows to read the result.
 *
 * Everything is inside one IIFE: classic scripts share a global scope, and
 * names like `tokenize` would collide with a future file (build.py fails the
 * build on that, which is how it was caught before).
 */
'use strict';

(function () {
  // Inline tags with a Markdown spelling. Anything else closable is passed
  // through as-is: valid MDX once it is actually closed, which is the point.
  const INLINE_MD = { b: '**', strong: '**', i: '*', em: '*', code: '`' };

  const LIST_TAGS = new Set(['ul', 'ol']);
  // Tags that end a paragraph rather than decorate text.
  const BLOCK_TAGS = new Set(['p', 'div', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'source', 'wbr', 'area', 'input']);
  // Table skeleton — never meaningful *inside* a cell, so drop it if it leaks in.
  const TABLE_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
                              'colgroup']);

  /* Code is masked out before anything else looks at the cell.
   *
   * Two reasons, both load bearing. A code span can legally contain `<` — a
   * cell reading `` `<YOUR_TOKEN>` `` must not have that tokenized as a tag —
   * and collapsing whitespace inside code changes the code. MDX does not look
   * inside a fence or a span either, so masking here matches how it is read. */
  const MARK = '\u0001';
  const PLACEHOLDER = new RegExp(MARK + '(\\d+)' + MARK);
  const PLACEHOLDER_G = new RegExp(MARK + '(\\d+)' + MARK, 'g');
  const FENCE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/g;
  const CODE_SPAN = /`+[^`\n]*`+/g;

  function maskCode(src, store) {
    let out = String(src).replace(FENCE, (m, pre) => {
      store.push({ fence: true, text: m.slice(pre.length).replace(/^[ \t]+/, '') });
      return pre + MARK + (store.length - 1) + MARK;
    });
    out = out.replace(CODE_SPAN, (m) => {
      store.push({ fence: false, text: m });
      return MARK + (store.length - 1) + MARK;
    });
    return out;
  }

  const unmask = (text, store) =>
    String(text).replace(PLACEHOLDER_G, (m, n) => (store[+n] ? store[+n].text : m));

  // Cell source arrives indented to its column in the JSX. A fence has to start
  // at column 0 to be recognised as one, so strip the common indent first.
  function dedent(src) {
    const lines = String(src).replace(/\t/g, '    ').split('\n');
    const widths = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length);
    const cut = widths.length ? Math.min(...widths) : 0;
    return lines.map((l) => l.slice(cut)).join('\n');
  }

  /* ---------------------------------------------------------------- tokenizer */

  // A closer's `>` is optional on purpose: `</li   <li>` and a `</st` truncated
  // mid-tag both appear in real migrated tables, and both must still close.
  // Two patterns, not one with `>?`: a truncated closer must consume its name
  // and nothing else, or it eats the blank line behind it and the paragraph
  // break that blank line represents is lost.
  const TAG_CLOSE = /^<\/[ \t]*([A-Za-z][A-Za-z0-9]*)[ \t]*>/;
  // No `\s*` before the name: `</` followed by a blank line and the word
  // "After" must not read "After" as the tag it was closing.
  const TAG_CLOSE_TRUNC = /^<\/([A-Za-z][A-Za-z0-9]*)/;
  const TAG_DANGLE = /^<\/(?![A-Za-z])[ \t]*>?/;
  const TAG_OPEN = /^<([A-Za-z][A-Za-z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/;

  function tokenize(src) {
    const out = [];
    let text = '';
    let i = 0;
    const flush = () => { if (text) { out.push({ kind: 'text', text }); text = ''; } };

    while (i < src.length) {
      if (src[i] !== '<') { text += src[i++]; continue; }
      const rest = src.slice(i);
      let m = TAG_CLOSE.exec(rest) || TAG_CLOSE_TRUNC.exec(rest);
      if (m) {
        flush();
        out.push({ kind: 'close', name: m[1].toLowerCase() });
        i += m[0].length;
        continue;
      }
      m = TAG_DANGLE.exec(rest);
      if (m) { flush(); i += m[0].length; continue; }
      m = TAG_OPEN.exec(rest);
      if (m) {
        flush();
        out.push({
          kind: 'open',
          name: m[1].toLowerCase(),
          attrs: m[2] || '',
          selfClose: !!m[3],
          raw: m[0],
        });
        i += m[0].length;
        continue;
      }
      // A bare `<` in prose. Leave it; escaping is md-clean's job.
      text += src[i++];
    }
    flush();
    return out;
  }

  /**
   * Markdown list lines in a cell become the same `<ul>/<li>` the HTML path
   * takes, so there is one list implementation rather than two.
   *
   * This is not a nicety. ReadMe's editor writes Markdown lists inside `<td>`,
   * so a table that is *already* correct arrives looking like this — flattening
   * it into one paragraph would demote a good table to a pipe table and lose
   * the list. It also matches the editor's own reading of a cell: a leading `-`
   * is a list marker there, even though CommonMark says otherwise in GFM.
   */
  const LIST_LINE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

  function markdownListsToHtml(src) {
    const out = [];
    const stack = [];                    // [{ col, ordered }]
    const lines = String(src).split('\n');
    const closeTo = (depth) => {
      while (stack.length > depth) {
        const s = stack.pop();
        out.push('</li>' + (s.ordered ? '</ol>' : '</ul>'));
      }
    };

    lines.forEach((line, n) => {
      const m = LIST_LINE.exec(line);
      if (m) {
        const col = m[1].replace(/\t/g, '    ').length;
        const ordered = /\d/.test(m[2]);
        if (!stack.length || col > stack[stack.length - 1].col) {
          // Deeper: the enclosing `<li>` is still open, so this list nests in it.
          out.push(ordered ? '<ol>' : '<ul>');
          stack.push({ col, ordered });
        } else {
          while (stack.length > 1 && col < stack[stack.length - 1].col) closeTo(stack.length - 1);
          out.push('</li>');
        }
        out.push('<li>' + m[3]);
        return;
      }
      if (!line.trim()) {
        // A blank line inside a list is a loose list, not the end of one; only
        // prose ends it. Look ahead for the next thing that is not blank.
        const next = lines.slice(n + 1).find((l) => l.trim());
        if (stack.length && next && LIST_LINE.test(next)) return;
        closeTo(0);
        out.push('');
        return;
      }
      if (stack.length && /^[ \t]+\S/.test(line)) {
        // An indented continuation line belongs to the item above it.
        out.push(' ' + line.trim());
        return;
      }
      closeTo(0);
      out.push(line);
    });
    closeTo(0);
    return out.join('\n');
  }

  /* ------------------------------------------------------------- cell parsing */

  /**
   * Is this opening list tag really a mistyped closer?
   *
   * `<ul><li>a</li><br /><ul>` — that trailing `<ul>` was meant to be `</ul>`.
   * The tell is that nothing follows it before the next structural tag, so it
   * opens a list that never gets an item. A genuine `<ul>` is followed by `<li>`.
   */
  function opensNothing(tokens, from) {
    for (let i = from + 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === 'text') {
        if (t.text.trim()) return true;   // text directly in a list is not an item
        continue;
      }
      if (t.name === 'br') continue;
      return !(t.kind === 'open' && t.name === 'li');
    }
    return true;                          // end of cell: it opened nothing at all
  }

  /**
   * After a blank line, is the list still going?
   *
   * The migration emitted each list as one line with the newlines stripped, so
   * a blank line inside a cell is a paragraph boundary rather than list spacing
   * — unless the next thing is another item, which is how a hand-edited cell
   * ends up with `</li>`, a blank line, and then `<li>` again.
   */
  function listContinues(tokens, from, chunks, n) {
    for (let k = n; k < chunks.length; k++) if (chunks[k].trim()) return false;
    for (let i = from + 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.kind === 'text') {
        if (t.text.trim()) return false;
        continue;
      }
      if (t.name === 'br') continue;
      return t.kind === 'open' && (t.name === 'li' || LIST_TAGS.has(t.name));
    }
    return false;
  }

  // A stray `</b>` where `<b>` was meant, recoverable only if the real closer
  // is still ahead of us.
  function closerAppearsLater(tokens, from, name) {
    for (let i = from + 1; i < tokens.length; i++) {
      if (tokens[i].kind === 'close' && tokens[i].name === name) return true;
    }
    return false;
  }

  /**
   * Broken HTML-ish cell source → block list.
   *
   * Blocks are `{ t: 'p', text }` and
   * `{ t: 'list', ordered, items: [{ blocks: [...] }] }`.
   */
  function parseCell(src, stats) {
    const code = [];
    src = markdownListsToHtml(maskCode(dedent(src), code));
    const root = [];
    const containers = [root];          // where blocks get appended
    const lists = [];                   // [{ list, itemOpen }]
    const openInline = [];              // [{ name, close }]
    let inline = '';

    const top = () => containers[containers.length - 1];
    const innerList = () => (lists.length ? lists[lists.length - 1] : null);

    const closeInline = () => {
      while (openInline.length) inline += openInline.pop().close;
    };

    const flushPara = () => {
      closeInline();
      let text = unmask(inline, code).replace(/[ \t]+/g, ' ').trim();
      inline = '';
      // `...Request</strong><` then a newline and `<li>`: the tokenizer could
      // not read that `<` as a tag because it was never finished. It is debris.
      if (/<$/.test(text)) { text = text.slice(0, -1).replace(/\s+$/, ''); stats.repairedTags++; }
      // The rebuilt table is emitted verbatim, so it never reaches md-clean's
      // escaping pass. A cell holding `{n}` or `<YOUR_TOKEN>` would take the
      // whole page down; borrow the one implementation rather than repeat it.
      // It skips code spans itself, which is why unmasking happens first.
      if (text && window.mdClean && window.mdClean.escapeStrayTags) {
        text = window.mdClean.escapeStrayTags(text, stats);
      }
      if (text) top().push({ t: 'p', text });
    };

    const openItem = () => {
      const l = innerList();
      const item = { blocks: [] };
      l.list.items.push(item);
      l.itemOpen = true;
      containers.push(item.blocks);
    };

    const closeItem = () => {
      const l = innerList();
      if (!l || !l.itemOpen) return;
      flushPara();
      l.itemOpen = false;
      containers.pop();
    };

    const openList = (ordered) => {
      const l = innerList();
      let borrowed = false;
      if (l && !l.itemOpen && l.list.items.length) {
        // `<ul><li>x</li><ul>...</ul></ul>` — invalid HTML that every browser
        // renders as a child of the previous item, so read it that way. The
        // borrowed flag records that this cost a container: without it, closing
        // the nested list would pop the container of an item still being filled.
        containers.push(l.list.items[l.list.items.length - 1].blocks);
        l.itemOpen = true;
        borrowed = true;
      } else {
        flushPara();
      }
      const list = { t: 'list', ordered, items: [] };
      top().push(list);
      lists.push({ list, itemOpen: false, borrowed });
    };

    const closeList = () => {
      if (!lists.length) return;
      closeItem();
      const entry = lists.pop();
      if (entry.borrowed) {
        containers.pop();
        const l = innerList();
        if (l) l.itemOpen = false;
      }
    };

    const closeAllLists = () => { while (lists.length) closeList(); };

    const tokens = tokenize(src);

    tokens.forEach((tok, idx) => {
      if (tok.kind === 'text') {
        // A blank line in the source is a real paragraph break; ReadMe's editor
        // writes cells that way and the migration left them in place.
        const chunks = tok.text.split(/\n[ \t]*\n/);
        chunks.forEach((chunk, n) => {
          if (n) {
            // Prose after a blank line ends the list, whether or not the source
            // ever closed it. This is what recovers a cell whose `</ul>` was
            // typed as `</` — without it, every following paragraph and list
            // gets swallowed as one more level of nesting.
            if (lists.length && !listContinues(tokens, idx, chunks, n)) closeAllLists();
            flushPara();
          }
          const t = chunk.replace(/\s+/g, ' ');
          if (!t.trim()) {
            // Whitespace between `</li>` and `<li>` is layout, not content.
            if (inline) inline += ' ';
            return;
          }
          // Text sitting directly inside `<ul>` with no item open is not an
          // item; a browser hoists it out of the list and so do we.
          const l = innerList();
          if (l && !l.itemOpen) closeAllLists();
          // A fence is a block, not part of a sentence: it breaks the paragraph
          // it interrupts. That is also what keeps a cell holding one out of a
          // pipe table, the way ReadMe's own serializer does.
          const parts = t.split(PLACEHOLDER);
          for (let k = 0; k < parts.length; k++) {
            const part = parts[k];
            if (k % 2) {
              const held = code[+part];
              if (held && held.fence) {
                flushPara();
                top().push({ t: 'code', text: held.text });
              } else {
                inline += MARK + part + MARK;
              }
              continue;
            }
            if (!part) continue;
            inline += inline ? part : part.replace(/^\s+/, '');
          }
        });
        return;
      }

      const name = tok.name;

      if (tok.kind === 'open') {
        if (TABLE_TAGS.has(name)) return;
        if (name === 'br') {
          // Between list items it is spacing; in prose it is a paragraph break.
          const l = innerList();
          if (l && !l.itemOpen) { stats.droppedBreaks++; return; }
          if (!inline.trim()) { stats.droppedBreaks++; return; }
          flushPara();
          return;
        }
        if (LIST_TAGS.has(name)) {
          if (opensNothing(tokens, idx)) {
            if (lists.length) { stats.repairedTags++; closeList(); }
            else stats.repairedTags++;
            return;
          }
          openList(name === 'ol');
          return;
        }
        if (name === 'li') {
          if (!lists.length) { stats.repairedTags++; openList(false); }
          else if (innerList().itemOpen) closeItem();
          openItem();
          return;
        }
        if (BLOCK_TAGS.has(name)) { flushPara(); return; }
        if (name === 'img') {
          const src2 = (/src\s*=\s*"([^"]*)"/.exec(tok.attrs) || [])[1];
          const alt = (/alt\s*=\s*"([^"]*)"/.exec(tok.attrs) || [])[1] || '';
          inline += src2 ? '![' + alt + '](' + src2 + ')' : '';
          return;
        }
        if (VOID_TAGS.has(name)) {
          // Keep the attributes; MDX only needs the tag actually closed.
          inline += tok.selfClose ? tok.raw : tok.raw.replace(/>$/, ' />').replace(/\s+\/>$/, ' />');
          return;
        }
        if (INLINE_MD[name]) {
          inline += INLINE_MD[name];
          openInline.push({ name, close: INLINE_MD[name] });
          return;
        }
        if (name === 'a') {
          const href = (/href\s*=\s*"([^"]*)"/.exec(tok.attrs) ||
                        /href\s*=\s*'([^']*)'/.exec(tok.attrs) || [])[1];
          if (href) {
            inline += '[';
            openInline.push({ name, close: '](' + href + ')' });
            return;
          }
        }
        // Anything else closable: keep it verbatim and guarantee it closes.
        if (tok.selfClose) { inline += tok.raw; return; }
        inline += tok.raw;
        openInline.push({ name, close: '</' + name + '>' });
        return;
      }

      // kind === 'close'
      if (TABLE_TAGS.has(name)) return;
      if (LIST_TAGS.has(name)) { closeList(); return; }
      if (name === 'li') { closeItem(); return; }
      if (BLOCK_TAGS.has(name)) { flushPara(); return; }
      if (name === 'br') return;

      // Exact match, then a prefix match for a tag truncated mid-name
      // (`</st` for `</strong>`), resolved against what is actually open.
      let at = -1;
      for (let k = openInline.length - 1; k >= 0; k--) {
        if (openInline[k].name === name) { at = k; break; }
      }
      if (at < 0) {
        for (let k = openInline.length - 1; k >= 0; k--) {
          if (openInline[k].name.startsWith(name)) { at = k; stats.repairedTags++; break; }
        }
      }
      if (at >= 0) {
        while (openInline.length > at) inline += openInline.pop().close;
        return;
      }
      // No such tag is open. `</b>text</b>` means the first one was an opener.
      if (INLINE_MD[name] && closerAppearsLater(tokens, idx, name)) {
        stats.repairedTags++;
        inline += INLINE_MD[name];
        openInline.push({ name, close: INLINE_MD[name] });
        return;
      }
      stats.repairedTags++;   // orphan closer, drop it
    });

    flushPara();
    closeAllLists();
    return root;
  }

  /* ----------------------------------------------------------- cell rendering */

  function renderList(list, depth) {
    const lines = [];
    const pad = '  '.repeat(depth);
    list.items.forEach((item, n) => {
      const blocks = item.blocks;
      const lead = blocks.length && blocks[0].t === 'p' ? blocks[0] : null;
      const marker = list.ordered ? n + 1 + '. ' : '- ';
      lines.push((pad + marker + (lead ? lead.text : '')).replace(/\s+$/, ''));
      for (const b of lead ? blocks.slice(1) : blocks) {
        if (b.t === 'list') lines.push(renderList(b, depth + 1));
        // A second paragraph or a fence indents to the item's content column.
        else if (b.t === 'p') lines.push(pad + '  ' + b.text);
        else if (b.t === 'code') {
          lines.push(b.text.split('\n').map((l) => (l ? pad + '  ' + l : l)).join('\n'));
        }
      }
    });
    return lines.join('\n');
  }

  function renderCell(blocks) {
    const out = [];
    for (const b of blocks) {
      if (b.t === 'p' || b.t === 'code') out.push(b.text);
      else if (b.t === 'list') out.push(renderList(b, 0));
    }
    return out.filter((s) => s && s.trim()).join('\n\n');
  }

  // ReadMe's rule, reproduced: one paragraph and nothing else is phrasing-only.
  // A list, a fence or a second paragraph is block content and keeps the JSX.
  const isInlineOnly = (blocks) => blocks.length <= 1 && blocks.every((b) => b.t === 'p');

  /* ------------------------------------------------------- table skeleton */

  /**
   * A cell's own attributes, carried through rather than regenerated.
   *
   * ReadMe's Slate editor writes `style={{ textAlign: "left" }}` on every cell
   * and its Tiptap one writes none; either is valid and dropping them would
   * re-align somebody's table. `colspan`/`rowspan` are neither editor's output
   * — no ReadMe editor can produce a merged cell — but a hand-written table has
   * them, and in JSX they need the React spelling to reach the DOM at all.
   */
  function cellAttrs(raw) {
    return String(raw)
      .replace(/\bcolspan\s*=\s*"(\d+)"/gi, 'colSpan={$1}')
      .replace(/\browspan\s*=\s*"(\d+)"/gi, 'rowSpan={$1}')
      .trim();
  }

  // Slice on opening tags rather than matching pairs: a cell whose own closer
  // was truncated still ends where the next one starts.
  function sliceBy(src, openRe, closeRe) {
    const starts = [];
    let m;
    const re = new RegExp(openRe.source, 'gi');
    while ((m = re.exec(src))) {
      starts.push({
        tag: m[1] ? m[1].toLowerCase() : '',
        attrs: cellAttrs(m[2] || ''),
        at: m.index + m[0].length,
      });
    }
    return starts.map((s, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].at - 1 : src.length;
      let seg = src.slice(s.at, end);
      const cut = closeRe.exec(seg);
      if (cut) seg = seg.slice(0, cut.index);
      return { tag: s.tag, attrs: s.attrs, src: seg };
    });
  }

  function parseTable(src) {
    const open = /<Table\b([^>]*)>/i.exec(src);
    const attrs = open ? open[1].trim() : '';
    const headEnd = /<\/\s*thead(?![A-Za-z])\s*>?/i.exec(src);
    const rows = sliceBy(src, /<(tr)\b[^>]*>/, /<\/\s*tr(?![A-Za-z])\s*>?/i).map((r) => {
      const cells = sliceBy(r.src, /<(th|td)\b([^>]*)>/, /<\/\s*t[hd](?![A-Za-z])\s*>?/i);
      const at = src.indexOf(r.src);
      return {
        // A row is a header row if it holds `th`s, or if it sits in `<thead>`.
        header: cells.some((c) => c.tag === 'th') || (headEnd && at >= 0 && at < headEnd.index),
        cells: cells.map((c) => c.src),
        attrs: cells.map((c) => c.attrs),
      };
    });
    return { attrs, rows: rows.filter((r) => r.cells.length) };
  }

  /* --------------------------------------------------------------- emitting */

  const IND = '  ';

  function emitJsx(rows, attrs, cells) {
    const L = [];
    const push = (depth, s) => L.push(IND.repeat(depth) + s);
    const section = (rowIdx, tag) => {
      rowIdx.forEach((ri, n) => {
        if (n) L.push('');
        push(2, '<tr>');
        rows[ri].cells.forEach((_, ci) => {
          if (ci) L.push('');
          const attrs = (rows[ri].attrs || [])[ci];
          push(3, '<' + tag + (attrs ? ' ' + attrs : '') + '>');
          const body = cells[ri][ci];
          if (body) for (const line of body.split('\n')) L.push(line ? IND.repeat(4) + line : '');
          else L.push('');
          push(3, '</' + tag + '>');
        });
        push(2, '</tr>');
      });
    };

    const head = rows.map((r, i) => (r.header ? i : -1)).filter((i) => i >= 0);
    const body = rows.map((r, i) => (r.header ? -1 : i)).filter((i) => i >= 0);

    L.push('<Table' + (attrs ? ' ' + attrs : '') + '>');
    if (head.length) {
      push(1, '<thead>');
      section(head, 'th');
      push(1, '</thead>');
    }
    if (body.length) {
      if (head.length) L.push('');
      push(1, '<tbody>');
      section(body, 'td');
      push(1, '</tbody>');
    }
    L.push('</Table>');
    return L.join('\n');
  }

  // Only reached when every cell is inline — the form ReadMe's own serializer
  // would choose, so the next editor save produces no diff.
  function emitPipe(rows, cells) {
    const width = Math.max(...rows.map((r) => r.cells.length));
    const cell = (ri, ci) => (cells[ri][ci] || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ') || ' ';
    const line = (ri) => {
      const out = [];
      for (let ci = 0; ci < width; ci++) out.push(cell(ri, ci));
      return '| ' + out.join(' | ') + ' |';
    };
    const L = [];
    const headIdx = rows.findIndex((r) => r.header);
    const first = headIdx >= 0 ? headIdx : 0;
    L.push(line(first));
    L.push('| ' + Array(width).fill('---').join(' | ') + ' |');
    rows.forEach((_, ri) => { if (ri !== first) L.push(line(ri)); });
    return L.join('\n');
  }

  /**
   * One `<Table>` source → normalized ReadMe MDX (or a pipe table).
   * @returns {{ text: string, stats: object }}
   */
  function cleanTable(src) {
    const stats = { repairedTags: 0, droppedBreaks: 0, pipe: false };
    const { attrs, rows } = parseTable(src);
    if (!rows.length) return { text: src, stats };

    const parsed = rows.map((r) => r.cells.map((c) => parseCell(c, stats)));
    const cells = parsed.map((r) => r.map(renderCell));

    if (parsed.every((r) => r.every(isInlineOnly))) {
      stats.pipe = true;
      return { text: emitPipe(rows, cells), stats };
    }
    return { text: emitJsx(rows, attrs, cells), stats };
  }

  /** Find the end of the `<Table>` that starts at `from`, nesting-aware. */
  function tableEnd(text, from) {
    const re = /<(\/?)\s*Table\b[^>]*>/gi;
    re.lastIndex = from;
    let depth = 0;
    let m;
    while ((m = re.exec(text))) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) return m.index + m[0].length;
    }
    return -1;
  }

  /**
   * Rewrite every `<Table>` in a document. Leaves everything else untouched.
   * @returns {{ text: string, stats: object }}
   */
  function cleanMdxTables(text, report) {
    const stats = { tables: 0, repairedTags: 0, droppedBreaks: 0, pipe: 0 };
    let src = String(text || '');
    let out = '';
    const re = /<Table\b[^>]*>/i;
    let guard = 0;

    for (;;) {
      const m = re.exec(src);
      if (!m || guard++ > 500) break;
      const end = tableEnd(src, m.index);
      // An unterminated `<Table>` is not something to guess at; leave it be.
      if (end < 0) break;
      const cleaned = cleanTable(src.slice(m.index, end));
      out += src.slice(0, m.index) + cleaned.text;
      stats.tables++;
      stats.repairedTags += cleaned.stats.repairedTags;
      stats.droppedBreaks += cleaned.stats.droppedBreaks;
      if (cleaned.stats.pipe) stats.pipe++;
      // Closers orphaned by the broken markup trail the table; they belong to
      // the lists that were just rebuilt, not to the document.
      src = src.slice(end).replace(/^((?:\s*<\/\s*(?:li|ul|ol)\s*>?)+)/, () => {
        stats.repairedTags++;
        return '';
      });
    }
    out += src;

    if (report && stats.tables) {
      report.mdxTables = stats.tables;
      if (stats.repairedTags) report.mdxTablesRepaired = stats.repairedTags;
      if (stats.pipe) report.mdxTablesToPipe = stats.pipe;
    }
    return { text: out, stats };
  }

  window.mdxTable = { cleanMdxTables, cleanTable, parseTable, parseCell, renderCell };
}());
