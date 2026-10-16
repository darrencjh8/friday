#!/usr/bin/env python3
"""Regenerate scripts/pii-patterns.hashed.json from the git-ignored plaintext
scripts/.pii-patterns.local.json. The output holds only salted SHA-256 digests,
lengths and labels, never a real value, so it is safe to commit.

Run: python3 scripts/hash-pii-patterns.py [--check]
--check exits 1 if the committed file is stale instead of rewriting it.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pii_patterns  # noqa: E402

try:
    raw = pii_patterns.load()
except pii_patterns.PatternsMissing as exc:
    print(f"hash-pii-patterns: {exc}", file=sys.stderr)
    sys.exit(2)

hashed, counts = pii_patterns.build_hashed(raw)
text = json.dumps(hashed, indent=1, sort_keys=True) + "\n"
# Labels and synthetic targets are written in clear: refuse if one holds a real value.
leaks = [v for v in raw["forbidden"] if v in text]
if leaks:
    print(f"hash-pii-patterns: REFUSED — {len(leaks)} real value(s) would appear "
          "in the output (a label or target contains one)", file=sys.stderr)
    sys.exit(1)

out = pii_patterns.HASHED_PATH
if "--check" in sys.argv:
    cur = open(out, encoding="utf-8").read() if os.path.isfile(out) else ""
    print("hashed file is current" if cur == text else "hashed file is STALE")
    sys.exit(0 if cur == text else 1)
with open(out, "w", encoding="utf-8") as fh:
    fh.write(text)
print(f"wrote {out}: {len(hashed['forbidden'])} hashed")
print("buckets: " + ", ".join(f"{k}={v}" for k, v in counts.items())
      + "  (short and word stay local-only, never committed)")
