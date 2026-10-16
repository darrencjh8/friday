#!/usr/bin/env python3
"""RED test: assert no real PII literal survives in the tracked tree.

Run: python3 scripts/check-no-pii.py            (repo root)
Exit codes: 0 clean, 1 PII found, 2 cannot verify (patterns file missing).

A 3-6 digit value is only flagged when it sits in an account context, because
test-count assertions ("260 tests") and commit SHAs contain digits that are not
secrets. A 7+ digit value is flagged anywhere: a real bank transfer reference is
PII on sight, and no test count looks like one.

High-entropy values are matched from the committed hashed file (no secret needed);
short values only when the git-ignored plaintext file exists. See scripts/pii_patterns.py.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pii_patterns  # noqa: E402

# Account contexts, each capturing the digit run it introduces. The run is
# delimited by digit lookarounds so a token merely sitting inside a longer number
# (a suffix inside a 16-digit fixture account number) is not mistaken for one.
ACCOUNT_CONTEXTS = [
    # "Card ending <REDACTED:4>", "Account/card ending in <REDACTED:4>", "suffix: <REDACTED:4>",
    # "A/C ending <REDACTED:4>", "own account: OCBC, suffix <REDACTED:6>", "Ref ending <REDACTED:4>"
    re.compile(
        r"(?i)(?:ending(?:\s+in)?|suffix|ref(?:erence)?|a/c|account|card)"
        r"\s*(?:number|no\.?|#)?\s*[:=#\"'`]?\s*\**\s*"
        r"(?<![0-9])(?P<n>[0-9]{3,6})(?![0-9])"
    ),
    # "Darren POSB (-<REDACTED:6>)", "(A/C ending <REDACTED:4>)", "ACCOUNT (-<REDACTED:6>)"
    re.compile(r"\(\s*-?\s*\**\s*(?<![0-9])(?P<n>[0-9]{4,6})\s*\**\s*\)"),
    # "ACCOUNT HOLDER (********<REDACTED:4>)", "OCBC 360 ACCOUNT ******<REDACTED:4>"
    re.compile(r"\*{2,}\s*(?<![0-9])(?P<n>[0-9]{4,6})(?![0-9])"),
]

MIN_UNCONTEXTED_DIGITS = 7  # a real transfer reference is PII on sight


def _hashed_matcher(hashed: dict):
    """Match high-entropy values (7+ digit runs and emails) by salted
    PBKDF2 digest. Only candidate tokens whose length (and, for names, word-length
    shape) matches a stored entry are hashed, which keeps CI runtime low."""
    salt = hashed["salt"]
    by_kind: dict[str, dict[str, str]] = {"digits": {}, "email": {}, "name": {}}
    digit_lens, email_lens = set(), set()
    for e in hashed["forbidden"]:
        by_kind[e["kind"]][e["hash"]] = e["label"]
        if e["kind"] == "digits":
            digit_lens.add(e["len"])
        elif e["kind"] == "email":
            email_lens.add(e["len"])

    def hits(line: str) -> list[tuple[int, int, str]]:
        found = []
        if digit_lens:
            for m in re.finditer(r"[0-9]+", line):
                if len(m.group()) in digit_lens:
                    lab = by_kind["digits"].get(pii_patterns.digest(m.group(), salt))
                    if lab:
                        found.append((m.start(), m.end(), lab))
        if email_lens and "@" in line:
            for m in pii_patterns.EMAIL_RE.finditer(line):
                if len(m.group()) in email_lens:
                    lab = by_kind["email"].get(
                        pii_patterns.digest(m.group().lower(), salt))
                    if lab:
                        found.append((m.start(), m.end(), lab))
        return found

    return hits


def _local_matcher(patterns: dict):
    """Plaintext matcher over EVERY forbidden value, including the short digit and
    single-word values that are too low-entropy to commit as hashes."""
    synthetic = set(patterns["remap"].values()) | {w for _, w in patterns["embedded"]}
    tokens = {k: v for k, v in patterns["forbidden"].items() if k not in synthetic}

    def hits(line: str) -> list[tuple[int, int, str]]:
        ctx = set()
        for pattern in ACCOUNT_CONTEXTS:
            for m in pattern.finditer(line):
                ctx.add(m.group("n"))
        found: list[tuple[int, str]] = []
        for token in sorted(tokens, key=len, reverse=True):
            start = line.find(token)
            if start < 0:
                continue
            if token.isdigit():
                digits = len(token)
                if digits < MIN_UNCONTEXTED_DIGITS and token not in ctx:
                    continue
                if line[:start][-1:].isdigit() or line[start + digits:][:1].isdigit():
                    continue
            if any(longer != token and token in longer for _, longer in found):
                continue
            found.append((start, token))
        return [(st, st + len(t), tokens[t]) for st, t in sorted(found)]

    return hits


# Generic detectors need no pattern file, so they also catch a real value that
# nobody thought to hash. A bank reference or account number is a long digit run;
# a Telegram id is a number after a Telegram/chat key. Either must be listed in
# ALLOWLIST_PATH, which holds only synthetic fixture values.
ALLOWLIST_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "pii-synthetic-numbers.txt")
LONG_NUMBER_RE = re.compile(r"(?<![0-9A-Za-z-])[0-9]{12,20}(?![0-9A-Za-z])")
TELEGRAM_ID_RE = re.compile(
    r"(?i)(?:telegram_[a-z_]*(?:user|chat|channel)[a-z_]*|chat_?id|user_?id)[\"'`]?\s*[:=]\s*[\"'`]?"
    r"(?P<ids>-?[0-9]{6,15}(?:\s*,\s*-?[0-9]{6,15})*)")
# A bank reference glued to letters ("SG2605...", "...880EPS7678794", "...037Billing").
# Upper-case only, so lower-case hex hashes are left alone.
ALNUM_REF_RE = re.compile(
    r"(?<![0-9A-Za-z])(?:[A-Z]{2,4}[0-9]{12,}[A-Z0-9]*|[0-9]{12,}[A-Z][A-Za-z0-9]*)")
PRIVATE_IP_RE = re.compile(r"(?<![0-9.])192\.168\.[0-9]{1,3}\.[0-9]{1,3}(?![0-9])")
PERSONAL_EMAIL_RE = re.compile(
    r"(?i)[A-Za-z0-9._%+-]+@(?:gmail|googlemail|hotmail|yahoo|outlook|live|icloud|me|msn)\.[a-z.]+")
REF_LABEL = "unlisted bank reference (synthetic? add to scripts/pii-synthetic-numbers.txt)"
IP_LABEL = "home LAN IP (use a placeholder like <prod-host>)"
EMAIL_LABEL = "personal email address (use @example.com)"
LONG_LABEL ="unlisted long number (synthetic? add to scripts/pii-synthetic-numbers.txt)"
TELEGRAM_LABEL = "unlisted Telegram id (synthetic? add to scripts/pii-synthetic-numbers.txt)"


def load_allowlist(path: str = ALLOWLIST_PATH) -> set[str]:
    try:
        with open(path, encoding="utf-8") as fh:
            return {ln.split("#", 1)[0].strip() for ln in fh} - {""}
    except OSError:
        return set()


def _generic_matcher(allow: set[str]):
    def hits(line: str) -> list[tuple[int, int, str]]:
        found = [(m.start(), m.end(), LONG_LABEL) for m in LONG_NUMBER_RE.finditer(line)
                 if m.group() not in allow]
        # "<digits>Billing" is a reference glued to the next word; its digits decide.
        found += [(m.start(), m.end(), REF_LABEL) for m in ALNUM_REF_RE.finditer(line)
                  if m.group() not in allow
                  and re.match(r"[0-9]*", m.group()).group() not in allow]
        found += [(m.start(), m.end(), IP_LABEL) for m in PRIVATE_IP_RE.finditer(line)
                  if m.group() not in allow]
        found += [(m.start(), m.end(), EMAIL_LABEL) for m in PERSONAL_EMAIL_RE.finditer(line)
                  if m.group() not in allow]
        for m in TELEGRAM_ID_RE.finditer(line):
            base = m.start("ids")
            for t in re.finditer(r"-?[0-9]+", m.group("ids")):
                if t.group().lstrip("-") not in allow and t.group() not in allow:
                    found.append((base + t.start(), base + t.end(), TELEGRAM_LABEL))
        return found

    return hits


def make_matcher(hashed: dict, local: dict | None = None, allow: set[str] | None = None):
    """Build a line matcher returning (start, end, label) spans.

    Hashed mode always runs (it is what CI has). When the git-ignored plaintext
    file is present it also runs, covering the low-entropy values. The remap's
    targets are the CORRECT state of the tree, not a leak, and are excluded.
    The generic detectors run whenever an allowlist is given.
    """
    h = _hashed_matcher(hashed)
    lo = _local_matcher(local) if local else None
    gen = _generic_matcher(allow) if allow is not None else None

    def line_hits(line: str) -> list[tuple[int, int, str]]:
        found = h(line) + (lo(line) if lo else []) + (gen(line) if gen else [])
        found = [f for f in found
                 if not any(g != f and g[0] <= f[0] and f[1] <= g[1] and
                            (g[1] - g[0] > f[1] - f[0]) for g in found)]
        return sorted(set(found))

    return line_hits


SKIP_DIRS = {".git", "node_modules", "dist", "build", ".venv", "venv",
             "__pycache__", "coverage", "vendor", "target", ".next"}

# Files that must contain the literals by definition cannot be evidence of a
# leak. A permanently red gate is a gate nobody runs.
SELF_EXEMPT = {
    "scripts/check-no-pii.py",
    "scripts/test-check-no-pii.py",
    "scripts/redact-pii.py",
    "scripts/verify-remap-safety.py",
    "scripts/pii_patterns.py",
    "scripts/hash-pii-patterns.py",
    "scripts/pii-patterns.hashed.json",
    "scripts/pii-synthetic-numbers.txt",
}
TEXT_EXT = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".yaml",
            ".yml", ".md", ".txt", ".sh", ".bash", ".sql", ".toml", ".java",
            ".go", ".html", ".env", ".example", ""}


def tracked_files(root: str) -> list[str]:
    out = subprocess.run(["git", "-C", root, "ls-files", "-z"],
                         capture_output=True, text=True, check=True).stdout
    return [p for p in out.split("\0") if p]


def scan(root: str, line_hits) -> list[tuple[str, int, str, str]]:
    hits = []
    for rel in tracked_files(root):
        if rel in SELF_EXEMPT:
            continue
        if any(part in SKIP_DIRS for part in rel.split("/")):
            continue
        if os.path.splitext(rel)[1].lower() not in TEXT_EXT:
            continue
        path = os.path.join(root, rel)
        try:
            if os.path.getsize(path) > 2_000_000:
                continue
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            spans = line_hits(line)
            if not spans:
                continue
            shown = line
            for st, en, _ in sorted(spans, reverse=True):
                shown = shown[:st] + "«redacted»" + shown[en:]
            for _, _, label in spans:
                hits.append((rel, lineno, label, shown.strip()[:140]))
    return hits


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        hashed = pii_patterns.load_hashed()
    except pii_patterns.PatternsMissing as exc:
        print(f"check-no-pii: CANNOT VERIFY — {exc}", file=sys.stderr)
        return 2
    local = pii_patterns.try_load_local()
    if local is None:
        print("check-no-pii: NOTE — local plaintext pattern file absent; short "
              "values (<7 digits) and names are NOT checked "
              "(hashed high-entropy set only)")
    line_hits = make_matcher(hashed, local, allow=load_allowlist())
    hits = scan(root, line_hits)
    if hits:
        print(f"check-no-pii: FAIL — {len(hits)} PII literal(s) in tracked files",
              file=sys.stderr)
        for rel, lineno, label, line in hits:
            print(f"  {rel}:{lineno}  [{label}]  {line}", file=sys.stderr)
        return 1
    print("check-no-pii: PASS — no forbidden PII literal in tracked files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
