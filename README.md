# doc2readme

**Word, PDF and Markdown → ReadMe-ready Markdown, entirely in your browser.**

### → [Open the converter](https://aerdman1.github.io/doc2readme/)

Drop a `.docx`, a `.pdf`, or Markdown you already have. Get back clean Markdown
to paste into ReadMe — or a `.zip` that drops straight into a git-synced repo.

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
`<YOUR_API_KEY>` in body text is read as a JSX tag and takes the whole page
down. Everything is escaped so that can't happen — checked against ReadMe's own
compiler.

**Structure is cleaned up.** Cover page, revision history and table of contents
dropped. Heading levels remapped for ReadMe's title and contents panel.
Repeated boilerplate headings ("Example request", "Response") stop crowding the
sidebar.

**Tables, images, callouts.** Merged cells expanded, body images extracted,
page logos skipped, warning notes turned into ReadMe callouts.

Every change is listed in a summary after conversion, and **Preview** shows
roughly how the page will look.

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
- Mixed `.docx`, `.pdf` and `.md` in one zip is fine.

Commit the `docs/` folder to a repo connected to ReadMe and it publishes.

---

## Already have Markdown?

Switch to the **Markdown** tab — drop files or paste directly.

Worth doing even when it looks fine: Markdown written for GitHub routinely
breaks as MDX. This escapes stray `<PLACEHOLDER>` tags (leaving real components
and code alone), closes `<br>` into `<br />`, normalises callouts, and fixes
heading levels.

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
offline and never contacts a third party.
