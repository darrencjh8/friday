#!/usr/bin/env python3
"""Refuse text bound for the shared persona repo when it holds personal information.

Reads the lines Hermes is about to push (the commit message and the added diff
lines) on stdin. Exit 0 lets the push go on; exit 2 refuses it. The reason is
printed as a label only, never the matched text, so the refusal itself does not
leak what it caught.

Two checks, both must pass:
1. Patterns: emails, Singapore phone and NRIC numbers, long numbers, private IPs,
   internal host names, /home paths and token shapes.
2. Jev, on the full text: does it reveal the owner's real-life schedule or any
   personal information about a real person? Friday's own persona routine is
   fine. Only a confident "clean" passes; "personal", "uncertain", low
   confidence, a missing key or any error refuses (fail closed).

ponytail: the repo-wide hashed deny-list (scripts/pii-patterns.hashed.json) is
not reused: it lives outside the Hermes image's build context and holds only
emails and 7+ digit numbers, which the patterns below already catch. Names are
left to Jev. Copy the hashed file into the image if a value slips past both.
"""
import json
import os
import re
import sys
import urllib.request

JEV_ENDPOINT = os.environ.get("JEV_ENDPOINT") or "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"
JEV_TIMEOUT = 30
# Same calibrated gates as scripts/pii-scan-alert.py.
JEV_MIN_CONFIDENCE = 0.65
JEV_MIN_MARGIN = 0.3

PATTERNS = {
    "email address": re.compile(
        r"[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+"),
    "phone number": re.compile(r"(?<![0-9])(?:\+?65[ -]?)?[689][0-9]{3}[ -]?[0-9]{4}(?![0-9])"),
    "NRIC number": re.compile(r"\b[STFGM][0-9]{7}[A-Z]\b"),
    "long number": re.compile(r"(?<![0-9])[0-9]{12,20}(?![0-9])"),
    "private IP address": re.compile(
        r"(?<![0-9.])(?:10\.[0-9]{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}(?![0-9])"),
    "internal host name": re.compile(r"\b[a-z0-9-]+\.(?:local|lan|internal|home\.arpa)\b", re.I),
    "home directory path": re.compile(r"/home/[A-Za-z0-9._-]+"),
    "token": re.compile(
        r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}"
        r"|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})"),
}

QUESTION = {
    "verdict": {
        "type": "choice",
        "instructions": (
            "You check text an AI persona named Friday is about to publish to a shared "
            "repository. Friday is a fictional character; her own routine, calendar, "
            "tastes and reflections are fine to publish. Answer personal when the text "
            "reveals the owner's real-life schedule (real appointments, places, times or "
            "people) or any personal information about a real person: names, contact "
            "details, addresses, health, money, accounts or credentials. Answer clean "
            "when it holds none. If the evidence does not decide it, answer uncertain."
        ),
        "criteria": {
            "clean": "only Friday's own persona content or generic work knowledge",
            "personal": "reveals the owner's real schedule or a real person's personal information",
            "uncertain": "not enough evidence",
        },
    }
}


def pattern_hits(text: str) -> list[str]:
    return [label for label, pattern in PATTERNS.items() if pattern.search(text)]


def jev_says_clean(text: str, key: str) -> bool:
    if not key:
        return False
    body = json.dumps({"model": JEV_MODEL, "state": text, "questions": QUESTION}).encode()
    request = urllib.request.Request(
        JEV_ENDPOINT, data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=JEV_TIMEOUT) as response:
            verdict = json.load(response)["answers"]["verdict"]
        if verdict.get("choice") != "clean":
            return False
        probs = sorted((verdict.get("probabilities") or {}).values(), reverse=True)
        margin = (probs[0] - probs[1]) if len(probs) > 1 else 0.0
        return (verdict.get("confidence") or 0) >= JEV_MIN_CONFIDENCE and margin >= JEV_MIN_MARGIN
    except Exception:
        return False


def main() -> int:
    text = sys.stdin.read()
    hits = pattern_hits(text)
    if hits:
        print(f"personal information check: found {', '.join(hits)}")
        return 2
    if not jev_says_clean(text, os.environ.get("JEV_API_KEY", "")):
        print("personal information check: Jev did not confirm the text is clean")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
