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
ASSETS = ["styles.css", "preview.js", "md-clean.js", "mdx-table.js", "html-extract.js", "gitsync.js",
          "pdf-extract.js",
          "converter.js", "app.js", "table-wizard.js"]


def digest(name):
    with open(os.path.join(HERE, name), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:8]


SCRIPTS = ["preview.js", "md-clean.js", "mdx-table.js", "html-extract.js", "gitsync.js", "pdf-extract.js",
           "converter.js", "app.js", "table-wizard.js"]
DECL = re.compile(r"^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)",
                  re.M)


def check_globals():
    """Classic scripts share one global scope, so two files declaring the same
    top-level name is a SyntaxError and the *second* file silently never runs —
    which presents as dead buttons, not as an error. This has bitten three
    times (esc, mode, stripFrontmatter); fail the build instead."""
    seen, clashes = {}, []
    for name in SCRIPTS:
        with open(os.path.join(HERE, name), encoding="utf-8") as fh:
            for ident in DECL.findall(fh.read()):
                if ident in seen:
                    clashes.append("%s declared in both %s and %s" % (ident, seen[ident], name))
                else:
                    seen[ident] = name
    if clashes:
        sys.exit("global collisions would break the page:\n  " + "\n  ".join(clashes))
    print("  %d top-level globals, no collisions" % len(seen))


def run_tests(files, label):
    """The suite is the reason the conversion rules can be changed at all.
    Skipped, with a visible note, when node or node_modules are absent — the
    build still has to work on a machine that has only Python."""
    if not os.path.isdir(os.path.join(HERE, "node_modules")):
        print("  %s skipped — run `npm install` once to enable them" % label)
        return
    try:
        proc = subprocess.run(["node", "--test"] + files, cwd=HERE,
                              capture_output=True, text=True)
    except FileNotFoundError:
        print("  %s skipped — node is not installed" % label)
        return
    if proc.returncode != 0:
        print(proc.stdout[-4000:])
        sys.exit("%s failed — stopping" % label)
    counts = [l[2:] for l in proc.stdout.splitlines()
              if l.startswith("# ") and l[2:].startswith(("tests", "pass", "fail"))]
    print("  %s: %s" % (label, ", ".join(counts)))


def behaviour_tests():
    """Everything except the artifact-freshness checks, which can only pass
    after this build has written the artifacts."""
    tests = os.path.join(HERE, "tests")
    return sorted(os.path.join("tests", f) for f in os.listdir(tests)
                  if f.endswith((".test.js", ".test.mjs")) and f != "build.test.js")


def main():
    check_globals()
    run_tests(behaviour_tests(), "tests")
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
    # Only now can these pass: they check that what was just written matches
    # the sources it was written from.
    run_tests(["tests/build.test.js"], "artifact checks")


if __name__ == "__main__":
    main()
