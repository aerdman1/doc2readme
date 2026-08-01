const $ = (id) => document.getElementById(id);
let picked = [];      // {name, buffer}
let converted = [];   // {path, text?, data?}
let reports = [];
let active = 0;

/* ---- file intake ---- */
const drop = $('drop');
drop.addEventListener('click', () => $('picker').click());
$('picker').addEventListener('change', (e) => addFiles(e.target.files));
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

async function addFiles(list) {
  // Read everything first, then dedupe and commit in one synchronous pass.
  // Checking `picked` before an await lets two overlapping drops of the same
  // file both pass the check and add it twice.
  const incoming = [];
  for (const f of list) {
    if (!/\.(docx|pdf)$/i.test(f.name)) {
      if (/\.(doc|docm|rtf|odt|pages)$/i.test(f.name)) {
        setStatus(f.name + ' — save it as .docx or PDF first, then drop it back in.', true);
      } else {
        setStatus(f.name + ' — only .docx and .pdf files can be converted.', true);
      }
      continue;
    }
    incoming.push({ name: f.name, buffer: await f.arrayBuffer() });
  }
  for (const item of incoming) {
    if (picked.some((p) => p.name === item.name)) continue;
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
  $('convertBtn').disabled = !picked.length;
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

  for (const p of picked) {
    try {
      const { files, report } = await docx2readme.convertDocument(p.buffer, p.name, opts);
      converted.push(...files);
      reports.push(report);
    } catch (err) {
      reports.push({ source: p.name, error: err.message || String(err) });
    }
  }

  $('convertBtn').disabled = false;
  const pages = converted.filter((f) => f.text !== undefined && f.path.endsWith('.md'));
  const failed = reports.filter((r) => r.error).length;
  setStatus(pages.length + ' page(s) from ' + (reports.length - failed) + ' document(s)' +
            (failed ? ' · ' + failed + ' failed' : ''), failed > 0 && !pages.length);
  $('zipBtn').disabled = !converted.length;
  renderResults();
});

function renderResults() {
  const box = $('results');
  const previewable = converted.filter((f) => f.text !== undefined);
  const any = previewable.length > 0;
  box.hidden = !any;
  $('reportPanel').hidden = !reports.length;
  $('empty').hidden = any || reports.length > 0;

  const tabs = $('tabs');
  tabs.innerHTML = '';
  previewable.forEach((f, i) => {
    const b = document.createElement('button');
    b.textContent = f.path;
    b.className = i === active ? 'on' : '';
    b.onclick = () => { active = i; renderResults(); };
    tabs.append(b);
  });
  const cur = previewable[active];
  $('preview').textContent = cur ? cur.text : '';
  $('copyBtn').disabled = !cur;
  $('dlOneBtn').disabled = !cur;

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
    if (r.pdfTables) bits.push(r.pdfTables + ' table(s) reconstructed');
    if (bits.length) add(escHtml(bits.join(', ')));
    if (r.autocorrectFixes) {
      add('<span style="color:var(--warn)">Repaired ' + r.autocorrectFixes +
          ' Word AutoCorrect character(s) inside code blocks — those snippets would have failed when copied.</span>');
    }
    if (r.kind === 'pdf') {
      add('<span style="color:var(--warn)">PDF source — headings, tables and code '
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
  const f = converted.filter((x) => x.text !== undefined)[active];
  if (!f) return;
  download(new Blob([f.text], { type: 'text/markdown' }), f.path.split('/').pop());
});

$('copyBtn').addEventListener('click', async () => {
  const f = converted.filter((x) => x.text !== undefined)[active];
  if (!f) return;
  try {
    await navigator.clipboard.writeText(f.text);
    setStatus('Copied ' + f.path + ' to the clipboard.');
  } catch (e) {
    setStatus('Could not copy — select the text and copy manually.', true);
  }
});

$('zipBtn').addEventListener('click', () => {
  if (!converted.length) return;
  const files = converted.map((f) => ({
    path: 'docs/' + f.path,
    data: f.text !== undefined ? f.text : f.data,
  }));
  download(docx2readme.makeZip(files), 'readme-docs.zip');
  setStatus('Downloaded readme-docs.zip — its docs/ folder drops straight into a ReadMe git-sync repo.');
});

/* ---- capability check ---- */
if (typeof DecompressionStream === 'undefined') {
  setStatus('This browser is too old — needs Chrome/Edge 103+, Firefox 113+ or Safari 16.4+.', true);
  $('convertBtn').disabled = true;
}
