/* gitsync.js — arrange converted pages into the layout ReadMe git-sync expects.
 *
 * The shape, taken from real synced repositories:
 *
 *   docs/
 *     _order.yaml                  category display names, in order
 *     Getting Started/
 *       _order.yaml                child slugs, in order
 *       installation.md            a leaf page
 *       authentication/            a page with children is a FOLDER
 *         index.md                 ...and its own content lives in index.md
 *         _order.yaml
 *         oauth.md
 *   reference/                     OpenAPI specs, if the drop had any
 *     _order.yaml
 *
 * Two things are easy to get wrong and matter: a parent page is a folder whose
 * own body is index.md (not a sibling file), and every folder needs an
 * _order.yaml or ReadMe orders pages alphabetically, which is almost never the
 * order a document was written in.
 */
'use strict';

// "01-intro.docx", "1. Overview.pdf", "02_setup.md" — authors number files to
// force an order. Use it for ordering, then drop it from the title and slug.
const NUM_PREFIX = /^\s*(\d{1,3})\s*[-._)]\s*/;

function orderKey(name) {
  const m = NUM_PREFIX.exec(name);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

function stripNumPrefix(name) {
  return name.replace(NUM_PREFIX, '');
}

// A file that is clearly "the page for this folder" rather than a child of it.
const INDEXY = /^(index|overview|introduction|intro|readme|start|_index)$/i;

function isIndexName(stem) {
  return INDEXY.test(stripNumPrefix(stem).trim());
}

function yamlItem(value) {
  const s = String(value);
  return /^[A-Za-z0-9][\w .,'\/&()+-]*$/.test(s) && s.trim() === s
    ? '- ' + s + '\n'
    : '- "' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"\n';
}

const SPEC_EXT = /\.(ya?ml|json)$/i;

/**
 * @param {Array} docs  [{ srcPath, title, slug, body, order }]
 *        srcPath is the path inside the dropped folder/zip, e.g.
 *        "Getting Started/auth/oauth.docx". Depth decides the hierarchy.
 * @param {Array} specs [{ path, data }] OpenAPI files passed through untouched
 * @param {object} opts { defaultCategory }
 * @returns {{files: Array<{path, text?, data?}>, report: object}}
 */
function buildGitSync(docs, specs, opts) {
  const report = { categories: [], parents: 0, pages: 0, stubs: 0, warnings: [] };
  const out = [];

  // ---- group into a tree ---------------------------------------------------
  const root = { dirs: new Map(), files: [], index: null };
  const getDir = (node, name) => {
    if (!node.dirs.has(name)) node.dirs.set(name, { name, dirs: new Map(), files: [], index: null });
    return node.dirs.get(name);
  };

  for (const doc of docs) {
    const parts = String(doc.srcPath || '').split('/').filter(Boolean);
    const file = parts.pop();
    const stem = file.replace(/\.[^.]+$/, '');
    let node = root;
    // A loose file with no folder needs somewhere to live.
    if (!parts.length) {
      const cat = (opts.defaultCategory || '').trim();
      if (!cat) {
        report.warnings.push(
          file + ' sits at the top level — set a category folder so it has somewhere to go.');
        continue;
      }
      parts.push(cat);
    }
    for (const p of parts) node = getDir(node, stripNumPrefix(p));
    const entry = { doc, stem, order: orderKey(file) };
    // An index-ish file is the *folder's own page* — but only for a page
    // folder. A category is just a container in ReadMe; it has no page of its
    // own, so an index.md sitting directly in one is an ordinary page.
    // Getting this wrong silently drops the file.
    const inPageFolder = parts.length >= 2;
    if (isIndexName(stem) && inPageFolder && !node.index) node.index = entry;
    else node.files.push(entry);
  }

  // ---- emit ----------------------------------------------------------------
  const sortEntries = (a, b) =>
    (a.order - b.order) || String(a.slug || a.stem).localeCompare(String(b.slug || b.stem));

  function emitChildren(node, basePath, depth) {
    const kids = [];

    for (const f of node.files) {
      kids.push({ kind: 'page', order: f.order, slug: f.doc.slug, entry: f });
    }
    for (const [name, sub] of node.dirs) {
      kids.push({
        kind: 'folder', order: orderKey(name), name,
        // Always the folder name: "authentication/index.docx" is the
        // authentication page, not a page called "index".
        slug: slugifyName(name), sub,
      });
    }
    kids.sort(sortEntries);

    // Two files in one folder can reduce to the same slug — "01-setup.docx"
    // and "setup.md", or names differing only by case. Without this they
    // overwrite each other in the zip and one document is silently lost.
    const used = new Set();
    for (const k of kids) {
      let slug = k.slug || 'page';
      if (used.has(slug.toLowerCase())) {
        let n = 2;
        while (used.has((slug + '-' + n).toLowerCase())) n++;
        report.warnings.push(
          'two documents in "' + basePath.replace(/^docs\//, '') + '" both became "'
          + slug + '" — the second is now "' + slug + '-' + n + '".');
        slug = slug + '-' + n;
      }
      used.add(slug.toLowerCase());
      k.slug = slug;
    }

    out.push({ path: basePath + '/_order.yaml', text: kids.map((k) => yamlItem(k.slug)).join('') });

    for (const k of kids) {
      if (k.kind === 'page') {
        out.push({ path: basePath + '/' + k.slug + '.md', text: k.entry.doc.body });
        emitAssets(k.entry.doc, basePath);
        report.pages++;
      } else {
        // ReadMe caps nesting at three page levels below a category.
        if (depth >= 3) {
          report.warnings.push(
            '"' + k.name + '" is deeper than ReadMe\'s three page levels — flattened up.');
          flattenInto(k.sub, basePath, k.slug);
          continue;
        }
        const folder = basePath + '/' + k.slug;
        if (k.sub.index) {
          out.push({ path: folder + '/index.md', text: k.sub.index.doc.body });
          emitAssets(k.sub.index.doc, folder);
        } else {
          out.push({ path: folder + '/index.md', text: stubPage(k.name) });
          report.stubs++;
        }
        report.parents++;
        emitChildren(k.sub, folder, depth + 1);
      }
    }
  }

  function flattenInto(node, basePath, prefix) {
    for (const f of node.files) {
      out.push({ path: basePath + '/' + prefix + '-' + f.doc.slug + '.md', text: f.doc.body });
      emitAssets(f.doc, basePath);
      report.pages++;
    }
    if (node.index) {
      out.push({ path: basePath + '/' + prefix + '.md', text: node.index.doc.body });
      emitAssets(node.index.doc, basePath);
      report.pages++;
    }
    for (const [name, sub] of node.dirs) flattenInto(sub, basePath, prefix + '-' + slugifyName(name));
  }

  /* Images extracted from a member document are written beside the page that
   * references them, so the relative ![](images/…) path in the body resolves.
   * Dropping them left every synced page with a broken image. */
  function emitAssets(doc, basePath) {
    for (const asset of doc.assets || []) {
      const path = basePath + '/' + asset.path;
      if (out.some((f) => f.path === path)) continue;
      out.push({ path, data: asset.data });
      report.assets = (report.assets || 0) + 1;
    }
  }

  const categories = [...root.dirs.keys()];
  for (const cat of categories) {
    report.categories.push(cat);
    emitChildren(root.dirs.get(cat), 'docs/' + cat, 1);
  }
  out.unshift({ path: 'docs/_order.yaml', text: categories.map(yamlItem).join('') });

  // ---- OpenAPI specs ride along untouched ----------------------------------
  if (specs && specs.length) {
    for (const s of specs) {
      out.push({ path: 'reference/' + s.path.split('/').pop(), data: s.data });
    }
    out.push({
      path: 'reference/_order.yaml',
      text: specs.map((s) => yamlItem(s.path.split('/').pop().replace(SPEC_EXT, ''))).join(''),
    });
    report.specs = specs.length;
  }

  return { files: out, report };
}

function slugifyName(name) {
  return (window.docx2readme ? window.docx2readme.slugify(stripNumPrefix(name))
                             : stripNumPrefix(name).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}

function stubPage(name) {
  // A folder with no index-ish document still needs a parent page to hang the
  // children off. Emit a titled placeholder rather than inventing prose.
  return '---\ntitle: "' + String(name).replace(/"/g, '\\"') + '"\nhidden: true\n---\n';
}

window.gitSync = { buildGitSync, isIndexName, stripNumPrefix, orderKey };
