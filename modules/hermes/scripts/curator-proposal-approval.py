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
    if report.get("llm_error"):
        raise ValueError("saved curator run contains an LLM error")
    final = report.get("llm_final")
    if not isinstance(final, str):
        raise ValueError("saved proposal summary is malformed")
    summary = BLOCK.search(final)
    if not summary:
        raise ValueError("saved proposal has no structured summary")
    data = yaml.safe_load(summary.group(1))
    if not isinstance(data, dict) or "consolidations" not in data:
        raise ValueError("saved proposal summary is malformed")
    raw_merges = data["consolidations"]
    if not isinstance(raw_merges, list):
        raise ValueError("saved proposal consolidation list is malformed")
    merges = []
    for entry in raw_merges:
        if (not isinstance(entry, dict) or not isinstance(entry.get("from"), str)
                or not entry["from"].strip() or not isinstance(entry.get("into"), str)
                or not entry["into"].strip()
                or ("reason" in entry and not isinstance(entry["reason"], str))):
            raise ValueError("saved proposal contains a malformed merge")
        merges.append({key: str(entry.get(key) or "").strip() for key in ("from", "into", "reason")})
    if selection == "all":
        return merges
    tokens = selection.split(",")
    if not tokens or any(not token.isdecimal() or int(token) < 1 for token in tokens):
        raise ValueError("selection must be 'all' or comma-separated positive row numbers")
    indexes = [int(token) for token in tokens]
    if len(set(indexes)) != len(indexes) or any(index > len(merges) for index in indexes):
        raise ValueError("selection contains a duplicate or out-of-range row")
    return [merges[index - 1] for index in indexes]


def refuse_cron_skills(merges: list[dict[str, str]]) -> None:
    """A merge deletes its source skill and nothing rewrites cron job references,
    so a job still listing that skill would run without it."""
    try:
        data = json.loads((HOME / "cron" / "jobs.json").read_text())
    except FileNotFoundError:
        return
    jobs = data.get("jobs") if isinstance(data, dict) else data
    if not isinstance(jobs, list):
        raise ValueError("cron jobs file is malformed")
    for merge in merges:
        users = sorted(str(job.get("name")) for job in jobs if isinstance(job, dict) and (
            merge["from"] == job.get("skill")
            or (isinstance(job.get("skills"), list) and merge["from"] in job["skills"])))
        if users:
            raise ValueError(f"skill {merge['from']} is used by cron jobs: {', '.join(users)}")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: curator-proposal-approval.py <proposal-id> <all|row[,row...]>", file=sys.stderr)
        return 2
    try:
        merges = selected_merges(argv[1], argv[2])
        refuse_cron_skills(merges)
        result = {"proposal_id": argv[1], "merges": merges}
    except (OSError, ValueError, json.JSONDecodeError, yaml.YAMLError) as exc:
        print(f"curator proposal approval refused: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
