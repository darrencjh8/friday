# Plan: Jev drift advisory (issue #194, follow-up of #184)

## Goal

A scheduled + on-demand Jev-powered audit that judges semantic
(doc-claim vs code-fact) pairs and reports drift as advisories.
Non-gating, never blocking. The deterministic `check-docs-drift.sh`
guard stays the gate and owns mechanical facts (counts, lists,
mkdir, ports); Jev owns meaning (framing, status words,
retired-thing semantics, cross-doc agreement, exact log strings).

## Evidence

- Calibration in `/tmp/opencode/jev-calib`: 16 pilot probes, then 68
  scored (34 pre-fix drifted / post-fix consistent from the #184 set)
  + 18 doc-only qualitative + 13 suspicious-item probes, all with known
  labels from the merged #184 work.
- Final pipeline — choice (`conf>=0.65`, `margin>=0.3`, else uncertain),
  then `noul` evidence round on drifted (`>=0.6`, else uncertain) —
  mirrors the payee flow's gates (`low_confidence`, `payeeEvidence`).
- Calibration result: drift recall 30/34 with 0 false alarms and 0
  confident misses; the rest abstain to human review.
  Non-determinism across runs is absorbed by the gates (same probe
  flips uncertain/consistent at low conf, never confident-and-wrong —
  except one 0.7 false alarm in v1, killed by the evidence round).
- Production dry runs on clean main: 0 drifted, 0 broken, rest split
  consistent/uncertain. Synthetic drift injection (framing + count):
  one abstained to human review, one failed closed at pair extraction
  (locator pins old wording — human fixes the pair, still surfaces).
- Self-correction during calibration: the alleged item-32 bad fix was
  my probe error (numbers live in portfolio-tracker/src/mcp-server.js
  and check out). Item 30's "seven" never existed in the repo (plan
  artifact, excluded). q39-post remains drifted and was left as-is
  deliberately.

## Changes

1. `scripts/jev_drift_audit.py` (stdlib only): loads
   `scripts/jev-drift-pairs.json`, builds one state per pair from
   claim templates + live extractors, choice + evidence rounds with
   the calibrated gates, writes findings JSON + step summary,
   optionally files one rolling `[jev-drift]` issue per day (deduped
   by title). Exit 0 on completed audit; exit 2 when a pair fails to
   extract (fail closed). `--pairs`, `--dry-run`, `--out` flags.
   No live Jev calls in unit tests; states never contain secrets.
2. `scripts/jev-drift-pairs.json`: 14 semantic pairs, each a claim
   template + extractor fills + `require` anchors. Adding an area =
   one JSON entry. Mechanical facts stay with the bash guard.
3. `.github/workflows/jev-drift.yml`: weekly Mon 05:17 UTC + dispatch
   (dry_run default true, pairs filter). ubuntu-latest, stdlib
   python3, `JEV_API_KEY` secret (already in GitHub), `issues: write`.
4. `modules/tests/test_jev_drift_audit.py`: gate math incl. the
   false-alarm scenario, threshold values, pair-spec validity (every
   fill resolves on the current tree), `require`-anchor presence (a
   locator that silently matches nothing is the known failure mode),
   no-secrets-in-states. No live Jev calls.

## Verification

- New unit tests pass; full `modules/tests` suite passes.
- YAML parses; workflow triggers do not overlap existing schedules.
- End-to-end dry run on current main with the real key: no confident
  drifted verdicts (main is clean; abstentions acceptable).
- CI on the PR green, including the new tests under `compose-config`.
  The scheduled job itself is verified by its first weekly run, not
  by merge.

## Out of scope

- No gating: advisory only, non-required workflow. No self-hosted
  runner (unnecessary — secret already in GitHub).
- No PII scanning: stays with `pii-scan.yml` / `secrets-scan.yml`;
  audit states never contain secrets.
- No auto-fix, no S12 code fix. Found drift becomes follow-up issues,
  fixed by hand.
