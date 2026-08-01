#!/usr/bin/env python3
"""Build step: stamp asset URLs with a content hash, then build the single file.

Why this exists. GitHub Pages serves every file with `Cache-Control: max-age=600`
and no fingerprinting. A visitor who has been here before can end up with a
fresh index.html and a ten-minute-old styles.css/app.js — which renders as an
unstyled logo at its full intrinsic size and buttons whose handlers never
attached. It looks exactly like broken code and is not.

Stamping each reference with a hash of the file's own contents means a changed
asset is a different URL, so the browser cannot serve a stale one.

Run this instead of build-single-file.py:  python3 build.py
"""
import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = ["styles.css", "preview.js", "pdf-extract.js", "converter.js", "app.js"]


def digest(name):
    with open(os.path.join(HERE, name), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:8]


def main():
    path = os.path.join(HERE, "index.html")
    with open(path, encoding="utf-8") as fh:
        page = fh.read()

    changed = []
    for asset in ASSETS:
        want = digest(asset)
        # match the asset with or without an existing ?v= stamp
        pattern = re.compile(r'((?:href|src)=")' + re.escape(asset) + r'(?:\?v=[0-9a-f]+)?(")')
        if not pattern.search(page):
            sys.exit("index.html does not reference %s" % asset)
        page, n = pattern.subn(lambda m: m.group(1) + asset + "?v=" + want + m.group(2), page)
        changed.append("%s?v=%s (%d ref)" % (asset, want, n))

    with open(path, "w", encoding="utf-8") as fh:
        fh.write(page)
    for c in changed:
        print("  stamped " + c)

    print()
    subprocess.run([sys.executable, os.path.join(HERE, "build-single-file.py")], check=True)


if __name__ == "__main__":
    main()
