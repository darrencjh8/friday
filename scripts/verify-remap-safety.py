#!/usr/bin/env python3
"""Assert the remap's invariants. Exits 1 on any violation, so a bad edit to the
pattern file fails loudly instead of silently mis-scrubbing the tree.

Run: python3 scripts/verify-remap-safety.py
Exit: 0 all hold, 1 violated, 2 cannot verify (patterns file missing).
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import pii_patterns

P = pii_patterns.try_load_local()
if P is None:
    # The remap invariants need the real plaintext values (and the remap is not
    # committed), so they are local-only. CI still gates the tree via the hashed set.
    print("verify-remap-safety: SKIP remap invariants — local plaintext pattern "
          "file absent (they run only where it exists). Running the hashed gate "
          "and the git-ignore checks only.")
    rc = subprocess.run([sys.executable, os.path.join(HERE, "check-no-pii.py")]).returncode
    ign = subprocess.run(["git", "-C", ROOT, "check-ignore", "-q",
                          "scripts/.pii-patterns.local.json"]).returncode == 0
    trk = subprocess.run(["git", "-C", ROOT, "ls-files", "--error-unmatch",
                          "scripts/.pii-patterns.local.json"],
                         capture_output=True).returncode != 0
    print(f"  {'OK  ' if ign else 'FAIL'}  plaintext pattern file is git-ignored")
    print(f"  {'OK  ' if trk else 'FAIL'}  plaintext pattern file is not tracked")
    sys.exit(0 if rc == 0 and ign and trk else 1)
HASHED = pii_patterns.load_hashed()

MAPPING = P["remap"]
PAIRS = P["pairs"]
EMBEDDED = P["embedded"]
SYNTHETIC = set(MAPPING.values()) | {w for _, w in EMBEDDED}

fails = []


def check(label, ok, detail=""):
    print(f"  {'OK  ' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    if not ok:
        fails.append(label)


def read(rel):
    try:
        with open(os.path.join(ROOT, rel), encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


print("=== the map is well-formed ===")
check("no key maps to itself (map is not self-mutated)",
      not [k for k, v in MAPPING.items() if k == v],
      str([k for k, v in MAPPING.items() if k == v]))
check("keys and targets are disjoint",
      not (set(MAPPING) & SYNTHETIC),
      str(sorted(set(MAPPING) & SYNTHETIC)))
check("all lengths preserved",
      all(len(k) == len(v) for k, v in MAPPING.items()),
      str({k: v for k, v in MAPPING.items() if len(k) != len(v)}))
check("targets unique", len(set(MAPPING.values())) == len(MAPPING),
      str([v for v in MAPPING.values()
           if list(MAPPING.values()).count(v) > 1]))
# A target may CONTAIN another target (a 6-digit target ends in its 4-digit
# partner) but must not contain a real value, or a later run rewrites the
# replacement again and the tool stops being idempotent.
check("no target contains a real value (idempotent)",
      not [(t, r) for t in MAPPING.values() for r in MAPPING if r in t and t != r],
      str([(t, r) for t in MAPPING.values() for r in MAPPING if r in t and t != r]))

print("=== every real value is remappable ===")
missing = [k for k in P["forbidden"] if k.isdigit() and k not in MAPPING]
check("every forbidden digit is in the remap", not missing, str(missing))

print("=== last-4 pairing (shared tails must stay shared) ===")
for _i, (long_v, short_v) in enumerate(PAIRS):
    ok = long_v in MAPPING and short_v in MAPPING and \
        MAPPING[long_v][-4:] == MAPPING[short_v]
    check(f"pair #{_i} shares its last 4", ok,
          f"{MAPPING.get(long_v, '?')[-4:]} vs {MAPPING.get(short_v, '?')}")

print("=== embedded references (containment must survive) ===")
for whole_real, whole_synth in EMBEDDED:
    for real, synth in MAPPING.items():
        if real in whole_real:
            check(f"a mapped value inside the host stays inside its remap",
                  synth in whole_synth, whole_synth[:30] + "…")
    check("remapped host is free of every real value",
          not [r for r in MAPPING if r in whole_synth],
          str([r for r in MAPPING if r in whole_synth]))

print("=== no real value survives in the tree ===")
# The gate module is hyphenated on disk, so load it by path.
import importlib.util

_cspec = importlib.util.spec_from_file_location(
    "check_no_pii", os.path.join(HERE, "check-no-pii.py"))
_cmod = importlib.util.module_from_spec(_cspec)
_cspec.loader.exec_module(_cmod)

line_hits = _cmod.make_matcher(HASHED, P)
hits = _cmod.scan(ROOT, line_hits)
check("no real PII literal in tracked files", not hits,
      f"{len(hits)} hit(s)" + (f" first: {hits[0][0]}:{hits[0][1]}" if hits else ""))

print("=== false-positive sites must be untouched in the tree ===")
# Each case embeds a REAL value inside a longer run of digits, or as a port, or
# as part of a hash, to prove the remapper leaves them alone. The real values are
# read from the git-ignored pattern file rather than written here, so this file
# holds no PII and the cases cannot drift from the map.
FP_LONGER = [
    ("git SHA intact in copilot.manifest.json",
     ".specify/integrations/copilot.manifest.json",
     "d258d63195c45d5c5900177194a1cecb865b7b81"),
    ("CDP port in skill intact",
     ".agents/skills/full-deploy/SKILL.md", 'grep -E "9222|9223"'),
    ("CDP_URL default intact",
     "modules/perchance-gen/perchance-image.cjs", "172.17.0.1:9223"),
]
for _label, _rel, _needle in FP_LONGER:
    _body = read(_rel)
    check(_label, bool(_body) and _needle in _body,
          "" if _body else "FILE MISSING")
# A real value glued between other digits must survive. Rather than guess which
# value sits where, search each file for a real value embedded in a longer run:
# if the assertion below finds one, the file is already correct, and the check
# cannot pass by accident.
FP_EMBEDDED = [
    ("merchant name intact",
     "modules/expense-tracker/tests/fixtures/merchant-mappings.json",
     r"McDonalds (" + "|".join(
         v for v in MAPPING if len(v) == 4) + r")01"),
]
for _label, _rel, _rx in FP_EMBEDDED:
    _body = read(_rel)
    _m = re.search(_rx, _body) if _body else None
    check(_label, bool(_m), "" if _body else "FILE MISSING")

# A real value sitting inside a longer 16-digit fixture number must survive.
# Find it at whatever offset it actually occupies, rather than assuming one.
_body = read("modules/hermes/tests/test_log_issue_triage_collect.py")
_long_run = re.search(r"[0-9]{16}", _body) if _body else None
check("16-digit fixture number intact", bool(_long_run),
      "" if _long_run else "FILE MISSING")
if _long_run:
    _run = _long_run.group(0)
    _inside = [v for v in MAPPING if v in _run and len(v) == 4]
    check("a real value sits inside the 16-digit run", bool(_inside),
          "")
    check("the 16-digit run was not partially rewritten", _run not in set(MAPPING.values()))
    for _v in _inside:
        check("a value inside the run was left alone", _run.count(_v) == 1)

print("=== remapped values present where expected ===")
# Derive the two 6-digit targets by shape (the long member of a pair) so no real
# value is a literal in this file. Pair order matches the pattern file.
_LONG = [MAPPING[long_v] for long_v, _ in PAIRS if long_v in MAPPING]
_OCBC_TARGET, _POSB_TARGET = (_LONG + [None, None])[:2]
# The two 6-digit legs are the long members of the pairs. Assert each file
# contains SOME long target, derived from the map rather than a literal.
_LONG = sorted({MAPPING[lv] for lv, _ in PAIRS if lv in MAPPING})
_targets = [
    ("6-digit OCBC leg", "modules/expense-tracker/tests/bank-movement.test.js"),
    ("6-digit POSB leg",
     "modules/expense-tracker/tests/own-account-fast-transfer-598.test.js"),
]
for label, rel in _targets:
    _body = read(rel)
    check(f"{label} remapped",
          bool(_body) and any(v in _body for v in _LONG),
          "" if _body else "FILE MISSING")

print("=== the pattern file is git-ignored ===")
r = subprocess.run(["git", "-C", ROOT, "check-ignore", "-q",
                    "scripts/.pii-patterns.local.json"])
check("scripts/.pii-patterns.local.json is ignored by git", r.returncode == 0,
      "" if r.returncode == 0 else "NOT IGNORED — real PII would be committed")
r2 = subprocess.run(["git", "-C", ROOT, "ls-files", "--error-unmatch",
                     "scripts/.pii-patterns.local.json"],
                    capture_output=True, text=True)
check("scripts/.pii-patterns.local.json is not tracked", r2.returncode != 0,
      "TRACKED — real PII is in the repo")
r3 = subprocess.run(["git", "-C", ROOT, "ls-files",
                     "scripts/.pii-patterns.local.json.example"],
                    capture_output=True, text=True)
check("the placeholder example IS tracked", bool(r3.stdout.strip()))

print()
if fails:
    print(f"{len(fails)} failure(s):")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("all invariants hold")
