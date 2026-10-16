#!/usr/bin/env python3
"""Deterministic real->synthetic remap of account identifiers.

Safety rules, each one earned by a bug or false positive this repo produced:

1. LONGEST FIRST. Four real values contain another real value as a substring
   (LONG1/SHORT1, LONG2/SHORT2, LONG3/SHORT3, LONG4/SHORT4). Substituting short
   first truncates the 6-digit legs and silently breaks the transfer-pair tests.
2. DIGIT BOUNDARIES ONLY. `<REDACTED:4>` occurs inside a git SHA and inside `<REDACTED:6>`;
   `<REDACTED:4>` inside the merchant `McDonalds <REDACTED:4>01`; `<REDACTED:4>` inside the fixture
   `1234567<REDACTED:4>23456`. A bare str.replace would corrupt all of them.
3. PORT ALLOWLIST. `<REDACTED:4>` is both a real account suffix AND the chrome CDP
   forward port. Files where <REDACTED:4> is a port are never touched.
4. SAME-LENGTH TARGETS, so `A/C ending 7222` keeps the shape parsers key on.
5. LAST-4 PAIRING PRESERVED. The parsers pair a short suffix with a full account
   number by their shared tail, so each long target's last 4 must equal its short
   partner. An earlier map missed this and 2 tests caught it.
6. EMBEDDED REFERENCES FIRST. A real FAST reference appears inside a DBS
   reference as its middle segment, and that shared segment is the only identity
   the two alerts have. Rule 2's digit-boundary guard rejects a value sitting
   between digits, so whole references are replaced before bare tokens.
7. NEVER REWRITE THIS FILE. It is both a tool and a source of the map. An
   earlier version rewrote its own keys into their own targets, after which it
   could no longer match real values and reported "0 changes" while real data
   sat unscrubbed.

The real values live in a git-ignored JSON file, never in this source: see
scripts/pii_patterns.py. This file therefore contains no PII and is safe to
commit to a public repository.

Usage: python3 scripts/redact-pii.py [--check]
"""
import argparse
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pii_patterns  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

try:
    _p = pii_patterns.load()
except pii_patterns.PatternsMissing as exc:
    print(f"redact-pii: cannot run — {exc}", file=sys.stderr)
    raise SystemExit(2)

MAPPING = _p["remap"]
PAIRS = _p["pairs"]
EMBEDDED = _p["embedded"]
PORT_ALLOWLIST = _p["port_allowlist"]

# Rule 7: the map, the gate, the self-test, and the pattern loader must not be
# rewritten. The example file is the template; it holds the real values too.
SELF_EXEMPT = {
    "scripts/redact-pii.py",
    "scripts/verify-remap-safety.py",
    "scripts/check-no-pii.py",
    "scripts/test-check-no-pii.py",
    "scripts/pii_patterns.py",
    "scripts/.pii-patterns.local.json.example",
}
LONGEST_FIRST = sorted(MAPPING, key=len, reverse=True)

SKIP_DIRS = ("node_modules/", "/.git/", "__pycache__/", "package-lock", "/dist/")
MAX_BYTES = 2_000_000


def tracked_files():
    out = subprocess.run(
        ["git", "-C", ROOT, "ls-files"], capture_output=True, text=True, check=True
    ).stdout.splitlines()
    for rel in out:
        if any(s in "/" + rel for s in SKIP_DIRS) or rel in SELF_EXEMPT:
            continue
        yield rel


def remap_text(text, rel, report):
    """Apply the mapping to one file's text. Returns (new_text, report)."""
    allowed = set()
    for value, files in PORT_ALLOWLIST.items():
        if rel in files:
            allowed.add(value)

    # Rule 6: whole references first, so an embedded value is caught even though
    # the bare pass would reject it for having digits on both sides.
    for whole_real, whole_synth in EMBEDDED:
        if whole_real in text:
            n = text.count(whole_real)
            report.append((rel, whole_real, whole_synth, n))
            text = text.replace(whole_real, whole_synth)

    # Rule 1 + 2: longest first, digit-boundary guarded.
    for real in LONGEST_FIRST:
        if real in allowed:
            continue
        pattern = re.compile(rf"(?<![0-9]){re.escape(real)}(?![0-9])")
        new, n = pattern.subn(MAPPING[real], text)
        if n:
            report.append((rel, real, MAPPING[real], n))
            text = new
    return text, report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="report what would change; do not write")
    args = ap.parse_args()

    report = []
    for rel in tracked_files():
        path = os.path.join(ROOT, rel)
        if not os.path.isfile(path) or os.path.getsize(path) > MAX_BYTES:
            continue
        try:
            original = open(path, encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            continue
        new, report = remap_text(original, rel, report)
        if new != original and not args.check:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(new)

    per_value = {}
    for rel, real, synth, n in report:
        per_value.setdefault((real, synth), {}).setdefault(rel, 0)
        per_value[(real, synth)][rel] += n

    total = sum(n for _, _, _, n in report)
    files = sorted({rel for rel, _, _, _ in report})
    print(f"redact-pii: {'would change' if args.check else 'changed'} "
          f"{total} occurrence(s) across {len(files)} file(s)")
    for (real, synth), where in sorted(per_value.items(), key=lambda kv: -sum(kv[1].values())):
        n = sum(where.values())
        shown = real if len(real) <= 6 else real[:2] + "…" + real[-2:]
        print(f"  {shown:>8s} -> {synth:<16s} {n:4d}  {len(where)} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
