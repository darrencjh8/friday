QUESTIONS
q: Which detector flagged "Segoe UI" and "Upstash Redis"? | a: Presidio, as "PII name". scripts/pii-scan-names.py emits Presidio PERSON findings shaped {"DetectorName": "Presidio", "ExtraData": {"name": "PII name"}, "Raw": value}; scripts/pii-scan-alert.py renders them as "[PII name] <value>". Existing "PII name" allowlist entries use detector Presidio.
q: What exactly goes in the allowlist? | a: Three entries, one per occurrence, in the existing entry format (detector, name, value, commit, file), as listed under Changes below (commit 48ca43c3cf90f5ec64861a6d8c198c3500cdf8a9, one entry per flagged file). The allowlist suppresses exact (detector, name, value, commit, file) tuples only, so the same value elsewhere or from another detector stays reportable.
q: How is the fix verified? | a: modules/tests/test_issue_185.py feeds the three occurrences as Presidio findings into pii-scan-alert.collect() with the shipped allowlist and asserts none is reported. It fails at base and passes at HEAD. Existing tests tests/test_pii_allowlist.py and scripts/test-pii-scan-alert.py must still pass.
q: Does the allowlist file itself get scanned? | a: No for the name scan: scripts/pii-scan-names.py excludes scripts/pii-scan-allowlist.json from its git log, and scripts/test-pii-scan-alert.py asserts that exclusion. (Plan review round 1, 185-R1-02: the allowlist file IS scanned by scripts/check-no-pii.py — it is not in SELF_EXEMPT — it passes because the values are not forbidden literals, not because it is excluded.)
q: The plan and the repro test quote the two values in added lines — will the next scan flag the plan/test commit itself? | a: Yes, it can: verified with the real Presidio scan (presidio_analyzer + en_core_web_md). The first plan commit (7d20cb9, since rewritten) flagged 7 lines, including its commit message and the test docstring. After rewording, the current plan commit (8ac768996a686020a099b3cc630ca999e5d490e3) flags only 2 lines, both the entry-example lines in the plan file; the current commit message and test docstring quote neither value and do not flag. Commit-message hits cannot be allowlisted (a null file would match commit-message hits, which must stay reportable), so no commit message in this run may quote either value. The still-flagging plan-file lines get one allowlist entry at the final plan commit hash, in the fix commit (same pattern as existing entries for values quoted in plan docs/test files, e.g. "Chat Completions" in docs/plans/695-portfolio-tracker-responses-auto-thinking.md). (Plan review rounds 1-2, 185-R1-01, 185-R2-01, 185-R2-02.)

# Plan: whitelist PII-scan false positives (issue #185)

## Goal

Fix friday #185: the scheduled PII scan flags "Segoe UI" and "Upstash Redis" as `[PII name]`, but neither is a person — "Segoe UI" is a font name in a CSS font stack, "Upstash Redis" is a service name in comments. Add both values to the PII-scan allowlist so the scan stops reporting them.

## Evidence

- Reproduction recorded with dev-loop (`loop.py repro`, phase REPRODUCED):
  command `python3 modules/tests/test_issue_185.py`, test id
  `test_issue_185.TestIssue185.test_pii_false_positives_whitelisted`.
  At base it fails: all three occurrences are still reported by
  `pii-scan-alert.collect()` with the shipped allowlist.
- Verified by file reads and git: commit `48ca43c3cf90f5ec64861a6d8c198c3500cdf8a9`
  ("feat(dots): serve the Dots web app on the tailnet (#178)") contains
  "Segoe UI" at `modules/dots-web/src/styles/theme.css:26` (font stack),
  "Upstash Redis" at `modules/dots-web/api/_lib/pairing.ts:3` and
  `modules/dots-web/api/pair.ts:5` (comments naming the storage service).
  All three values are still present at HEAD.
- Detector confirmed: `scripts/pii-scan-names.py` emits Presidio PERSON
  findings with `DetectorName: Presidio` and `ExtraData.name: "PII name"`,
  which `scripts/pii-scan-alert.py` renders as `[PII name] <value>` and
  suppresses only on an exact allowlist tuple match.

## Changes

1. `scripts/pii-scan-allowlist.json`: append three entries in the existing
   format, keeping the file's current ordering (new entries at the end, after
   the existing Presidio entries):
   - `{"detector": "Presidio", "name": "PII name", "value": "Segoe UI", "commit": "48ca43c3cf90f5ec64861a6d8c198c3500cdf8a9", "file": "modules/dots-web/src/styles/theme.css"}`
   - `{"detector": "Presidio", "name": "PII name", "value": "Upstash Redis", "commit": "48ca43c3cf90f5ec64861a6d8c198c3500cdf8a9", "file": "modules/dots-web/api/_lib/pairing.ts"}`
   - `{"detector": "Presidio", "name": "PII name", "value": "Upstash Redis", "commit": "48ca43c3cf90f5ec64861a6d8c198c3500cdf8a9", "file": "modules/dots-web/api/pair.ts"}`
   - One further entry for the plan file itself, covering the two entry-example lines the real Presidio scan still flags in the plan commit: `{"detector": "Presidio", "name": "PII name", "value": "Upstash Redis", "commit": "<final plan commit hash>", "file": "docs/plans/185-pii-allowlist-false-positives.md"}`. The commit is the plan commit as it stands at implementation time, read with `git rev-parse` on that commit (a hash written here would go stale on the next plan revision, since amending the plan rewrites its hash); if the plan is revised again, the hash is re-derived by re-running the real scan on the new plan commit, and if that scan flags any further plan/test tuple, an entry is added for that tuple too. Suppression is per exact tuple, so this one entry covers every flagged line in the plan file.
   Four entries total. No other file changes. No behaviour change: allowlist only.
2. Tests:
   - `modules/tests/test_issue_185.py`: the reproduction control, kept as
     RED/GREEN (fails at base, passes at HEAD). It also asserts the shipped
     allowlist still loads (a malformed allowlist must fail the run, not
     silence it — see `load_allowlist`).
   - Existing coverage must stay green: `python3 tests/test_pii_allowlist.py`
     and `python3 scripts/test-pii-scan-alert.py`.

## Out of scope

- No change to the scan, the detectors, or the alerting flow.
- No change to the flagged files themselves.
- No whitelisting of the same values from any other commit, file, or detector.

## Verification

- `python3 modules/tests/test_issue_185.py` passes at HEAD (was failing at base).
- `python3 tests/test_pii_allowlist.py` passes (8 tests).
- `python3 scripts/test-pii-scan-alert.py` passes.
- `python3 scripts/check-no-pii.py` still passes (the allowlist file is scanned by it, not excluded — it passes because the added values are not forbidden PII literals; the change must not introduce a real PII literal).
- Real Presidio verification, executable as written: (1) run the real Presidio scan over the final plan commit's added lines — `git log -p` for that commit fed through `scripts/pii-scan-names.py`'s `added_lines()` and Presidio `PERSON` analysis (presidio_analyzer + en_core_web_md, as the scheduled scan does) — and list every flagged (value, file) tuple; (2) confirm every flagged tuple has an allowlist entry in the fix commit (the plan-file entry above, re-derived to the final plan commit hash); (3) feed the flagged findings into `pii-scan-alert.collect()` with the shipped allowlist, as `modules/tests/test_issue_185.py` does, and assert none is reported. The fix commit message quotes neither value. (Plan review rounds 1-2, 185-R1-01, 185-R2-01.)
- Dev-loop review round, then push branch and create PR, no merge by the agent.
