# doc2readme

**Turn Word documents, PDFs and existing Markdown into ReadMe-ready Markdown,
right in your browser.**

### → [Open the converter](https://aerdman1.github.io/doc2readme/)

Drop in a `.docx`, a `.pdf`, or Markdown you already have. Get back clean
Markdown you can paste straight into ReadMe — or a `.zip` that drops into a
ReadMe git-synced repository.

**Have a whole folder?** Zip it and drop that in. The folder structure becomes
your ReadMe structure, and you get back a ready-to-commit `docs/` tree.

---

## Your documents never leave your computer

There is no server. No upload. No account. No sign-in.

The page does all the work inside your browser tab, and it ships a
Content-Security-Policy of `connect-src 'none'` — which means the browser
itself blocks the page from making any network request at all. It is not
*policy* that your document stays private; the page is not technically capable
of sending it anywhere.

You can also save the page and run it with no internet connection.

---

## What it fixes

Copying a document into ReadMe by hand mostly means rebuilding tables and
re-indenting code samples. This handles that.

**Code samples become real code blocks.** Word has no concept of a code block —
people paste a cURL command into a paragraph, set it in Courier, and indent it.
That gets detected, reassembled, and turned into a proper fenced block with the
language tagged, so ReadMe highlights it and the copy button works.

**A bug you probably don't know you have.** Word's AutoCorrect quietly rewrites
straight quotes into curly ones while someone types a cURL command. It looks
perfect in Word and fails with a syntax error the moment a developer copies it
out of your docs. Those get repaired automatically inside code blocks.

**Cover pages, revision history and the table of contents are removed.**
ReadMe generates its own page title and contents panel, so all three are just
noise. (Optional — you can keep them.)

**Heading levels are fixed up.** ReadMe uses the page title as the H1, so the
body has to start one level down. Documents also skip levels constantly, which
breaks ReadMe's contents panel. Both get corrected.

**Repeated headings stop crowding the sidebar.** Reference docs style the same
labels under every endpoint. Left alone, ReadMe's contents panel fills up with
forty entries, eight of which say the same thing. Those become bold lead-in
text instead.

**Tables, images and callouts.** Tables convert with merged cells expanded.
Body images are extracted; page logos and watermarks are skipped. Warning and
note paragraphs become real ReadMe callout boxes.

**Output is checked against ReadMe's own MDX compiler.** ReadMe builds pages as
MDX, where a stray `<access_token>` in your text is read as a JSX tag and takes
the entire page down with a syntax error. Everything this produces — headings,
table cells, prose, URLs — is escaped so that can't happen.

**Preview before you publish.** The Preview button renders the converted page
approximately the way ReadMe will, so you can check structure without pasting
it in first. It is a close approximation, not ReadMe's editor.

Every change it makes is listed in the summary panel after conversion, so you
can see exactly what it did rather than diffing by hand.

---

## Converting a whole folder

Zip a folder of documents and drop the zip in. The layout you get back is what
ReadMe git-sync expects:

```
docs/
  _order.yaml                  your categories, in order
  Getting Started/
    _order.yaml                pages in this category, in order
    installation.md
    authentication/            a page with children is a folder…
      index.md                 …and its own content lives here
      _order.yaml
      oauth.md
reference/
  api.yaml                     any OpenAPI files, copied through untouched
```

- **Top-level folders become categories.** Subfolders become nested pages.
- **A file named `index`, `overview`, `intro` or `readme`** inside a subfolder
  becomes that page's own content. A subfolder without one gets a placeholder
  parent page so its children still have somewhere to hang.
- **Numeric prefixes set the order.** `01-intro.docx`, `02-setup.docx` produce
  an `_order.yaml` in that order, and the numbers are stripped from the titles.
  Without them, pages are ordered alphabetically — which is rarely the order
  you wrote them in.
- Mixed formats are fine; `.docx`, `.pdf` and `.md` can sit side by side.
- ReadMe allows three page levels below a category. Anything deeper is
  flattened up, and the summary tells you what moved.

Commit the `docs/` folder to a repo connected to ReadMe and it publishes.

---

## Already have Markdown?

Switch to the **Markdown** tab and drop `.md` files in, or paste straight into
the box.

This is worth doing even when the Markdown looks fine. ReadMe builds pages as
MDX, and Markdown written for GitHub is full of things MDX rejects — the most
common being placeholders like `<YOUR_API_KEY>` in body text, which MDX reads
as a JSX tag and refuses to build. Running it through here:

- escapes stray angle-bracket placeholders, while leaving real components,
  code blocks and code spans untouched
- closes void tags (`<br>` → `<br />`), which MDX also requires
- normalises callouts — both blockquote-with-emoji and `<Callout>` — into one
  consistent form
- fixes heading levels and repeated headings the same way it does for Word
- keeps existing frontmatter

---

## Images need one manual step

The page has no network access — that is the whole privacy guarantee — so it
cannot upload anything to ReadMe.

Images embedded in your document are extracted into an `images/` folder inside
the `.zip` and referenced by relative path. Upload them to ReadMe (or any
host) and swap those paths for the real URLs. Images that were already full
URLs in the source are left alone and keep working as-is.

---

## A note on PDFs

Word and PDF are not equally easy, and it is worth knowing why.

A `.docx` records *meaning*: this paragraph is Heading 2, this run is Courier
New, these cells belong to one table. A PDF records *glyphs at coordinates* —
there are no headings, no tables, no paragraphs in the file at all. All of that
has to be rebuilt from font sizes, spacing and column positions.

It works well on ordinary text PDFs, and it will not be perfect on complicated
layouts. **Read PDF output more carefully than Word output.** The summary panel
flags when a PDF was the source.

Scanned PDFs are pictures of text and contain no text to extract — those need
OCR before anything can convert them, and the page will tell you so.

---

## What it won't do

- It reproduces your document faithfully. It won't reorganise a document that's
  badly organised, and it can't tell that a section styled Heading 2 ought to be
  a top-level one. **Give the output a skim** — minutes, not hours.
- Text boxes, SmartArt, charts and equations aren't extracted. They'll be
  *missing* rather than garbled.
- `.doc` and `.docm` need to be resaved as `.docx` first (Word: File → Save As).
- Callouts are emitted as ReadMe `<Callout>` components by default, which is
  what most ReadMe projects use. Settings can switch to blockquote or plain.

---

## Requirements

A current browser — Chrome or Edge 103+, Firefox 113+, or Safari 16.4+.
Nothing to install.

Defaults suit most documents; **More options** covers category, page splitting,
heading depth, boilerplate headings and callout style if you need them.

---

PDF reading uses [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0),
bundled in `vendor/` rather than loaded from a CDN so the page keeps working
offline and never contacts a third party.
