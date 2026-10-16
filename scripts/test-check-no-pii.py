#!/usr/bin/env python3
"""Prove the PII gate's matching rule against cases that must be flagged and
cases that must not, in both directions.

A gate that cannot fail, or that cries wolf on a commit SHA, is not usable. So
both directions are asserted, and the end-to-end check plants a real literal and
requires a non-zero exit before removing it and requiring green again.

Cases use synthetic values (always) and the git-ignored plaintext file (when present);
this file contains no PII.

Run: python3 scripts/test-check-no-pii.py
Exit: 0 pass, 1 fail, 2 cannot verify (patterns file missing).
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GATE = os.path.join(HERE, "check-no-pii.py")
sys.path.insert(0, HERE)

import importlib.util  # noqa: E402
import json  # noqa: E402
import tempfile  # noqa: E402

import pii_patterns  # noqa: E402

_cspec = importlib.util.spec_from_file_location("check_no_pii", GATE)
_cmod = importlib.util.module_from_spec(_cspec)
_cspec.loader.exec_module(_cmod)

# Synthetic, obviously fake values, hashed at test time into a throwaway hashed
# file. They exercise the matcher in CI (no local file) and in dev alike.
SYN = {
    "own card suffix": "7351", "own bank account suffix": "7351",
    "own UOB card suffix": "7351", "own DBS card suffix": "7351",
    "own card suffix (masked)": "7351", "own OCBC account suffix (masked)": "7351",
    "own OCBC account number": "8260417", "own POSB account number": "8260417",
    "own Trust account number": "8260417",
    "own real transfer reference": "8260417935120648",
    "own legal name (upper)": "ZED QUUX TESTPERSON",
    "own employer email": "zq.work@example.com",
    "own personal email": "zq.home@example.com",
    "third-party name (synthetic)": "Qux Mockname",
}
SYN_RAW = {"forbidden": {v: k for k, v in SYN.items()}, "remap": {}, "embedded": [],
           "pairs": [], "port_allowlist": {}}
SYN_HASHED, _ = pii_patterns.build_hashed(SYN_RAW)
LOCAL = pii_patterns.try_load_local()
COMMITTED = pii_patterns.load_hashed()
F = {v: k for k, v in LOCAL["forbidden"].items()} if LOCAL else {}  # label -> value
R = LOCAL["remap"] if LOCAL else {}
SYN_BY_LABEL = dict(SYN)


# Phrasings that appear in this repo. Each names the case by its label so the
# expected token is the real value behind it.
MUST_FLAG = [
    ("own card suffix", "Card ending {v} belongs to Epsilon Nova Card"),
    ("own card suffix", "card ending in {v} belongs to Epsilon Nova"),
    ("own bank account suffix", "Account ending {v} belongs to Epsilon Account"),
    ("own bank account suffix", "Account/card ending {v} belongs to Beta 360"),
    ("own UOB card suffix", "suffix {v} resolves to Delta Extra"),
    ("own OCBC account number", "suffix: {v}"),
    ("own OCBC account number", "own account: OCBC, suffix {v}"),
    ("own OCBC account number", "From your account : 111 Account (-{v})"),
    ("own POSB account number", "Darren POSB (-{v}) at DBS BANK LTD"),
    ("own DBS card suffix", "Ref ending {v}"),
    ("own bank account suffix", "A/C ending {v}"),
    ("own card suffix (masked)", "ACCOUNT HOLDER (********{v})"),
    ("own OCBC account suffix (masked)", "OCBC 360 ACCOUNT ******{v}"),
    ("own Trust account number", "Account: Example Trust (-{v}) at TRUST BANK"),
    ("own legal name (upper)",
     "Legal name: {v} -> OWN (statement password)"),
    ("own legal name (upper)", "from {v}| on 16-Sep-26"),
    ("own employer email", "contact {v}"),
    ("own personal email", "reach me at {v}"),
    ("own real transfer reference", "reference {v} shared by both legs"),
]
# The third party's name carries a label that names the issue it came from, so
# match on the prefix rather than hard-coding the full label string.
for _label in list(F) + list(SYN):
    if _label.startswith("third-party name"):
        MUST_FLAG.append((_label, "Merchant: {v}"))
# Incidentals that must NOT be flagged: counts, hashes, ports, merchants, and —
# most importantly — every real value sitting INSIDE a longer run of digits.
# Generated from the pattern file so this source holds no PII, and so a newly
# added value is covered automatically instead of needing a new literal here.
MUST_NOT_FLAG = [
    "260 tests, 0 failures",
    "808 passed, 0 failures",
    "36 files changed, 1277 insertions",
    "commit 5a7ed8681d1c5b2c87a6cf9d99d861824d6865d3",
    "plan hash d258d63195c45d5c5900177194a1cecb865b7b81",
    "run 34740191195",
]

failures: list[str] = []


def suite(name, hashed, local, values):
    """Run MUST_FLAG/MUST_NOT_FLAG against one matcher. `values` maps label ->
    value. Without a plaintext matcher only hashed-bucket values must flag."""
    line_hits = _cmod.make_matcher(hashed, local)
    print(f"== {name}: must flag ==")
    skipped = 0
    for label, template in MUST_FLAG:
        v = values.get(label)
        if v is None:
            skipped += 1
            continue
        if local is None and pii_patterns.bucket(v) in ("short", "word", "name"):
            skipped += 1  # too low-entropy to be hashed; local-only by design
            continue
        line = template.format(v=v)
        ok = bool(line_hits(line))
        print(f"  {'ok  ' if ok else 'MISS'} {label:34s}")
        if not ok:
            failures.append(f"{name}: should flag ({label}) but did not: {template}")
    print(f"  ({skipped} case(s) not applicable in this mode)")
    print(f"== {name}: must not flag ==")
    nf = list(MUST_NOT_FLAG)
    shorts = [v for v in values.values() if v.isdigit() and len(v) == 4]
    for _v in sorted({v for v in values.values() if v.isdigit() and len(v) == 6}):
        nf.append(f"12{_v}34")
    for _w, _synth in (local or {}).get("embedded", []):
        nf.append(f"Reference: {_synth} was already remapped")
    for _v in sorted(set(shorts)):
        nf += [f"McDonalds {_v}01", f"account 1234{_v}23456", f"spend of {_v}0.00 SGD"]
    for line in nf:
        ok = not line_hits(line)
        if not ok:
            print("  FALSE+")
            failures.append(f"{name}: false positive: {line}")
    print(f"  {len(nf)} line(s) checked")


suite("synthetic hashed-only", SYN_HASHED, None, SYN_BY_LABEL)
suite("synthetic hashed+local", SYN_HASHED, SYN_RAW, SYN_BY_LABEL)
if LOCAL:
    suite("real committed-hashed-only", COMMITTED, None, F)
    suite("real committed-hashed+local", COMMITTED, LOCAL, F)
    r = subprocess.run([sys.executable, os.path.join(HERE, "hash-pii-patterns.py"),
                        "--check"], capture_output=True, text=True)
    _txt = open(pii_patterns.HASHED_PATH, encoding="utf-8").read()
    _vals = list(LOCAL["forbidden"]) + list(LOCAL["remap"])
    _leaks = sum(1 for v in _vals if v in _txt)
    _hashes = sum(1 for v in _vals if pii_patterns.digest(
        pii_patterns.normalize(v, pii_patterns.bucket(v))) in _txt)
    print(f"== plaintext in committed hashed file: {_leaks} of {len(_vals)} "
          f"local values found as raw text (must be 0); {_hashes} hashed entries")
    if _leaks:
        failures.append("committed hashed file contains plaintext local values")
    print(f"== committed hashed file vs local: {r.stdout.strip()}")
    if r.returncode != 0:
        failures.append("committed hashed file is stale; run hash-pii-patterns.py")
else:
    print("== real-value cases SKIPPED: local plaintext file absent ==")

# Generic detectors: they need no pattern file, so a real value nobody hashed is
# still caught. A long number or a Telegram id must be on the synthetic allowlist.
print("== generic detectors ==")
_ALLOW = {"2609000000001111", "1111111111"}
_gen = _cmod.make_matcher({"salt": "x", "forbidden": []}, None, allow=_ALLOW)
for _line in ("Transaction Ref: 2609015555123456",
              "ref 17881900000000000123 posted",
              "Account 501234567890 credited",
              'TELEGRAM_ALLOWED_USERS="487000111"',
              "TELEGRAM_ALLOWED_USERS=487000111,1111111111",
              "chat_id: 735000111",
              "Transaction reference: SG26059900000000000001",
              "ref 012609000000000000EPS1234567 posted",
              "Ref 2609015555123456Billing",
              "ssh user" + "@192.168.1.23",
              "To: <someone.real@" + "gmail.com>",  # split so gitleaks skips it
              "cc xy@" + "hotmail.com"):
    if not _gen(_line):
        print("  MISS")
        failures.append(f"generic: should flag but did not: {_line}")
for _line in ("Transaction Ref: 2609000000001111",
              'TELEGRAM_ALLOWED_USERS="1111111111"',
              "commit 3f9a1c2b4d5e6f708192a3b4c5d6e7f8091a2b3c",
              "sha256-AbC123456789012345678xyz",
              "timeout 30000 ms, 260 tests, version 1.2.3",
              "amount 12345678901 in an unrelated sentence",
              'DBS = "506df429-0000-0000-0000-000000000001"',
              'TELEGRAM_BOT_TOKEN="123456789:AAH-fake"',
              "manifest hash 11380558258791fe3 and 8746247484570942053158915adf",
              "docker host 172.17.0.1 and placeholder <prod-host>",
              "To: <accountholder@example.com>"):
    if _gen(_line):
        print("  FALSE+")
        failures.append(f"generic: false positive: {_line}")
print("  checked")

TMP_REL = "modules/expense-tracker/tests/pii-selftest-fixture.md"


def cleanup():
    subprocess.run(["git", "rm", "-qf", "--cached", TMP_REL], cwd=ROOT,
                   capture_output=True, text=True)
    p = os.path.join(ROOT, TMP_REL)
    if os.path.exists(p):
        os.remove(p)


def run_gate(env_extra=None):
    env = dict(os.environ, **(env_extra or {}))
    r = subprocess.run([sys.executable, GATE], cwd=ROOT, env=env,
                       capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def plant(lines):
    with open(os.path.join(ROOT, TMP_REL), "w", encoding="utf-8") as fh:
        fh.write("Fixture used to prove the gate fails.\n" + "".join(l + "\n" for l in lines))
    subprocess.run(["git", "add", "-f", TMP_REL], cwd=ROOT, capture_output=True, text=True)


def e2e(name, env_extra, planted, expect_labels):
    cleanup()
    code, out = run_gate(env_extra)
    print(f"  {name} clean tree      exit={code}")
    if code != 0:
        failures.append(f"{name}: gate is red on a clean tree")
    plant(planted)
    code, out = run_gate(env_extra)
    print(f"  {name} planted literal exit={code}")
    if code != 1:
        failures.append(f"{name}: gate did not go red on a planted literal (exit={code})")
    else:
        for label in expect_labels:
            ok = f"[{label}]" in out
            print(f"  {name} reported {label:26s}: {'yes' if ok else 'NO'}")
            if not ok:
                failures.append(f"{name}: planted {label!r} not reported")
    cleanup()
    code, out = run_gate(env_extra)
    print(f"  {name} after cleanup   exit={code}")
    if code != 0:
        failures.append(f"{name}: gate still red after removing the fixture")


print("== end-to-end ==")
with tempfile.TemporaryDirectory() as _td:
    _hp = os.path.join(_td, "hashed.json")
    with open(_hp, "w", encoding="utf-8") as fh:
        json.dump(SYN_HASHED, fh)
    e2e("synthetic", {"PII_HASHED_PATTERNS": _hp, "PII_LOCAL_PATTERNS": os.path.join(_td, "none")},
        ["Contact: " + SYN["own employer email"],
         "ref " + SYN["own real transfer reference"]],
        ["own employer email", "own real transfer reference"])
if LOCAL:
    e2e("real", {},
        [f"Legal name: {F['own legal name (upper)']}",
         f"Card ending {F['own card suffix']} belongs to Epsilon Nova Card",
         f"Contact: {F['own employer email']}"],
        ["own legal name (upper)", "own card suffix", "own employer email"])
    e2e("real hashed-only", {"PII_LOCAL_PATTERNS": "/nonexistent"},
        [f"Contact: {F['own employer email']}"],
        ["own employer email"])

print()
if failures:
    print(f"GATE SELF-TEST FAILED — {len(failures)} problem(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("GATE SELF-TEST PASSED — flags real PII, ignores incidental digits")
