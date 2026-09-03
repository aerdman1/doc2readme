// ReadMe export (.zip) -> one Word document per category.
//
// The other direction. Everything upstream of the writer is the code the rest
// of the page already uses: readZip unpacks the export, readme-export walks it
// in _order.yaml order, md-clean turns each page into Block[], applyPasses does
// the same cleanup, and docx-render emits the .docx.
//
// THE IMAGE FETCH IS THE ONE NETWORK CALL THIS PAGE MAKES.
//   A ReadMe export contains no image files. Every picture in the Markdown is a
//   link to files.readme.io, so a Word document with the screenshots in it can
//   only exist if those bytes are fetched. connect-src pins that to exactly one
//   origin, GET only. Nothing of the user's is ever sent — the request carries a
//   public CDN URL that was already sitting in their own export.
//   Untick the box and every image becomes a labelled placeholder instead.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  if (!$('r2wRoot')) return;

  let picked = null;          // {name, buffer}
  let built = [];             // [{name, blob}]

  function status(msg) { $('r2wStatus').textContent = msg; }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  /* ------------------------------------------------------------- nav */

  function show() {
    $('r2wRoot').hidden = false;
    $('docShell').hidden = true;
    if ($('twRoot')) $('twRoot').hidden = true;
    $('navR2w').classList.add('on');
    $('navR2w').setAttribute('aria-selected', 'true');
    for (const id of ['navDocs', 'navTables']) {
      $(id).classList.remove('on');
      $(id).setAttribute('aria-selected', 'false');
    }
  }
  // table-wizard.js owns the Documents/Tables pair; these listeners are additive
  // and only have to put this shell away.
  function hide() {
    $('r2wRoot').hidden = true;
    $('navR2w').classList.remove('on');
    $('navR2w').setAttribute('aria-selected', 'false');
  }
  $('navR2w').addEventListener('click', show);
  $('navDocs').addEventListener('click', hide);
  if ($('navTables')) $('navTables').addEventListener('click', hide);
  if ($('toR2w')) $('toR2w').addEventListener('click', (e) => { e.preventDefault(); show(); });

  /* ------------------------------------------------------------ input */

  const drop = $('r2wDrop');
  drop.addEventListener('click', () => $('r2wPicker').click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('r2wPicker').click(); }
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
  drop.addEventListener('drop', (e) => take(e.dataTransfer.files));
  $('r2wPicker').addEventListener('change', (e) => take(e.target.files));

  async function take(list) {
    const f = [...(list || [])].find((x) => /\.zip$/i.test(x.name));
    if (!f) { status('That is not a .zip. Export your project from ReadMe and drop the file here.'); return; }
    picked = { name: f.name, buffer: await f.arrayBuffer() };
    $('r2wFiles').hidden = false;
    $('r2wFiles').innerHTML = '<li>' + f.name.replace(/</g, '&lt;') + '</li>';
    $('r2wGo').disabled = false;
    status('Ready. One Word document per category, in sidebar order.');
  }

  /* ---------------------------------------------------------- convert */

  async function fetchImage(url) {
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      const fromUrl = (/\.(png|jpe?g|gif|webp)(?:$|\?)/i.exec(url) || [])[1];
      const fromType = (res.headers.get('content-type') || '').split('/')[1];
      return { data: buf, ext: (fromUrl || fromType || 'png').split(';')[0].toLowerCase() };
    } catch (e) {
      return null;                       // blocked, offline or 404 — placeholder
    }
  }

  $('r2wGo').addEventListener('click', async () => {
    if (!picked) return;
    $('r2wGo').disabled = true;
    built = [];
    $('r2wReport').hidden = true;
    $('r2wReport').innerHTML = '';

    try {
      status('Unpacking…');
      const files = await window.docx2readme.readZip(picked.buffer);
      const groups = window.readmeExport.parseExport(files, { includeHidden: $('r2wHidden').checked });
      if (!groups.length) { status('No docs/ folder in that zip — is it a ReadMe export?'); $('r2wGo').disabled = false; return; }

      const wantImages = $('r2wImages').checked;
      const rows = [];

      for (const g of groups) {
        status('Converting ' + g.category + '…');
        const pages = g.pages.map((pg) => {
          const report = {};
          let blocks = window.mdClean.markdownToBlocks(pg.body, report);
          // topLevel nests a page's own headings under its title; maxLevel 6
          // because a grandchild page starts at H4 and the page default of 3
          // would flatten everything below it into one level.
          blocks = window.docx2readme.applyPasses(blocks, Object.assign(
            {}, window.docx2readme.defaultOptions(),
            { topLevel: Math.min(6, pg.depth + 1), maxLevel: 6, noCallouts: true }), report);
          return { title: pg.title, depth: pg.depth, blocks };
        });

        const urls = window.readmeExport.imageUrls(pages);
        const media = {};
        let got = 0;
        if (wantImages && urls.length) {
          for (let i = 0; i < urls.length; i++) {
            status('Fetching image ' + (i + 1) + ' of ' + urls.length + ' for ' + g.category + '…');
            const img = await fetchImage(urls[i]);
            if (img) { media[urls[i]] = img; got++; }
          }
        }

        const parts = window.docxRender.renderDocx({ title: g.category, pages }, { media });
        const name = window.readmeExport.safeName(g.category) + '.docx';
        built.push({ name, blob: window.docx2readme.makeZip(parts) });
        rows.push({ cat: g.category, pages: pages.length, images: urls.length, got });
      }

      $('r2wReport').hidden = false;
      $('r2wReport').innerHTML = rows.map((r) =>
        '<li><strong>' + r.cat.replace(/</g, '&lt;') + '.docx</strong> — ' + r.pages + ' page(s)' +
        (r.images ? ', ' + r.got + ' of ' + r.images + ' image(s) embedded' : '') + '</li>').join('');

      $('r2wZip').disabled = built.length < 2;
      status(built.length + ' document(s) ready.');
      for (const b of built) download(b.blob, b.name);
    } catch (err) {
      status('Could not convert that file: ' + (err && err.message ? err.message : err));
    }
    $('r2wGo').disabled = false;
  });

  $('r2wZip').addEventListener('click', async () => {
    if (!built.length) return;
    const parts = [];
    for (const b of built) parts.push({ path: b.name, data: new Uint8Array(await b.blob.arrayBuffer()) });
    download(window.docx2readme.makeZip(parts), 'readme-word-export.zip');
  });
}());
