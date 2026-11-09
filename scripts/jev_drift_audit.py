#!/usr/bin/env python3
"""Jev drift advisory: judge doc-claim vs code-fact pairs, report, never block.

Reads scripts/jev-drift-pairs.json, builds one state per pair from the
current tree, asks Jev (choice + evidence rounds with calibrated gates),
and writes findings. Exit 0 always on a completed audit (advisory only);
exit 2 when a pair cannot be extracted (fail closed: fix the pair, not
the verdict). Live Jev calls happen only here, never in unit tests.

Usage: python3 scripts/jev-drift-audit.py [--pairs i01,i02] [--dry-run]
       [--out findings.json]
Env: JEV_API_KEY (required), JEV_ENDPOINT / JEV_MODEL (optional).
"""
import argparse
import concurrent.futures
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIN_CONF, MIN_MARGIN, MIN_EVID = 0.65, 0.3, 0.6
ENDPOINT = os.environ.get("JEV_ENDPOINT", "https://api.typesafe.ai/v1/systemone")
MODEL = os.environ.get("JEV_MODEL", "jev-latest")

CHOICE_Q = {
    "verdict": {
        "type": "choice",
        "instructions": (
            "You compare a DOC excerpt against CODE excerpts from the same repo. "
            "Answer drifted only if the doc states something the code contradicts, "
            "or the doc's own claim excludes something the code has. "
            "When two DOC excerpts are given, agreement between them counts as consistent. "
            "Cosmetic wording differences are consistent. "
            "If the excerpts lack the evidence to decide, answer uncertain."
        ),
        "criteria": {
            "consistent": "doc claim and code agree",
            "drifted": "doc contradicts the code, or omits something its own claim covers",
            "uncertain": "excerpts do not contain enough evidence either way",
        },
    }
}
EVID_Q = {
    "evidence": {
        "type": "noul",
        "instructions": "Quote the exact doc words that contradict the code. Reply with the quote, or say NONE if every doc claim matches the code.",
    }
}


def sh(cmd):
    p = subprocess.run(["bash", "-c", cmd], cwd=ROOT, capture_output=True,
                       text=True, timeout=60)
    return (p.stdout + p.stderr).strip()


def fill_one(spec):
    """Fill one template placeholder. Raises on empty (fail closed)."""
    if "file" in spec:
        n = spec.get("lines", 1)
        text = sh(f"grep -E -m{n} '{spec['match']}' {spec['file']} || true")
    else:
        text = sh(spec["run"])
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()][:max(n if "file" in spec else 8, 1)]
    text = " / ".join(lines)[:900]
    if not text:
        raise ValueError(f"empty fill for {spec}")
    return text


def build_state(pair):
    """Build the judge state from the pair's claim template."""
    filled = {k: fill_one(v) for k, v in pair["fill"].items()}
    return pair["claim"].format(**filled)


def ask(state, questions, key):
    import urllib.request
    body = json.dumps({"model": MODEL, "state": state,
                       "questions": questions}).encode()
    req = urllib.request.Request(
        ENDPOINT, data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)["answers"]


def gate_choice(conf, margin):
    """Choice-round gate: confident + clear margin, else abstain."""
    if (conf or 0) >= MIN_CONF and margin >= MIN_MARGIN:
        return True
    return False


def gate_evidence(score):
    """Evidence-round gate."""
    return (score or 0) >= MIN_EVID


def judge(pair, key):
    state = build_state(pair)
    v = ask(state, CHOICE_Q, key)["verdict"]
    probs = v.get("probabilities") or {}
    top = sorted(probs.values(), reverse=True)
    margin = (top[0] - top[1]) if len(top) > 1 else 0.0
    if v.get("choice") != "drifted" or not gate_choice(v.get("confidence"), margin):
        gated = v.get("choice")
        if not gate_choice(v.get("confidence"), margin):
            gated = "uncertain"
        return {"id": pair["id"], "verdict": gated,
                "confidence": v.get("confidence"), "margin": round(margin, 3),
                "evidence": None, "state": state}
    e = ask(state, EVID_Q, key)["evidence"]["noul"]
    return {"id": pair["id"],
            "verdict": "drifted" if gate_evidence(e) else "uncertain",
            "confidence": v.get("confidence"), "margin": round(margin, 3),
            "evidence": e, "state": state}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pairs", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out", default="")
    args = ap.parse_args()
    key = os.environ.get("JEV_API_KEY", "")
    if not key:
        print("JEV_API_KEY is not set", file=sys.stderr)
        return 2
    spec = json.load(open(os.path.join(ROOT, "scripts", "jev-drift-pairs.json")))
    pairs = spec["pairs"]
    if args.pairs:
        want = set(args.pairs.split(","))
        pairs = [p for p in pairs if p["id"] in want]
    findings, broken = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(judge, p, key): p["id"] for p in pairs}
        for fut in concurrent.futures.as_completed(futs):
            try:
                findings.append(fut.result())
            except Exception as exc:  # noqa: BLE001 - extraction failure is a finding
                broken.append({"id": futs[fut], "error": str(exc)[:200]})
    findings.sort(key=lambda r: r["id"])
    drifted = [f for f in findings if f["verdict"] == "drifted"]
    report = {"pairs": len(pairs), "drifted": [f["id"] for f in drifted],
              "uncertain": [f["id"] for f in findings if f["verdict"] == "uncertain"],
              "broken": broken, "findings": findings}
    if args.out:
        json.dump(report, open(args.out, "w"), indent=1)
    summary = os.environ.get("GITHUB_STEP_SUMMARY", "")
    lines = [f"### Jev drift audit: {len(drifted)} drifted, "
             f"{len(report['uncertain'])} uncertain, {len(broken)} broken "
             f"of {len(pairs)} pairs"]
    for f in findings:
        if f["verdict"] != "consistent":
            lines.append(f"- {f['id']}: {f['verdict']} "
                         f"(conf={f['confidence']} margin={f['margin']} evid={f['evidence']})")
    if broken:
        lines += [f"- BROKEN {b['id']}: {b['error']}" for b in broken]
    print("\n".join(lines))
    if summary:
        with open(summary, "a") as fh:
            fh.write("\n".join(lines) + "\n")
    if broken and not args.dry_run:
        return 2
    if drifted and not args.dry_run:
        file_issue(report)
    return 0


def file_issue(report):
    """File one rolling issue per day with findings, deduped by title."""
    import datetime
    today = datetime.date.today().isoformat()
    title = f"[jev-drift] {today} findings"
    open_ones = sh(f"gh issue list --search '{title} in:title' --state open "
                   f"--json title --jq '.[].title' || true")
    if title in open_ones:
        print(f"issue exists: {title}")
        return
    body = [f"Jev drift audit found {len(report['drifted'])} drifted pair(s).",
            "", "Verdicts:"]
    for f in report["findings"]:
        if f["verdict"] != "consistent":
            body.append(f"- {f['id']}: {f['verdict']} (conf={f['confidence']} "
                        f"margin={f['margin']} evid={f['evidence']})")
            body.append(f"  state: {f['state'][:600]}")
    if report["broken"]:
        body += ["", "Broken pairs:"] + [f"- {b['id']}: {b['error']}" for b in report["broken"]]
    body += ["", "Advisory only; verify each finding against the tree before fixing."]
    p = subprocess.run(["gh", "issue", "create", "--title", title,
                        "--body", "\n".join(body)], cwd=ROOT,
                       capture_output=True, text=True)
    print(p.stdout.strip() or p.stderr.strip()[:200])


if __name__ == "__main__":
    sys.exit(main())
