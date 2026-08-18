const $ = (id) => document.getElementById(id);
let picked = [];      // {name, buffer}   (reassigned on mode switch)
let converted = [];   // {path, text?, data?}
let reports = [];
let active = 0;

/* ---- file intake ---- */
const drop = $('drop');
drop.addEventListener('click', () => $('picker').click());
// The drop zone is the only way in, so it has to work without a mouse.
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    $('picker').click();
  }
});
$('picker').addEventListener('change', (e) => addFiles(e.target.files));
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

/* ---- mode: word/pdf vs markdown ---- */
// Single source of truth. The static HTML must match COPY.doc exactly; the
// UI test asserts it, because the hero once still said "Word or PDF" long
// after zips were supported.
const COPY = {
  doc: {
    drop: 'Drop Word, PDF, HTML or a .zip here',
    hint: 'A zip of folders keeps its structure',
    hero: 'Drop a Word doc, PDF, HTML file or .zip to get started',
    sub:  'Everything happens on this machine. Your files are never sent anywhere.',
  },
  md: {
    drop: 'Drop Markdown files or a .zip here',
    hint: 'Or paste below',
    hero: 'Drop, paste or zip up Markdown to clean it',
    sub:  'Fixes heading levels, escapes MDX-unsafe tags, and normalises callouts. Nothing is uploaded.',
  },
};
let inputMode = 'doc';
function setMode(next) {
  inputMode = next;
  const md = inputMode === 'md';
  $('modeDoc').classList.toggle('on', !md);
  $('modeMd').classList.toggle('on', md);
  $('modeDoc').setAttribute('aria-selected', String(!md));
  $('modeMd').setAttribute('aria-selected', String(md));
  const copy = md ? COPY.md : COPY.doc;
  $('picker').accept = md ? '.md,.markdown,.mdx,.txt,.zip'
                          : '.docx,.pdf,.html,.htm,.xhtml,.zip';
  $('dropTitle').textContent = copy.drop;
  $('dropHint').textContent = copy.hint;
  $('pasteBox').hidden = !md;
  if ($('heroTitle')) $('heroTitle').textContent = copy.hero;
  if ($('heroSub')) $('heroSub').textContent = copy.sub;

  // Queued files belong to the mode they were added in — converting a .docx
  // as Markdown would just produce garbage. Drop the ones that no longer fit.
  const keep = md ? MD_EXT : DOC_EXT;
  const dropped = picked.filter((p) => !keep.test(p.name));
  if (dropped.length) {
    picked = picked.filter((p) => keep.test(p.name));
    setStatus(dropped.length + ' file(s) removed — they do not belong to this mode.');
  }
  renderFiles();
}
$('modeDoc').addEventListener('click', () => setMode('doc'));
$('modeMd').addEventListener('click', () => setMode('md'));
$('pasteBox').addEventListener('input', refreshConvertEnabled);

function pastedMarkdown() {
  return inputMode === 'md' ? $('pasteBox').value.trim() : '';
}
function refreshConvertEnabled() {
  $('convertBtn').disabled = !picked.length && !pastedMarkdown();
}

const DOC_EXT = /\.(docx|pdf|html?|xhtml|zip)$/i;
const MD_EXT = /\.(md|markdown|mdx|txt)$/i;

async function addFiles(list) {
  // Read everything first, then dedupe and commit in one synchronous pass.
  // Checking `picked` before an await lets two overlapping drops of the same
  // file both pass the check and add it twice.
  const incoming = [];
  for (const f of list) {
    const wanted = inputMode === 'md' ? MD_EXT : DOC_EXT;
    if (!wanted.test(f.name)) {
      // Dropping the other kind is an easy mistake; switch rather than refuse.
      if (inputMode === 'doc' && MD_EXT.test(f.name)) { setMode('md'); }
      else if (inputMode === 'md' && DOC_EXT.test(f.name)) { setMode('doc'); }
      else if (/\.(doc|docm|rtf|odt|pages)$/i.test(f.name)) {
        setStatus(f.name + ' — save it as .docx, PDF or Markdown first.', true);
        continue;
      } else {
        setStatus(f.name + ' — needs to be .docx, .pdf, .html, .md or a .zip of those.', true);
        continue;
      }
    }
    incoming.push({ name: f.name, buffer: await f.arrayBuffer() });
  }
  for (const item of incoming) {
    // Same name *and* same size is the same file dropped twice. Same name
    // alone is two different documents from two folders, and silently
    // discarding one of those is worse than a duplicate.
    if (picked.some((p) => p.name === item.name &&
                           p.buffer.byteLength === item.buffer.byteLength)) continue;
    picked.push(item);
  }
  renderFiles();
}

function renderFiles() {
  const ul = $('fileList');
  ul.innerHTML = '';
  ul.hidden = !picked.length;
  picked.forEach((p, i) => {
    const li = document.createElement('li');
    const kb = Math.round(p.buffer.byteLength / 1024).toLocaleString();
    const span = document.createElement('span');
    span.textContent = p.name + '  ·  ' + kb + ' KB';
    const btn = document.createElement('button');
    btn.className = 'rm'; btn.textContent = '×'; btn.title = 'Remove';
    btn.onclick = () => { picked.splice(i, 1); renderFiles(); };
    li.append(span, btn);
    ul.append(li);
  });
  refreshConvertEnabled();
}

function setStatus(msg, isErr) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = isErr ? 'hint err' : 'hint';
}

/* ---- options ---- */
function gatherOptions() {
  const o = docx2readme.defaultOptions();
  o.category = $('category').value.trim();
  o.split = parseInt($('split').value, 10) || 0;
  o.maxLevel = parseInt($('maxLevel').value, 10) || 3;
  const ls = $('labelStyle').value;
  o.labelStyle = ls === 'plain' ? 'plain' : 'bold';
  if (ls === 'keep') o.labels = new Set();
  o.noCallouts = !$('callouts').checked;
  o.calloutStyle = $('calloutStyle').value;
  o.forceMarkdown = inputMode === 'md';
  o.noFrontmatter = !$('frontmatter').checked;
  o.hidden = $('hidden').checked;
  o.keepCover = $('keepCover').checked;
  if (o.keepCover) o.dropSections = new Set();
  for (const raw of $('extraLabels').value.split(',')) {
    const k = docx2readme.normKey(raw);
    if (k) o.labels.add(k);
  }
  return o;
}

/* ---- convert ---- */
$('convertBtn').addEventListener('click', async () => {
  const opts = gatherOptions();
  converted = []; reports = []; active = 0;
  setStatus('Converting…');
  $('convertBtn').disabled = true;

  // guide.docx and guide.pdf both reduce to the slug "guide". Without this
  // the second one silently overwrites the first in the preview and the zip.
  const usedPaths = new Set();
  const dedupe = (path) => {
    if (!usedPaths.has(path)) { usedPaths.add(path); return path; }
    const dot = path.lastIndexOf('.');
    const stem = dot > 0 ? path.slice(0, dot) : path;
    const ext = dot > 0 ? path.slice(dot) : '';
    let n = 2;
    while (usedPaths.has(stem + '-' + n + ext)) n++;
    const out = stem + '-' + n + ext;
    usedPaths.add(out);
    return out;
  };

  const jobs = picked.slice();
  const pasted = pastedMarkdown();
  if (pasted) {
    jobs.push({ name: 'pasted.md', buffer: new TextEncoder().encode(pasted).buffer });
  }

  for (const p of jobs) {
    try {
      const { files, report } = await docx2readme.convertDocument(p.buffer, p.name, opts);
      for (const f of files) {
        const fresh = dedupe(f.path);
        if (fresh !== f.path) {
          (report.notes = report.notes || []).push(
            'another document already produced ' + f.path + ' — saved as ' + fresh);
          f.path = fresh;
        }
      }
      converted.push(...files);
      reports.push(report);
    } catch (err) {
      reports.push({ source: p.name, error: err.message || String(err) });
    }
  }

  refreshConvertEnabled();
  const pages = converted.filter((f) => f.text !== undefined && /\.mdx?$/i.test(f.path));
  const failed = reports.filter((r) => r.error).length;
  setStatus(pages.length + ' page(s) from ' + (reports.length - failed) + ' document(s)' +
            (failed ? ' · ' + failed + ' failed' : ''), failed > 0 && !pages.length);
  $('zipBtn').disabled = !converted.length;
  renderResults();
});

// _order.yaml files ship in the zip but are not pages to preview. Every place
// that indexes by the active tab has to agree on this list, or Copy and
// Download hand back a different file from the one on screen.
function previewablePages() {
  return converted.filter((f) => f.text !== undefined && /\.mdx?$/i.test(f.path));
}
function activePage() {
  return previewablePages()[active];
}

function renderResults() {
  const box = $('results');
  const previewable = previewablePages();
  const any = previewable.length > 0;
  box.hidden = !any;
  $('reportPanel').hidden = !reports.length;
  $('empty').hidden = any || reports.length > 0;
  // Only nag about images when the conversion actually produced some.
  $('imgBanner').hidden = !converted.some((f) => f.data !== undefined);

  const tabs = $('tabs');
  tabs.innerHTML = '';
  previewable.forEach((f, i) => {
    const b = document.createElement('button');
    b.textContent = f.path.replace(/^docs\//, '');
    b.className = i === active ? 'on' : '';
    b.onclick = () => { active = i; renderResults(); };
    tabs.append(b);
  });
  const cur = previewable[active];
  $('preview').textContent = cur ? stripPageFrontmatter(cur.text) : '';
  $('fmNote').hidden = !(cur && hasFrontmatter(cur.text));
  $('copyBtn').disabled = !cur;
  $('dlOneBtn').disabled = !cur;
  $('previewBtn').disabled = !cur;

  /* report */
  const rep = $('report');
  rep.innerHTML = '';
  for (const r of reports) {
    const hd = document.createElement('div');
    hd.className = 'hd';
    hd.textContent = r.source;
    rep.append(hd);
    const add = (html) => {
      const d = document.createElement('div');
      d.className = 'line';
      d.innerHTML = html;
      rep.append(d);
    };
    if (r.error) {
      const d = document.createElement('div');
      d.className = 'line err';
      d.textContent = r.error;
      rep.append(d);
      continue;
    }
    const bits = [];
    if (r.codeBlocks) bits.push(r.codeBlocks + ' code block(s) fenced');
    if (r.callouts) bits.push(r.callouts + ' ReadMe callout(s)');
    if (r.images) bits.push(r.images + ' image(s) extracted');
    if (r.emptyHeadings) bits.push(r.emptyHeadings + ' empty heading(s) dropped');
    if (r.pdfPages) bits.unshift(r.pdfPages + ' PDF page(s) read');
    if (r.mdCodeBlocks) bits.push(r.mdCodeBlocks + ' code block(s) preserved');
    if (r.mdTables) bits.push(r.mdTables + ' table(s) parsed');
    if (r.mdxTables) bits.push(r.mdxTables + ' <Table> rebuilt');
    if (r.htmlTables) bits.push(r.htmlTables + ' table(s) parsed');
    if (r.htmlCodeBlocks) bits.push(r.htmlCodeBlocks + ' code block(s) kept');
    if (r.pdfTables) bits.push(r.pdfTables + ' table(s) reconstructed');
    if (bits.length) add(escHtml(bits.join(', ')));
    if (r.autocorrectFixes) {
      add('<span class="warn">Repaired ' + r.autocorrectFixes +
          ' Word AutoCorrect character(s) inside code blocks — those snippets would have failed when copied.</span>');
    }
    if (r.kind === 'html') {
      if (r.htmlRoot) add('Read the &lt;' + escHtml(r.htmlRoot) + '&gt; region of the page');
      if (r.htmlChromeDropped) add(r.htmlChromeDropped + ' navigation / sidebar / footer block(s) dropped');
      if (r.htmlWordHeadings) add(r.htmlWordHeadings + ' Word heading style(s) promoted to real headings');
      if (r.htmlWordLists) add(r.htmlWordLists + ' Word pseudo-list paragraph(s) turned into list items');
      if (r.htmlWordSidecar) add(r.htmlWordSidecar + ' Word sidecar image(s) skipped (spacers and tracking pixels)');
      if (r.htmlAbsoluteImages) add(r.htmlAbsoluteImages + ' image(s) already point at full URLs and will keep working');
      if (r.htmlRelativeImages) {
        add('<span class="warn">' + r.htmlRelativeImages + ' image(s) use relative paths — '
          + 'host them and replace the paths, or they will not resolve in ReadMe.</span>');
      }
    }
    if (r.kind === 'archive' && r.gitsync) {
      const g = r.gitsync;
      add('Laid out for ReadMe git-sync: ' + g.categories.length + ' categor'
        + (g.categories.length === 1 ? 'y' : 'ies') + ', ' + g.pages + ' page(s)'
        + (g.parents ? ', ' + g.parents + ' parent page(s)' : '')
        + (g.stubs ? ' (' + g.stubs + ' placeholder)' : '')
        + (g.specs ? ', ' + g.specs + ' API spec(s) copied to reference/' : ''));
      add('Categories: ' + escHtml(g.categories.join(', ')));
      const failed = (r.members || []).filter((m) => !m.ok);
      if (failed.length) {
        add('<span class="warn">' + failed.length + ' file(s) in the zip could not be '
          + 'converted: ' + escHtml(failed.map((m) => m.name).join(', ')) + '</span>');
      }
    }
    for (const wmsg of r.warnings || []) add('<span class="warn">' + escHtml(wmsg) + '</span>');
    if (r.mdEscapedTags) {
      add('<span class="warn">Escaped ' + r.mdEscapedTags + ' angle-bracket placeholder(s) '
        + 'such as &lt;YOUR_TOKEN&gt; — unescaped, MDX reads those as JSX tags and the page '
        + 'fails to build.</span>');
    }
    if (r.mdSelfClosed) add('Closed ' + r.mdSelfClosed + ' void HTML tag(s) (&lt;br&gt; → &lt;br /&gt;) for MDX');
    if (r.mdxTables) {
      add('Rebuilt ' + r.mdxTables + ' &lt;Table&gt; the way ReadMe\'s editor writes one: '
        + 'Markdown lists inside &lt;td&gt; instead of inlined &lt;ul&gt;/&lt;li&gt;'
        + (r.mdxTablesToPipe ? ', ' + r.mdxTablesToPipe + ' of them as a pipe table '
           + '(every cell was inline, which is the form the editor itself would save)' : ''));
    }
    if (r.mdxTablesRepaired) {
      add('<span class="warn">Repaired ' + r.mdxTablesRepaired + ' broken tag(s) in table cells '
        + '(an unclosed &lt;/li, a &lt;ul&gt; typed where &lt;/ul&gt; was meant, a tag cut off '
        + 'mid-name). Where the source had lost text outright it is still lost — read those '
        + 'cells against the original.</span>');
    }
    if (r.mdOrphanClosers) {
      add('<span class="warn">Dropped ' + r.mdOrphanClosers + ' stray closing tag(s) '
        + '(&lt;/li&gt;, &lt;/ul&gt;) left over outside a table — MDX rejects a closing tag '
        + 'with nothing open, so the page would not have built.</span>');
    }
    if (r.mdFrontmatter) add('Existing frontmatter read: ' + escHtml(r.mdFrontmatter.join(', ')));
    if (r.kind === 'pdf') {
      add('<span class="warn">PDF source — headings, tables and code '
        + 'blocks were inferred from font size and layout, because a PDF does not '
        + 'record them. Check the result more carefully than you would for Word.</span>');
    }
    if (r.pdfFurnitureDropped) add(r.pdfFurnitureDropped + ' repeating header/footer/page-number line(s) removed');
    if (r.coverLines) add('Cover page dropped (' + r.coverLines.length + ' lines)');
    if (r.droppedSections) add('Sections dropped: ' + escHtml(r.droppedSections.join(', ')));
    if (r.tocLines) add(r.tocLines + ' Word TOC field line(s) dropped');
    if (r.headingMap) add('Heading map: <code>' + escHtml(r.headingMap.join('</code>, <code>')) + '</code>');
    if (r.collapsedLevels) {
      add('Word levels collapsed into one: ' + escHtml(r.collapsedLevels.join(', ')) +
          ' — set "Deepest heading" higher to keep them distinct');
    }
    if (r.demoted) {
      const uniq = [...new Set(r.demoted)];
      add(r.demoted.length + ' label heading(s) demoted (' + uniq.length + ' unique): ' +
          escHtml(uniq.slice(0, 6).join(', ')) + (uniq.length > 6 ? ', …' : ''));
    }
    for (const n of r.notes || []) add(escHtml(n));
    for (const m of r.missingImages || []) add('<span class="err">image not found in package: ' + escHtml(m) + '</span>');
  }
}

function escHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/* ---- downloads ---- */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('dlOneBtn').addEventListener('click', () => {
  const f = activePage();
  if (!f) return;
  // The download is the git-sync artifact, so it keeps its frontmatter.
  download(new Blob([f.text], { type: 'text/markdown' }), f.path.split('/').pop());
});

$('copyBtn').addEventListener('click', async () => {
  const f = activePage();
  if (!f) return;
  try {
    await navigator.clipboard.writeText(stripPageFrontmatter(f.text));
    setStatus('Copied ' + f.path + ' — ready to paste into ReadMe.');
  } catch (e) {
    setStatus('Could not copy — select the text and copy manually.', true);
  }
});

$('zipBtn').addEventListener('click', () => {
  if (!converted.length) return;
  // An archive conversion already emits full git-sync paths (docs/...,
  // reference/...). Prefixing again produced docs/docs/... which is not a
  // drop-in for anything. Single documents still need the docs/ wrapper.
  const files = converted.map((f) => ({
    path: /^(docs|reference)\//.test(f.path) ? f.path : 'docs/' + f.path,
    data: f.text !== undefined ? f.text : f.data,
  }));
  download(docx2readme.makeZip(files), 'readme-docs.zip');
  setStatus('Downloaded readme-docs.zip — its docs/ folder drops straight into a ReadMe git-sync repo.');
});

/* ---- apply the copy table once at load ----
   The static HTML carries the same strings so the page reads correctly before
   JS runs, but this makes COPY authoritative: if the two ever drift, the
   rendered page still matches the code. Must run after DOC_EXT/MD_EXT are
   initialised, hence its position at the end of the file. */
window.COPY = COPY;
setMode(inputMode);

/* ---- capability check ---- */
if (typeof DecompressionStream === 'undefined') {
  setStatus('This browser is too old — needs Chrome/Edge 103+, Firefox 113+ or Safari 16.4+.', true);
  $('convertBtn').disabled = true;
}


/* ---- preview ---- */
let previewOpener = null;
function openPreview() {
  const f = activePage();
  if (!f) return;
  $('previewTitle').textContent = 'Preview — ' + f.path;
  $('previewBody').innerHTML = readmePreview.render(stripPageFrontmatter(f.text));
  $('previewModal').hidden = false;
  document.body.style.overflow = 'hidden';
  previewOpener = document.activeElement;
  $('previewClose').focus();
}
function closePreview() {
  if ($('previewModal').hidden) return;
  $('previewModal').hidden = true;
  document.body.style.overflow = '';
  // Send focus back where it came from; if that was <body> (the button was
  // activated programmatically, or by a click that did not focus it) put it
  // on the Preview button so keyboard users are not dumped at the top.
  const back = (previewOpener && previewOpener !== document.body && previewOpener.focus)
    ? previewOpener : $('previewBtn');
  if (back && back.focus) back.focus();
  previewOpener = null;
}
// Frontmatter only matters to git-sync: ReadMe reads title/slug/hidden from
// it when a repo is synced. Pasting into the editor, it is just four lines of
// junk at the top of the page. So the on-screen pane and the Copy button show
// the body, while downloads and the .zip keep the full file.
function stripPageFrontmatter(t) {
  return String(t || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
}
function hasFrontmatter(t) {
  return /^---\r?\n[\s\S]*?\r?\n---/.test(String(t || ''));
}
/* Test hook. The suite drives this page the way a person does — add files,
   click Convert — but a couple of cases (the mixed file list an archive
   produces, every report shape at once) are far cheaper to set up directly
   than to synthesise six documents for. Nothing here runs in normal use. */
window.__setResults = (files, reportList, activeIndex) => {
  converted = files || [];
  reports = reportList || [];
  active = activeIndex || 0;
  renderResults();
};

$('previewBtn').addEventListener('click', openPreview);
$('previewClose').addEventListener('click', closePreview);
$('previewModal').addEventListener('click', (e) => { if (e.target.id === 'previewModal') closePreview(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePreview(); });
