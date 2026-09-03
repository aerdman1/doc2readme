// A ReadMe zip export -> ordered pages, grouped by category.
//
// Shared by the page and tools/export2word.js so both walk an export the same
// way. Pure: it takes the unpacked zip as a Map and returns plain objects.
//
// ORDER COMES FROM _order.yaml. ReadMe writes one at every level, and it is the
// sidebar order — the only order a reader recognises. Sorting by filename puts
// "advanced" before "getting-started" and makes the document nonsense.
//
// DEPTH IS THE NAV DEPTH, not the folder depth, and it drives Word heading
// levels: a category is the document title, its direct pages are H1, their
// children H2, and so on. A page's own headings are pushed underneath by
// applyPasses({topLevel: depth + 1}).

(function (root) {
  'use strict';

  const dec = () => new (root.TextDecoder || TextDecoder)('utf-8');
  const text = (bytes) => (typeof bytes === 'string' ? bytes : dec().decode(bytes));

  /** Front matter is YAML, but only a handful of scalar keys matter here. */
  function frontmatter(src) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
    if (!m) return { meta: {}, body: src };
    const meta = {};
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const v = kv[2].trim().replace(/^["']|["']$/g, '');
      meta[kv[1]] = v === 'true' ? true : v === 'false' ? false : v;
    }
    return { meta, body: src.slice(m[0].length) };
  }

  function orderOf(files, dir) {
    const raw = files.get(dir + '/_order.yaml');
    if (!raw) return null;
    return text(raw).split('\n')
      .map((l) => /^\s*-\s*(.+?)\s*$/.exec(l))
      .filter(Boolean)
      .map((m) => m[1].replace(/^["']|["']$/g, ''));
  }

  function pageFile(files, dir, slug, isDir) {
    const cands = isDir
      ? [dir + '/' + slug + '/index.md', dir + '/' + slug + '/index.mdx']
      : [dir + '/' + slug + '.md', dir + '/' + slug + '.mdx'];
    return cands.find((p) => files.has(p)) || null;
  }

  function walk(files, dir, depth, out, opts) {
    const dirs = new Set();
    const leaves = new Set();
    for (const p of files.keys()) {
      if (p.indexOf(dir + '/') !== 0) continue;
      const rest = p.slice(dir.length + 1);
      if (rest.indexOf('/') >= 0) dirs.add(rest.split('/')[0]);
      else if (/\.mdx?$/.test(rest) && !/^index\.mdx?$/.test(rest)) {
        leaves.add(rest.replace(/\.mdx?$/, ''));
      }
    }
    // No _order.yaml is possible (a hand-made zip); alphabetical is the same
    // fallback ReadMe itself uses. Anything on disk the file does not mention is
    // appended rather than skipped — an incomplete _order.yaml should cost you
    // the ordering, not the page.
    const listed = orderOf(files, dir);
    const ordered = listed
      ? listed.concat([...leaves, ...dirs].filter((s) => listed.indexOf(s) < 0).sort())
      : [...leaves, ...dirs].sort();

    for (const slug of ordered) {
      const isDir = dirs.has(slug);
      const file = pageFile(files, dir, slug, isDir);
      if (file) {
        const { meta, body } = frontmatter(text(files.get(file)));
        // Hidden pages are unpublished drafts. Shipping them inside a document
        // the customer hands to someone else is the wrong default.
        if (meta.hidden !== true || opts.includeHidden) {
          out.push({ slug, title: meta.title || slug, depth, body, path: file });
        }
      }
      if (isDir) walk(files, dir + '/' + slug, depth + 1, out, opts);
    }
  }

  /**
   * @param {Map<string, Uint8Array|string>} files  unpacked zip
   * @param {{includeHidden?:boolean}} [opts]
   * @returns {Array<{category:string, pages:Array<{title,depth,body,slug,path}>}>}
   */
  function parseExport(files, opts) {
    opts = opts || {};
    const cats = orderOf(files, 'docs') || [...new Set([...files.keys()]
      .filter((p) => p.indexOf('docs/') === 0 && p.split('/').length > 2)
      .map((p) => p.split('/')[1]))].sort();

    const out = [];
    for (const cat of cats) {
      const pages = [];
      walk(files, 'docs/' + cat, 1, pages, opts);
      if (pages.length) out.push({ category: cat, pages });
    }
    return out;
  }

  /** Every http(s) image a page set references, in document order. */
  function imageUrls(pages) {
    const urls = [];
    const seen = new Set();
    for (const pg of pages) {
      for (const b of pg.blocks || []) {
        const t = b && b.text ? String(b.text) : '';
        const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
        let m;
        while ((m = re.exec(t))) { if (!seen.has(m[1])) { seen.add(m[1]); urls.push(m[1]); } }
      }
    }
    return urls;
  }

  /** A filename that is safe on Windows and macOS. */
  function safeName(s) {
    return String(s || 'document').replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  }

  root.readmeExport = { parseExport, frontmatter, orderOf, imageUrls, safeName };
}(typeof window !== 'undefined' ? window : globalThis));
