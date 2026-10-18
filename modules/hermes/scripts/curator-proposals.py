#!/usr/bin/env python3
"""Weekly skill-merge proposals from Hermes' built-in curator, report only.

Runs `hermes curator run --dry-run --consolidate --sync`, which asks the
curator's LLM pass for merge and prune proposals without changing any skill,
then reads the structured block from the run.json it writes. stdout is the
Telegram message of the no_agent cron job: `{"wakeAgent": false}` (silent)
when there is nothing to propose, a table when there is, and one bold line
when the run or its report failed.
"""

import datetime
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

import yaml

HOME = os.environ.get("HERMES_HOME", "/opt/data")
LOGS = os.path.join(HOME, "logs", "curator")
HERMES = os.environ.get("HERMES_BIN", "hermes")
TIMEOUT = 1800
BLOCK = re.compile(r"```ya?ml\s*\n(.*?)\n```", re.DOTALL | re.IGNORECASE)


def runs():
    return set(glob.glob(os.path.join(LOGS, "*", "run.json")))


def cell(value):
    return str(value or "").replace("|", "/").replace("\n", " ").strip() or "—"


def fail(reason):
    print(f"⚠️ *Skill merge proposals failed* · {cell(reason)}")
    return 0


def main():
    before = runs()
    try:
        proc = subprocess.run([HERMES, "curator", "run", "--dry-run", "--consolidate", "--sync"],
                              capture_output=True, text=True, timeout=TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as e:
        return fail(f"curator run: {type(e).__name__}: {e}"[:300])
    if proc.returncode != 0:
        return fail(f"curator run exited {proc.returncode}: {(proc.stderr or proc.stdout)[-300:]}")
    new = sorted(runs() - before)
    if not new:
        return fail("curator wrote no new report")
    try:
        with open(new[-1], "rb") as handle:
            raw = handle.read()
        run = json.loads(raw)
    except (OSError, ValueError) as e:
        return fail(f"unreadable {new[-1]}: {e}")
    if run.get("llm_error"):
        return fail(f"curator LLM pass: {run['llm_error']}"[:300])
    match = BLOCK.search(run.get("llm_final") or "")
    if not match:
        return fail(f"no structured summary in {os.path.relpath(new[-1], HOME)} ({run.get('llm_summary')})")
    try:
        data = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError as e:
        return fail(f"structured summary is not YAML: {e}"[:300])
    merges = [e for e in data.get("consolidations") or [] if isinstance(e, dict) and e.get("from") and e.get("into")]
    prunes = [e for e in data.get("prunings") or [] if isinstance(e, dict) and e.get("name")]
    if not merges and not prunes:
        print(json.dumps({"wakeAgent": False}))
        return 0
    run_id = os.path.basename(os.path.dirname(new[-1]))
    proposal_id = f"{run_id}-{hashlib.sha256(raw).hexdigest()[:12]}"
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date().isoformat()
    lines = [f"🧰 *Skill merge proposals · {today}*", f"proposal_id={proposal_id}", ""]
    if merges:
        lines += ["| # | Merge | Into | Why |", "|---|---|---|---|"]
        lines += [f"| {i} | {cell(e['from'])} | {cell(e['into'])} | {cell(e.get('reason'))} |"
                  for i, e in enumerate(merges, 1)]
        lines.append("")
    if prunes:
        lines += ["| Archive | Why |", "|---|---|"]
        lines += [f"| {cell(e['name'])} | {cell(e.get('reason'))} |" for e in prunes]
        lines.append("")
    lines.append(f"Reply `approve all`, `approve 1,3`, or `reject all` to this message. For a fresh session, include `{proposal_id}`.")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
