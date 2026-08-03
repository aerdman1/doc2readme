# vendor/

`pdf.mjs` and `pdf.worker.mjs` are Mozilla's [pdf.js](https://mozilla.github.io/pdf.js/)
v4.10.38, Apache-2.0 licensed. See `LICENSE-pdfjs.txt`.

They are committed here rather than loaded from a CDN so the page keeps working
offline and never contacts a third party. The strict Content-Security-Policy
would block a CDN anyway — that is the point.

## Why the legacy build

These are the **legacy** build (`pdfjs-dist@4.10.38/legacy/build/`), not the
default one. The default build calls `Promise.withResolvers`, which needs
Chrome 119, Firefox 121 or Safari 17.4 — well above the Chrome 103 / Firefox
113 / Safari 16.4 floor the rest of the page supports and advertises. On an
older-but-still-supported browser, dropping a PDF failed with
`Promise.withResolvers is not a function`, which reads as a broken tool.

The legacy build bundles the polyfills (core-js, MIT) that close that gap. It
is roughly twice the size, which costs nothing on the hosted page — pdf.js is
imported only when someone actually drops a PDF — and adds about 1.3 MB to the
single-file build. That is the price of the stated browser support being true.

`tests/build.test.js` fails if these are ever swapped for the default build.

To upgrade:

    npm pack pdfjs-dist@<version>
    # copy legacy/build/pdf.mjs and legacy/build/pdf.worker.mjs into here
    npm test
