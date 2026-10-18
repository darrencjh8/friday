#!/usr/bin/env python3
"""Validate a Telegram approval against the exact saved curator proposal."""

import hashlib
import json
import os
import re
import sys
from pathlib import Path

import yaml

HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))
PROPOSAL_ID = re.compile(r"(?P<run>\d{8}-\d{6}(?:-\d+)?)-(?P<digest>[0-9a-f]{12})\Z")
BLOCK = re.compile(r"```ya?ml\s*\n(.*?)\n```", re.DOTALL | re.IGNORECASE)


def selected_merges(proposal_id: str, selection: str) -> list[dict[str, str]]:
    match = PROPOSAL_ID.fullmatch(proposal_id)
    if not match:
        raise ValueError("invalid proposal ID")
    path = HOME / "logs" / "curator" / match.group("run") / "run.json"
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest()[:12] != match.group("digest"):
        raise ValueError("saved proposal changed; request a new proposal")
    report = json.loads(raw)
    if not isinstance(report, dict):
        raise ValueError("saved proposal report is malformed")
    summary = BLOCK.search(report.get("llm_final") or "")
    if not summary:
        raise ValueError("saved proposal has no structured summary")
    data = yaml.safe_load(summary.group(1)) or {}
    if not isinstance(data, dict):
        raise ValueError("saved proposal summary is malformed")
    merges = [
        {key: str(entry.get(key) or "").strip() for key in ("from", "into", "reason")}
        for entry in data.get("consolidations") or []
        if isinstance(entry, dict) and entry.get("from") and entry.get("into")
    ]
    if selection == "all":
        return merges
    tokens = selection.split(",")
    if not tokens or any(not token.isdecimal() or int(token) < 1 for token in tokens):
        raise ValueError("selection must be 'all' or comma-separated positive row numbers")
    indexes = [int(token) for token in tokens]
    if len(set(indexes)) != len(indexes) or any(index > len(merges) for index in indexes):
        raise ValueError("selection contains a duplicate or out-of-range row")
    return [merges[index - 1] for index in indexes]


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: curator-proposal-approval.py <proposal-id> <all|row[,row...]>", file=sys.stderr)
        return 2
    try:
        result = {"proposal_id": argv[1], "merges": selected_merges(argv[1], argv[2])}
    except (OSError, ValueError, json.JSONDecodeError, yaml.YAMLError) as exc:
        print(f"curator proposal approval refused: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
