#!/usr/bin/env python3
"""Write a small, dependency-free PDF for testing the PDF path.

pdf.js is what turns a PDF into positioned glyphs, and the unit tests feed
that shape in directly. This exists for the other half: checking that a real
PDF, read by real pdf.js, under the page's real Content-Security-Policy,
comes out the way the unit tests say it should.

Two pages: a title page that should be dropped, then a content page with a
heading ladder, a running header and footer that should be dropped, a
monospace block that should become a fenced code block, and three columns
that should become a table.

    python3 tests/fixtures/make-pdf.py sample.pdf
"""
import sys
import zlib

# (text, x, y-from-bottom, font, size)
PAGES = [
    [
        ("Open Finance API", 150, 520, "F1", 26),
        ("Integration Guide", 175, 470, "F1", 20),
        ("Version 1.5  |  June 2026", 200, 430, "F1", 12),
    ],
    [
        ("Celcoin - Confidential", 72, 760, "F1", 8),
        ("Introduction", 72, 700, "F1", 18),
        ("This guide explains how to obtain a token and call the payment", 72, 670, "F1", 11),
        ("initiation endpoint. Every request is authenticated with mutual", 72, 654, "F1", 11),
        ("TLS in addition to the bearer token.", 72, 638, "F1", 11),
        ("Step 1 - Obtain a token", 72, 600, "F1", 14),
        ("Send the following request to the identity server:", 72, 574, "F1", 11),
        ("curl -X POST https://iam.example.com/token \\", 72, 548, "F2", 10),
        ("  --cert client.crt --key client.key \\", 72, 534, "F2", 10),
        ("  -d 'grant_type=client_credentials'", 72, 520, "F2", 10),
        ("Response fields", 72, 484, "F1", 14),
        ("Field", 72, 458, "F1", 11),
        ("Type", 240, 458, "F1", 11),
        ("Description", 380, 458, "F1", 11),
        ("access_token", 72, 440, "F1", 11),
        ("string", 240, 440, "F1", 11),
        ("Short-lived bearer token", 380, 440, "F1", 11),
        ("expires_in", 72, 422, "F1", 11),
        ("number", 240, 422, "F1", 11),
        ("Lifetime in seconds", 380, 422, "F1", 11),
        ("Pass the token as Authorization: Bearer <access_token> and send", 72, 386, "F1", 11),
        ("{\"amount\": 1000} as the request body.", 72, 370, "F1", 11),
        ("2", 300, 40, "F1", 9),
    ],
    [
        ("Celcoin - Confidential", 72, 760, "F1", 8),
        ("Error codes", 72, 700, "F1", 18),
        ("The service returns the codes below. Long explanations are wrap-", 72, 670, "F1", 11),
        ("ped across lines by the layout engine.", 72, 654, "F1", 11),
        ("Code", 72, 620, "F1", 11),
        ("Status", 240, 620, "F1", 11),
        ("Meaning", 380, 620, "F1", 11),
        ("PAY.0000", 72, 602, "F1", 11),
        ("200", 240, 602, "F1", 11),
        ("Success", 380, 602, "F1", 11),
        ("PAY.0002", 72, 584, "F1", 11),
        ("400", 240, 584, "F1", 11),
        ("Invalid parameters", 380, 584, "F1", 11),
        ("3", 300, 40, "F1", 9),
    ],
]


def escape(s):
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def content(items):
    out = ["BT"]
    for text, x, y, font, size in items:
        out.append("/%s %d Tf" % (font, size))
        out.append("1 0 0 1 %d %d Tm" % (x, y))
        out.append("(%s) Tj" % escape(text))
    out.append("ET")
    return "\n".join(out).encode("latin-1")


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "sample.pdf"
    objects = {}
    n_pages = len(PAGES)
    page_ids = [4 + 2 * i for i in range(n_pages)]

    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[2] = ("<< /Type /Pages /Count %d /Kids [%s] >>" % (
        n_pages, " ".join("%d 0 R" % p for p in page_ids))).encode()
    objects[3] = (b"<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> "
                  b"/F2 << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >>")
    for i, items in enumerate(PAGES):
        pid, sid = page_ids[i], page_ids[i] + 1
        objects[pid] = ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                        "/Resources 3 0 R /Contents %d 0 R >>" % sid).encode()
        stream = zlib.compress(content(items))
        objects[sid] = (b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(stream)
                        + stream + b"\nendstream")

    body, offsets = b"%PDF-1.4\n", {}
    for num in sorted(objects):
        offsets[num] = len(body)
        body += b"%d 0 obj\n" % num + objects[num] + b"\nendobj\n"

    xref_at = len(body)
    high = max(objects) + 1
    body += b"xref\n0 %d\n" % high
    body += b"0000000000 65535 f \n"
    for num in range(1, high):
        body += b"%010d 00000 n \n" % offsets.get(num, 0)
    body += (b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
             % (high, xref_at))

    with open(out_path, "wb") as fh:
        fh.write(body)
    print("wrote %s (%d pages, %d bytes)" % (out_path, n_pages, len(body)))


if __name__ == "__main__":
    main()
