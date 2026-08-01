# vendor/

`pdf.mjs` and `pdf.worker.mjs` are Mozilla's [pdf.js](https://mozilla.github.io/pdf.js/)
v4.10.38, Apache-2.0 licensed. See `LICENSE-pdfjs.txt`.

They are committed here rather than loaded from a CDN so the page keeps working
offline and never contacts a third party. The strict Content-Security-Policy
would block a CDN anyway — that is the point.
