# doc2readme

**Word, PDF, HTML and Markdown → ReadMe-ready Markdown, entirely in your browser.**

### → [Open the converter](https://aerdman1.github.io/doc2readme/)

Drop a `.docx`, a `.pdf`, an HTML export, or Markdown you already have. Get
back clean Markdown to paste into ReadMe — or a `.zip` that drops straight into
a git-synced repo.

---

## Nothing is uploaded

No server, no account, no sign-in. The page ships a Content-Security-Policy of
`connect-src 'none'`, so the browser itself blocks it from making any network
request. Your document staying private isn't a policy — the page isn't capable
of sending it anywhere. It also works offline.

---

## What it fixes

**Code samples become real code blocks.** Word has no code block, so people
paste cURL into a Courier paragraph and indent it. That gets detected,
reassembled, and fenced with the language tagged.

**A bug you probably don't know you have.** Word's AutoCorrect turns straight
quotes into curly ones as someone types a cURL command. It looks fine in Word
and fails the moment a developer copies it. Repaired inside code blocks.

**Output is valid MDX.** ReadMe builds pages as MDX, where a stray
`<YOUR_API_KEY>` in body text is read as a JSX tag, a bare `{` opens a
JavaScript expression, and an `<!-- HTML comment -->` is a syntax error —
any of which takes the whole page down. All three are neutralised, in body
text, headings, table cells and list items, for every input format. Code
blocks and code spans are left exactly as written, because MDX does not look
inside them.

**Structure is cleaned up.** Cover page, revision history and table of contents
dropped. Heading levels remapped for ReadMe's title and contents panel.
Repeated boilerplate headings ("Example request", "Response") stop crowding the
sidebar.

**Tables, images, callouts.** Merged cells expanded, body images extracted,
page logos skipped, warning notes turned into ReadMe callouts.

Every change is listed in a summary after conversion, and **Preview** shows
roughly how the page will look.

---

## HTML exports

Confluence, Zendesk, static-site builds and Word's own "Save as Web Page" all
produce HTML, and all of it arrives buried in chrome.

- Navigation, sidebars, breadcrumbs, "on this page" widgets, cookie banners and
  footers are dropped. If the page has a `<main>` or `<article>`, that's what
  gets read.
- **Word HTML** gets special handling, because Word doesn't emit real headings:
  `MsoHeading1..6` become actual `<h1>`–`<h6>`, its table of contents is
  dropped, pseudo-lists (a paragraph starting with a bullet glyph) become real
  list items, runs of `&nbsp;` padding collapse, and `<o:p>`/VML leftovers go.
- Spacer images and tracking pixels from Word's `_files` sidecar folder are
  skipped.
- `<pre>` keeps its language from a `language-*` or `data-lang` class.
- Images already on full URLs keep working; relative ones are flagged.

---

## Converting a whole folder

Zip a folder and drop it in. You get back the layout git-sync expects:

```
docs/
  _order.yaml                categories, in order
  Getting Started/
    _order.yaml              pages, in order
    installation.md
    authentication/          a page with children is a folder…
      index.md               …and its own content lives here
      oauth.md
reference/
  api.yaml                   OpenAPI files, copied through
```

- Top-level folders become categories; subfolders become nested pages.
- `index`, `overview`, `intro` or `readme` inside a subfolder becomes that
  page's content. Without one you get a placeholder parent page.
- Numeric prefixes (`01-`, `02-`) set the order and are stripped from titles.
  The filenames themselves stay clean, because in a synced repo the filename
  *is* the page slug — `_order.yaml` is what carries the order.
- Files loose at the top level of the zip go into a `Documentation` category;
  name it something else with **Category folder**.
- Mixed `.docx`, `.pdf`, `.html` and `.md` in one zip is fine, and images
  extracted from any of them are written next to the page that uses them.

Commit the `docs/` folder to a repo connected to ReadMe and it publishes.

---

## Already have Markdown?

Switch to the **Markdown** tab — drop files or paste directly.

Worth doing even when it looks fine: Markdown written for GitHub routinely
breaks as MDX. This escapes stray `<PLACEHOLDER>` tags and bare braces (leaving
real components, JSX attributes like `columns={2}`, autolinks and code alone),
closes `<br>` into `<br />`, removes HTML comments MDX cannot parse, normalises
callouts, and fixes heading levels.

### Broken `<Table>` cells

Paste a page whose tables look like this and they come back rebuilt:

```
<td>
  **Fields:**<br /><br /><ul><li>one</li><br /><li>two</li><br /><ul>
</td>
```

becomes

```
<td>
  **Fields:**

  - one
  - two
</td>
```

That shape is what ReadMe's own legacy-to-MDX migration left behind: it renders
a cell to HTML and strips the newlines, so every list in a table cell became
one long line of `<ul>/<li>`. Hand-editing those is how they end up with an
unclosed `</li`, a `<ul>` typed where `</ul>` was meant, or a tag cut off
mid-name. All three are repaired, `<br />` used as list spacing is dropped, and
nested lists keep their nesting.

Two behaviours are copied from ReadMe's editor on purpose, so that opening the
page and saving it produces no diff: cells hold Markdown rather than HTML, and a
table whose every cell is a single line of text comes back as an ordinary pipe
table. Content the source had already lost cannot be recovered — the report
says how many tags it had to repair, so you know which cells to read.

A page that already has ReadMe frontmatter keeps it — `excerpt`, `icon`,
`deprecated` and the whole nested `metadata:` block ride through untouched, and
its declared `slug` names the output file so published URLs don't move.

---

## Two things to know

**Images need one manual step.** The page can't reach ReadMe, so extracted
images go into `images/` in the zip with relative paths. Upload them and swap
in the real URLs. Images that were already full URLs are left alone.

**PDFs are approximate.** A `.docx` records that a paragraph *is* Heading 2; a
PDF only records glyphs at coordinates. Headings, tables and code blocks are
rebuilt from font sizes and layout — good on text PDFs, shakier on complex
ones. Read PDF output more carefully. Scanned PDFs need OCR first and are
rejected with a clear message.

---

## Limits

- It reproduces your document faithfully; it won't reorganise a badly organised
  one. **Skim the output** — minutes, not hours.
- Text boxes, SmartArt, charts and equations aren't extracted. Missing, not
  garbled.
- `.doc` and `.docm` need resaving as `.docx` (Word: File → Save As).
- Preview is an approximation, not ReadMe's editor.

---

## Requirements

A current browser — Chrome/Edge 103+, Firefox 113+, Safari 16.4+. Nothing to
install. Defaults suit most documents; **More options** covers category, page
splitting, heading depth, boilerplate headings and callout style.

PDF reading uses [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0),
bundled in `vendor/` rather than loaded from a CDN so the page keeps working
offline and never contacts a third party. It is pdf.js's *legacy* build, which
is what keeps the Chrome 103 floor honest — see `vendor/README.md`.

---

## Working on it

The page ships as plain files with no build step for the browser; `build.py`
only stamps cache-busting hashes and produces the single-file copy.

```
npm install     # once — jsdom, for the tests
npm test        # the suite
npm run build   # test, stamp index.html, rebuild doc2readme.html, re-verify
```

The tests run the shipped files unmodified inside jsdom, so they exercise what
is actually served. They cover each reader (Word, PDF, HTML, Markdown), the zip
→ git-sync layout, the page itself, and one suite that pushes the same hostile
text through all four inputs and asserts none of it can break an MDX build — so
a fix in one reader can't quietly be missing from the other three. The PDF
suite runs twice: once on synthetic glyph positions to pin the layout
heuristics, and once on a real generated PDF through real pdf.js.

Always run `npm run build` before pushing. GitHub Pages serves assets with a
ten-minute cache and no fingerprinting, so an unstamped change can leave a
visitor with a new `index.html` and a stale `app.js` — which looks exactly like
broken code and isn't.
