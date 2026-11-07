#!/usr/bin/env python3
"""Find person names in git history with Presidio, without printing them.

Regex cannot match a name, so this complements .trufflehog.yml. Findings use
TruffleHog's JSONL shape so pii-scan-alert.py can email both. Logs of this
repository are public: an error prints only its exception type on stdout, and the
workflow discards stderr.

Run: python3 scripts/pii-scan-names.py names.jsonl
Env: FULL_HISTORY ("true" for every commit; otherwise the last 2 days).
Exit: 0 scanned, 1 failed.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import subprocess
import sys

_WORD = r"(?:[A-Z][a-z]*(?:['-][A-Z]?[a-z]+)+|[A-Z][a-z]+|[A-Z]{2,})"
NAME = re.compile(rf"{_WORD}(?: {_WORD})+")
# ponytail: requires two capitalised words, which took a full-history run from
# about 97 minutes to under 4 and removed most false hits. It misses a lone
# "Wei"; drop this filter if single names matter.
CANDIDATE = re.compile(r"\b(?:[A-Z][a-z]+ [A-Z][a-z]+|[A-Z]{2,} [A-Z]{2,})\b")
# GitHub squash merges write "Co-authored-by:" (lower-case a, b); both forms carry git identities.
TRAILER = re.compile(r"(?i)(?:co-authored-by|signed-off-by): ")
MAX_LINE = 2000  # ponytail: a longer line is minified or data, and is skipped.


def added_lines(log):
    """Yield (commit, file or None, line number, text) for commit messages and added lines."""
    commit = path = None
    number = 0
    in_diff = False
    for text in log:
        if text.startswith("\0"):
            commit, path, number, in_diff = text[1:], None, 0, False
        elif text.startswith("diff --git "):
            path, in_diff = None, True
        elif not in_diff:
            if text.strip() and not TRAILER.match(text):
                yield commit, None, 0, text
        elif text.startswith("+++ "):
            path = text[6:] if text.startswith("+++ b/") else None
        elif text.startswith("@@ "):
            number = int(text.split("+", 1)[1].split(",")[0].split(" ")[0])
        elif text.startswith("+") and path:
            yield commit, path, number, text[1:]
            number += 1


def git_log(full: bool) -> list[str]:
    command = ["git", "-c", "core.quotepath=off", "log", "--all", "-p", "--unified=0", "--format=%x00%H%n%B"]
    if not full:
        command.append("--since=2.days")
    command += ["--", ".", ":!*package-lock.json"]
    log = subprocess.run(command, capture_output=True, check=True)
    return log.stdout.decode("utf-8", "replace").split("\n")


def scan(log, out_path: str) -> None:
    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider

    config = {"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_md"}]}
    engine = AnalyzerEngine(nlp_engine=NlpEngineProvider(nlp_configuration=config).create_engine(), supported_languages=["en"])
    records = []
    for commit, path, number, text in added_lines(log):
        if len(text) > MAX_LINE or not CANDIDATE.search(text):
            continue
        for result in engine.analyze(text, language="en", entities=["PERSON"]):
            value = text[result.start : result.end]
            if NAME.fullmatch(value):
                git = {"commit": commit, "line": number}
                if path:
                    git["file"] = path
                records.append({"DetectorName": "Presidio", "ExtraData": {"name": "PII name"}, "Raw": value, "SourceMetadata": {"Data": {"Git": git}}})
    # Written whole at the end, so a crash cannot leave a truncated line behind.
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.writelines(json.dumps(record) + "\n" for record in records)


def main(argv: list[str]) -> int:
    real_stdout = sys.stdout
    try:
        # Libraries get stderr, which the workflow discards, so only the line below reaches the log.
        with contextlib.redirect_stdout(sys.stderr):
            scan(git_log(os.environ.get("FULL_HISTORY") == "true"), argv[1])
    except Exception as error:
        print(f"pii-scan-names failed: {type(error).__name__}", file=real_stdout)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
