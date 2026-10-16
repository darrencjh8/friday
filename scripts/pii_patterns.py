#!/usr/bin/env python3
"""Load PII patterns: plaintext (local only) or salted hashes (committed).

The CI gate uses the committed hashed file (load_hashed): salted SHA-256 digests
of the forbidden values, so the repository holds no real value and CI needs no
secret. The plaintext loader (load) is only for local tools (redact-pii.py, the
generator hash-pii-patterns.py, and the self-test's real-value cases).

Plaintext details follow.

The gate and the remapper need the real values to do their jobs, and those values
must never be committed to a public repository. So they live here, in a file that
is git-ignored, and the tools read it at runtime.

If the file is missing, callers must fail loudly: a gate that cannot find its
patterns must NOT report "clean".
"""
from __future__ import annotations

import functools
import hashlib
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
PATTERNS_PATH = os.environ.get("PII_LOCAL_PATTERNS") or os.path.join(
    HERE, ".pii-patterns.local.json")
HASHED_PATH = os.environ.get("PII_HASHED_PATTERNS") or os.path.join(
    HERE, "pii-patterns.hashed.json")
SALT = "darren-openclaw-pii-v1"
WORD_RE = re.compile(r"[^\W_]+")
EXAMPLE_PATH = os.path.join(HERE, ".pii-patterns.local.json.example")


class PatternsMissing(RuntimeError):
    pass


def load() -> dict:
    if not os.path.isfile(PATTERNS_PATH):
        raise PatternsMissing(
            f"missing {PATTERNS_PATH}\n"
            f"copy {EXAMPLE_PATH} to that path and fill in the real values")
    with open(PATTERNS_PATH, encoding="utf-8") as fh:
        raw = json.load(fh)
    for key in ("forbidden", "remap"):
        if not raw.get(key):
            raise PatternsMissing(f"{PATTERNS_PATH} has no '{key}' section")
    return {
        "forbidden": dict(raw["forbidden"]),
        "remap": dict(raw["remap"]),
        "pairs": [tuple(p) for p in raw.get("pairs", [])],
        "embedded": [tuple(p) for p in raw.get("embedded", [])],
        "port_allowlist": {k: set(v) for k, v in raw.get("port_allowlist", {}).items()},
    }


KDF_ITERATIONS = 200_000
MIN_HASHED_DIGITS = 7
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*")


def bucket(value: str) -> str:
    """Entropy bucket. Only 'digits' (7+) and 'email' are committed as
    hashes; 'short' (<7 digits), 'word' and 'name' (names are guessable from a
    dictionary) are brute-forceable, so they are only ever checked from the local plaintext."""
    if value.isascii() and value.isdigit():
        return "digits" if len(value) >= MIN_HASHED_DIGITS else "short"
    if "@" in value:
        return "email"
    return "name" if len(WORD_RE.findall(value)) >= 2 else "word"


def normalize(value: str, kind: str) -> str:
    if kind == "digits":
        return value
    if kind == "email":
        return value.strip().lower()
    return " ".join(WORD_RE.findall(value)).casefold()


@functools.lru_cache(maxsize=None)
def digest(norm: str, salt: str = SALT) -> str:
    """Slow salted KDF (PBKDF2-HMAC-SHA256, 200k rounds): the committed file must
    resist offline guessing, so callers hash only candidate tokens of a kind."""
    return hashlib.pbkdf2_hmac("sha256", norm.encode("utf-8"), salt.encode(),
                               KDF_ITERATIONS).hex()


def build_hashed(raw: dict, salt: str = SALT) -> tuple[dict, dict]:
    """Plaintext pattern set -> (hashed file content, bucket counts)."""
    synthetic = set(raw["remap"].values()) | {w for _, w in raw["embedded"]}
    entries, counts = [], {"digits": 0, "email": 0, "name": 0, "short": 0, "word": 0}
    for value, label in raw["forbidden"].items():
        if value in synthetic:
            continue
        kind = bucket(value)
        counts[kind] += 1
        if kind in ("short", "word", "name"):
            continue
        norm = normalize(value, kind)
        entries.append({"hash": digest(norm, salt), "kind": kind,
                        "len": len(norm),
                        "shape": [],
                        "label": label})
    return ({"version": 2, "salt": salt, "kdf": f"pbkdf2-sha256-{KDF_ITERATIONS}",
             "forbidden": sorted(entries, key=lambda e: e["hash"])}, counts)


def load_hashed(path: str | None = None) -> dict:
    path = path or HASHED_PATH
    if not os.path.isfile(path):
        raise PatternsMissing(f"missing {path}\n"
                              "regenerate it: python3 scripts/hash-pii-patterns.py")
    with open(path, encoding="utf-8") as fh:
        h = json.load(fh)
    if not h.get("forbidden"):
        raise PatternsMissing(f"{path} has no 'forbidden' section")
    return h


def try_load_local() -> dict | None:
    try:
        return load()
    except PatternsMissing:
        return None
