#!/usr/bin/env python3
"""Inline every asset — including pdf.js — into one self-contained
doc2readme.html.

The multi-file version is what you host. This single-file build is what you
email, drop on a share, or hand to someone who wants to keep a copy — it opens
by double-clicking, works with no internet, and has nothing to install.

Inlining forces script-src/style-src 'unsafe-inline', but the guarantee that
actually matters is unchanged and still enforced by the browser: connect-src
allows exactly one origin, https://files.readme.io, and it is only ever read
from. Your documents still go nowhere.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def js_string(text):
    """Embed arbitrary JS source as a JS string literal."""
    return json.dumps(text)


def read(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        return fh.read()


def main():
    page = read("index.html")
    css = read("styles.css")
    converter = read("converter.js")
    app = read("app.js")
    pdfextract = read("pdf-extract.js")
    preview = read("preview.js")
    mdclean = read("md-clean.js")
    mdxtable = read("mdx-table.js")
    gitsync = read("gitsync.js")
    htmlx = read("html-extract.js")
    tablewizard = read("table-wizard.js")
    readmeexport = read("readme-export.js")
    docxrender = read("docx-render.js")
    readme2word = read("readme2word.js")

    for name, body in (("converter.js", converter), ("app.js", app),
                       ("pdf-extract.js", pdfextract),
                       ("preview.js", preview),
                       ("md-clean.js", mdclean),
                       ("mdx-table.js", mdxtable),
                       ("gitsync.js", gitsync),
                       ("html-extract.js", htmlx),
                       ("table-wizard.js", tablewizard),
                       ("readme-export.js", readmeexport),
                       ("docx-render.js", docxrender),
                       ("readme2word.js", readme2word)):
        # A literal </script> inside a JS string would close the tag early.
        if "</script" in body.lower():
            sys.exit("%s contains a literal </script> — escape it first" % name)

    page = re.sub(r'<link rel="stylesheet" href="styles\.css(?:\?v=[0-9a-f]+)?">',
                  lambda m: "<style>\n" + css + "</style>", page, count=1)
    # pdf.js is an ES module plus a worker, so it cannot simply be pasted in.
    # Embed both as strings, hand them to the page as blob: URLs, and point the
    # converter at those instead of vendor/ paths.
    pdflib = read(os.path.join("vendor", "pdf.mjs"))
    pdfworker = read(os.path.join("vendor", "pdf.worker.mjs"))
    boot = (
        "\n/* pdf.js, inlined. Same files as vendor/, handed to the page as\n"
        "   blob: URLs so this one file needs nothing beside it. */\n"
        "(function () {\n"
        "  var mk = function (src) {\n"
        "    return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));\n"
        "  };\n"
        "  window.__PDFJS_LIB_URL__ = mk(" + js_string(pdflib) + ");\n"
        "  window.__PDFJS_WORKER_URL__ = mk(" + js_string(pdfworker) + ");\n"
        "})();\n")

    script_block = re.compile(
        r'<script src="preview\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="md-clean\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="mdx-table\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="html-extract\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="gitsync\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="pdf-extract\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="converter\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="readme-export\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="docx-render\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="app\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="readme2word\.js(?:\?v=[0-9a-f]+)?"></script>\s*'
        r'<script src="table-wizard\.js(?:\?v=[0-9a-f]+)?"></script>')
    if not script_block.search(page):
        sys.exit("could not find the script block to inline")
    page = script_block.sub(
        lambda m: ("<script>\n" + boot + "\n</script>\n"
                   "<script>\n" + preview + "\n</script>\n"
                   "<script>\n" + mdclean + "\n</script>\n"
                   "<script>\n" + mdxtable + "\n</script>\n"
                   "<script>\n" + htmlx + "\n</script>\n"
                   "<script>\n" + gitsync + "\n</script>\n"
                   "<script>\n" + pdfextract + "\n</script>\n"
                   "<script>\n" + converter + "\n</script>\n"
                   "<script>\n" + readmeexport + "\n</script>\n"
                   "<script>\n" + docxrender + "\n</script>\n"
                   "<script>\n" + app + "\n</script>\n"
                   "<script>\n" + readme2word + "\n</script>\n"
                   "<script>\n" + tablewizard + "\n</script>"),
        page, count=1)

    # Inlining means the strict script-src/style-src can't apply. connect-src is
    # pinned to ReadMe's public image CDN and nothing else, so the page can pull
    # the pictures an export references and still cannot send anything anywhere.
    page = re.sub(
        r'<meta http-equiv="Content-Security-Policy"[^>]*>',
        '<meta http-equiv="Content-Security-Policy" content="'
        "default-src 'none'; script-src 'unsafe-inline' blob:; "
        "style-src 'unsafe-inline'; img-src 'self' data: blob: https://files.readme.io; "
        "connect-src https://files.readme.io; worker-src blob:; "
        "base-uri 'none'; form-action 'none'"
        '">',
        page, count=1)

    banner = (
        "<!--\n"
        "  doc2readme — single-file build. Nothing to install.\n"
        "  Open this file in a browser and drop Word or PDF documents on it.\n"
        "  Your document never leaves the tab: the Content-Security-Policy below\n"
        "  allows exactly one origin, https://files.readme.io, so the browser itself\n"
        "  blocks this page from reaching anywhere else. That one origin is ReadMe's\n"
        "  public image CDN, read from only when converting an export to Word.\n"
        "-->\n")
    page = page.replace("<!doctype html>\n", "<!doctype html>\n" + banner, 1)

    out = os.path.join(HERE, "doc2readme.html")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(page)

    # Check markup only — inlined JS legitimately contains src="/href=" inside
    # string literals, which would otherwise read as unresolved references.
    markup = re.sub(r"<script\b[^>]*>.*?</script>", "", page, flags=re.S)
    markup = re.sub(r"<style\b[^>]*>.*?</style>", "", markup, flags=re.S)
    leftover = re.findall(r'(?:src|href)="(?!data:|#)([^"]+)"', markup)
    if leftover:
        sys.exit("still references external files: %s" % ", ".join(leftover))

    print("wrote %s (%.0f KB, fully self-contained)" % (out, os.path.getsize(out) / 1024))


if __name__ == "__main__":
    main()
