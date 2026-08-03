# doc2readme

Word, PDF, HTML and Markdown → ReadMe-ready Markdown, entirely in the browser.
Hosted at <https://aerdman1.github.io/doc2readme/> (GitHub Pages, from `main`).

`README.md` is written for the people who *use* the converter. This file is for
whoever *changes* it.

## The one constraint everything else follows from

The page must never be able to make a network request. That is not a policy,
it is enforced: `index.html`, `vercel.json` and the single-file build all set
`connect-src 'none'`, so the browser itself blocks it. Users drop confidential
documents into this thing; the guarantee is the product.

Consequences, all deliberate:

- **No runtime dependencies, no bundler, no framework.** Plain classic scripts
  loaded in order by `index.html`. `jsdom` is a devDependency for tests only
  and never reaches a browser.
- **pdf.js is vendored**, not loaded from a CDN. A CDN would be blocked anyway.
- **Images can't be uploaded for the user.** They are written into the zip with
  relative paths and the UI says so.

Do not add a dependency that loads at runtime. Do not relax `connect-src`.

## Layout

```
index.html          the hosted page; loads the scripts below in this order
  preview.js        Markdown → HTML for the Preview modal (approximate, by design)
  md-clean.js       Markdown  → Block[]
  html-extract.js   HTML      → Block[]
  gitsync.js        pages     → the docs/ tree ReadMe git-sync expects
  pdf-extract.js    PDF       → Block[]  (pdf.js does the glyphs; this rebuilds structure)
  converter.js      .docx     → Block[], plus the shared passes and all rendering
  app.js            the UI
doc2readme.html     built artifact: the whole thing inlined into one file
build.py            test → stamp index.html → build the single file → re-verify
vendor/             pdf.js (legacy build — see vendor/README.md)
tests/
```

### The block model is the whole architecture

All four readers produce the same `Block[]`. From there the treatment is
identical: `applyPasses()` in `converter.js` runs cleanup (drop TOC/cover,
merge code, detect callouts, demote boilerplate headings, remap heading
levels), then `renderBlocks()` emits Markdown.

**Add a feature to the shared passes, not to a reader**, unless it genuinely
depends on the source format. A rule that lives in one reader is a rule the
other three are silently missing — that is where most of the bugs came from.

Block kinds: `heading` `para` `list` `code` `table` `callout` `blank` `toc`.

## Working on it

```
npm install     # once — jsdom
npm test        # 106 tests
npm run build   # tests, stamp, rebuild doc2readme.html, re-verify artifacts
```

**Always run `npm run build` before pushing.** GitHub Pages serves assets with
a ten-minute cache and no fingerprinting, so an unstamped change can leave a
returning visitor with a new `index.html` and a stale `app.js` — an unstyled
page whose buttons do nothing. It looks exactly like broken code and isn't.
`build.py` stamps every asset URL with a hash of its own contents, and
`tests/build.test.js` fails if `index.html` or `doc2readme.html` is stale.

### Tests

`tests/harness.js` stands the shipped files up inside jsdom and evals them in
the same order `index.html` does — so the tests exercise what is actually
served, not a refactored copy. Nothing in the source was restructured to make
it testable, except `applyPasses`/`renderBlocks` being exported (a real seam,
not a test hook) and `window.__setResults` in `app.js` (which is a test hook,
and says so).

| file | covers |
| --- | --- |
| `docx.test.js` `markdown.test.js` `html.test.js` `pdf.test.js` | one reader each |
| `mdx.test.js` | **the important one** — same hostile text through all four inputs |
| `archive.test.js` | zip → git-sync layout |
| `ui.test.js` | `index.html` + `app.js`: element ids, copy drift, tab/button alignment |
| `pdf-e2e.test.mjs` | a generated PDF through real pdf.js |
| `fixtures.test.js` | the real documents in the parent folder; **skips if absent** |
| `build.test.js` | artifact freshness, CSP, global collisions, legacy pdf.js |

Fixtures are built in code (`tests/harness.js` writes real `.docx` zips with
the shipped zip writer), so there are no binary blobs to keep in sync.

## Invariants worth knowing before you change anything

**ReadMe compiles every page as MDX.** A single unescaped character in body
text does not look wrong — the page fails to build and shows an error instead
of content. Three things do it:

- `<Anything>` — an unclosed JSX element
- `{anything}` — a JavaScript expression
- `<!-- comment -->` — not valid MDX at all

All three are neutralised in body text, headings, table cells and list items,
for all four inputs. Code blocks and code spans are left exactly as written,
because MDX does not look inside them. `mdx.test.js` is what keeps this true;
if you touch escaping, that suite is the one that matters.

**Escaping lives in `converter.js`.** `esc()` is the single implementation;
`html-extract.js` calls it through `window.docx2readme.escapeInline` so all
inputs escape identically. `md-clean.js` escapes differently on purpose — its
input is already Markdown, so it must preserve real components, JSX attributes
like `columns={2}`, autolinks and existing escapes.

**Underscores and pipes are deliberately not escaped.** GFM does not treat
intraword underscores as emphasis, and escaping them litters
`client\_credentials` through every API doc. `|` only matters inside a table,
where the table renderer escapes it.

**List indentation is computed from the parent marker**, not a fixed two
spaces. `1. ` puts content at column 3; a child indented two spaces is a
sibling in CommonMark and the nesting silently disappears.

**Code fences are widened** to exceed any fence inside the content. Markdown
documenting Markdown hits this immediately.

**In a synced repo the filename *is* the page slug.** Hence: no `slug:` in
frontmatter, split pages are named by slug rather than `01-`-prefixed, and a
source page's declared slug names the output file so published URLs don't move.

## Open decisions

**Frontmatter omits `slug`.** ReadMe's [documented schema][ds] for a synced
repo lists `title`, `excerpt`, `hidden`, `deprecated`, `icon`, `metadata`,
`next` — not `slug`. If you use the legacy `rdme docs upload` flow instead of
git sync, that flow *does* read `slug`, and you want it back: it is the
`OWNED_FRONTMATTER` set in `converter.js`.

**The live page has not been exercised by hand since the MDX hardening.** The
tests run in jsdom and the deployed assets were verified by HTTP, but nobody
has actually dropped a `.docx` and a PDF into the real page in a real browser.
Worth one manual pass. Nothing is known to be wrong.

[ds]: https://docs.readme.com/main/docs/documentation-structure

## PDF is the lossy one, and that is not fixable

A `.docx` records that a paragraph *is* Heading 2. A PDF records glyphs at
coordinates. Every structural decision — headings, tables, code, lists — is
inferred from font size and x/y position, with no ground truth to check
against. The rules in `pdf-extract.js` are tuned to read **conservatively**:
when a signal is ambiguous, emit a plain paragraph rather than guess a heading
or invent a table. Wrong-but-plain a human can fix; wrong-but-confident they
cannot even see.

Keep that bias if you tune the heuristics, and keep the UI's warning that PDF
output needs a closer read.

## House style

Match what is there. Comments explain *why*, especially where the code looks
odd because reality is odd (Word's AutoCorrect, its fake lists, its
`CxSpFirst` continuations, zip64 counters). Several comments record a specific
bug that a plausible-looking simplification would reintroduce — those are load
bearing. Prose in comments and UI copy is plain and unhedged; no exclamation
marks, no marketing.
