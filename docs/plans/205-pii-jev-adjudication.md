QUESTIONS
q: Does the JEV_API_KEY repo secret exist and work for the pii-scan job? | assumption: it exists because .github/workflows/jev-drift.yml already reads ${{ secrets.JEV_API_KEY }}; implementation verifies it resolves in the pii-scan job with a dry run that logs only a boolean, and if it is missing Darren adds the repo secret himself (the key value never goes in chat, the repo, or a log). The GitHub App token cannot read secret metadata (403 on the secrets API), and jev-drift has no recorded runs yet, so this could not be verified from here.
q: Will real JEV call the fixture finding a false positive? | assumption: yes — the finding is a synthetic fixture in a test file, judged from detector, file path, and domain; implementation proves it with one live probe of the real endpoint against the fixture finding before merge, and if JEV says otherwise the plan is revised (the allowlist remains the escape hatch, not the default).
q: Is sending PII-shape finding values to TypeSafe acceptable? | assumption: yes for PII-shape detectors only (CustomRegex PII shapes and Presidio PII name); credential-shape findings are never sent and are always emailed, except URI findings, which are sent with the password replaced by its shape (length, character classes, a short token-type prefix such as `ghs_`) so JEV can tell a test stub from a live credential without seeing the secret; a URI with no password is not sent. Residual risk, stated for Darren's approval: a genuine personal name/email leak would be sent to a model provider with no zero retention upstream; the mitigation is the detector allowlist (only PII shapes), adjudication after collect() so already-suppressed findings are never sent, and sending nothing but the single finding's fields — no file contents, no commit messages, no other findings.
q: What confidence gate suppresses a finding? | a: reuse scripts/jev_drift_audit.py's calibrated gates — choice "false_positive" with confidence >= 0.65 and margin >= 0.3; anything else (real, uncertain, low confidence, low margin, error) reports the finding.
q: Where does adjudication plug in — scan job, CI, or a separate step? | a: inside scripts/pii-scan-alert.py main(), AFTER collect(), on collect()'s surviving (name, value) keys, in the existing "Email findings" step; no new workflow, no new job, no CI change. The pii-scan workflow only gains one env line (JEV_API_KEY) on that step. (Plan review round 1, H1: adjudicating before collect() would re-send allowlisted and stale findings to JEV — collect() is the only filter for those, and TruffleHog writes full history every run.)

# Plan: adjudicate PII-scan findings with JEV (issue #205)

## Goal

Fix friday #205 in two parts, without adding another allowlist entry:

1. The scheduled PII scan must stop emailing the synthetic fixture in the
   test for #202 as a finding.
2. Feed the scan's final results to JEV and let it determine whether each
   finding is a false positive — wipe the false positives that way, instead
   of hardcoding more allowlist entries or fixture dodges.

## Evidence

- Reproduction recorded with dev-loop (`loop.py repro`, phase REPRODUCED):
  base `4d2c475`, command `python3 modules/tests/test_issue_205.py`,
  test id
  `tests.test_issue_205.TestIssue205.test_fixture_finding_adjudicated_false_positive`.
  At base it fails: the fixture finding is emailed and JEV is never asked.
- The flagged finding: commit `b88d3c264ed46622fc5573802d479140f55188fe`
  (the #203 merge), `modules/tests/test_issue_202.py:42`, where the test
  defines a synthetic example-domain address literal (`REAL_ADDRESS`) for
  the detector-shape check. The detector is the custom "PII email" regex in
  `.trufflehog.yml`, whose exclude list covers example/test/invalid/local
  domains but not the fixture's domain, so TruffleHog flags the test file
  itself. The test's own check asserts a real address is NOT excluded by
  the detector config, so the fixture cannot be dodged by moving it to an
  excluded domain without breaking that check's intent — and Darren
  directed against fixture dodges anyway.
- Scan pipeline, read end to end:
  - `.github/workflows/pii-scan.yml`: daily (Mon–Sat 18:41 UTC, last 2
    days) and Sunday 19:23 UTC full history; TruffleHog `git file://`
    with `.trufflehog.yml` and `scripts/pii-scan-exclude-paths.txt` writes
    `findings.jsonl`; Presidio `scripts/pii-scan-names.py` writes
    `names.jsonl` in the same JSONL shape; `scripts/pii-scan-alert.py`
    emails whatever survives. The run stays green when it finds something
    and turns red only when the scan or the email fails. Logs are public,
    so nothing may reveal a finding: no artifact, no job summary, and the
    alert script prints the same line whether or not anything was found.
  - `scripts/pii-scan-alert.py`: `load_allowlist()` reads exact
    (detector, name, value, commit, file) tuples from
    `scripts/pii-scan-allowlist.json`; `collect()` drops exact matches,
    drops committer-address commit-message hits, and (daily) drops commits
    outside the last 2 days; `render()` lists `[name] value` plus
    locations; `main()` emails only when anything survives. The fixture
    has no allowlist entry, so it survives `collect()` and is emailed.
  - Ordering ground (round 1, H1): TruffleHog writes full history on every
    run and `collect()` is the only filter for allowlisted tuples,
    non-recent commits, and committer-email hits; the allowlist holds 155
    PII-shape entries. Adjudicating before `collect()` would re-send those
    already-suppressed values to JEV on every run, so adjudication runs
    after `collect()` on its survivors only.
  - `scripts/pii-scan-names.py` emits Presidio PERSON findings in the same
    shape, so one plug-in point in the alert script covers both scanners.
  - `modules/tests/test_issue_185.py` and `modules/tests/test_issue_202.py`
    are the established pattern for these controls: values are read out of
    the allowlist / the file that defines them, never written literally.
- JEV in CI already exists: `scripts/jev_drift_audit.py` calls
  `https://api.typesafe.ai/v1/systemone` with
  `{"model": "jev-latest", "state": ..., "questions": ...}` over urllib
  with a Bearer key from `JEV_API_KEY`, timeout 90, and a choice question
  with `criteria` plus calibrated gates (confidence >= 0.65, margin >=
  0.3). `.github/workflows/jev-drift.yml` runs it with
  `JEV_API_KEY: ${{ secrets.JEV_API_KEY }}`. A surrogate (`hsurr:`) cannot
  be used here: surrogates are minted Muse-side per driver invocation and
  Actions cannot mint one — the scan job must use the stored repo secret.
- This plan quotes no flagged value anywhere (no allowlist value, no
  fixture value), so the plan file itself needs no allowlist entry, and no
  commit message in this run may quote one either (commit-message hits
  cannot be allowlisted).

## Changes

1. `scripts/pii-scan-alert.py` — adjudication, in the alert script only:
   - A function that takes `collect()`'s surviving dict, calls JEV once
     per distinct surviving (name, value) key, and drops suppressed keys
     before `render()`. The state for a key lists EVERY distinct location
     for that key — not just the first — so one location's context never
     decides all of them: a value appearing in both a fixture and a real
     file is judged on all its locations together, and fixture context
     alone cannot suppress the real occurrence. (Round 2, M1.)
     `collect()`, `render()`, and the allowlist path are untouched, and
     nothing `collect()` would already drop is ever sent to JEV. (Round 1, H1: the first draft adjudicated before `collect()`,
     which would have re-sent allowlisted and stale findings — TruffleHog
     writes full history every run and the allowlist holds 155 PII-shape
     entries — to an external provider on every run.)
   - Adjudicable names only: `PII email`, `PII SG phone`, `PII NRIC`,
     `PII card`, `PII SG address`, `PII name` (the `collect()` key's name;
     the first five are CustomRegex detectors, `PII name` is Presidio).
     Everything else — TruffleHog credential detectors, Postgres URIs,
     anything not in that set — is never sent to JEV and is always emailed.
   - One SystemOne call per distinct surviving adjudicable finding, same shape as
     the drift audit: POST `https://api.typesafe.ai/v1/systemone`,
     `{"model": "jev-latest", "state": ..., "questions": ...}`, Bearer
     `JEV_API_KEY`, 30s timeout, via `urllib.request.urlopen` (module
     attribute, not a from-import, so tests patch the single point). The
     call passes a `urllib.request.Request` carrying the JSON body, as
     `jev_drift_audit.ask()` does, so tests can read the state back out
     of the recorded request. The
     state text carries only the finding's own fields — detector, entity
     name, value, and ALL of its location strings (every distinct
     `<commit12> <file>:<line>`; commit-message locations, which have no
     file, are listed as such): the detector follows from the name, and
     the commit is the 12-char prefix, which is sufficient context for
     the verdict. Nothing else: no file contents, no commit messages, no
     surrounding lines, no other findings. The question is one `choice` question `verdict` with
     criteria `false_positive` (synthetic fixture, example, placeholder,
     or product name — not a real person's data), `real` (is or could be
     a real person's data or a real secret), `uncertain` (not enough
     evidence), following `jev_drift_audit.CHOICE_Q`'s shape.
   - Gates (reused from the drift audit): only a `false_positive` choice
     with confidence >= 0.65 and margin >= 0.3 suppresses the finding.
     `real`, `uncertain`, low confidence, low margin, a malformed answer,
     or any error/timeout reports the finding.
   - Fail open, always: `JEV_API_KEY` unset or empty skips adjudication
     entirely and emails as today. A per-finding failure never raises out
     of adjudication into a failed run — adjudication is best-effort, and
     the run stays green on findings as today.
   - Email: only reported findings are listed, with `render()` unchanged.
     When adjudication suppressed anything, append one footer line with
     the suppressed count only (no values), so silent suppression stays
     visible to Darren. No new log line: the script keeps printing only
     the single invariant `pii-scan-alert: scan complete` line, which must
     not reveal even whether anything was found (round 1, M1: a counts
     line would break that invariant and the existing output-equality test
     whenever the key is set).
   - No new allowlist entry. No change to `.trufflehog.yml` (test_issue_202
     pins the detector shape).
2. `.github/workflows/pii-scan.yml` — one env line on the "Email findings"
   step only: `JEV_API_KEY: ${{ secrets.JEV_API_KEY }}`. No other workflow
   change. The scan job already uses environment `darren-prod` for the
   mail secrets; `JEV_API_KEY` is a repo secret, as `jev-drift.yml` already
   references it, so no environment scoping is needed.
3. Tests — `modules/tests/test_issue_205.py` (already written, RED at base,
   left uncommitted in the clone; the implementation commit picks it up):
   - `test_fixture_finding_adjudicated_false_positive` — the repro
     control: the fixture finding plus a fake JEV answering false_positive
     must produce no email, and JEV must have been asked.
   - `test_real_finding_still_emailed` — a finding JEV calls real is emailed.
   - `test_jev_unavailable_still_emails` — a JEV error fails open to email.
   - `test_credential_finding_never_sent_to_jev` — a credential-shape
     finding is never sent to JEV and is emailed.
   - `test_jev_key_absent_still_emails` — no key means no JEV call and the
     finding is emailed.
   - `test_false_positive_low_confidence_still_emailed` and
     `test_false_positive_low_margin_still_emailed` (round 1, M2): a
     false_positive at confidence 0.60 (probabilities 0.60/0.25/0.15), and
     one at margin 0.10 (probabilities 0.50/0.40/0.10), must still be
     emailed. FakeJev is parameterised with confidence/probabilities per
     test instead of hardcoding 0.97/0.95, so a confidence-only gate or a
     dropped margin check fails these tests.
   - `test_stale_and_allowlisted_findings_never_sent_to_jev` (round 1,
     H1): in daily mode (`FULL_HISTORY=false`, `recent_commits` mocked to
     exclude the stale commit), a stale finding and an exact allowlisted
     finding produce zero JEV calls and no email.
   - `test_same_value_in_fixture_and_real_file_judged_on_all_locations`
     (round 2, M1): the fixture value at the fixture file and at a second
     file, under one (name, value) key — the JEV request's state must list
     both files. Read back out of the fake's recorded request, not from
     the email outcome.
   - Test-rule compliance: no flagged value is written in the test. The
     fixture value is read out of `test_issue_202.py` and the other values
     out of the allowlist entries; each finding is built at a commit/file
     whose exact tuple is not allowlisted. The fake JEV patches
     `urllib.request.urlopen` and returns the drift-audit answer shape.
   - Existing coverage must stay green: `modules/tests/test_issue_202.py`,
     `modules/tests/test_issue_185.py`, `scripts/test-pii-scan-alert.py`,
     and the CI suite command
     `python -m unittest discover -s modules/tests -p 'test_*.py'`. With
     no `JEV_API_KEY` in their env, those tests take the no-key path, which
     is byte-identical to today's behaviour, so they need no changes.

## Verification

- Tests gate: the recorded repro (fails at base) must pass at HEAD, plus
  the eight guard tests and the existing suite above.
- Live probe (implementation, before merge): one call to the real SystemOne
  endpoint against the fixture finding, using a fresh surrogate via
  `jev-surrogate.py` the dev-loop way (never the real key, never in a
  file), recording the verdict and confidence in the PR. This is the only
  proof JEV actually calls the fixture a false positive — the tests prove
  the wiring with a fake, not JEV's judgment.
- Key check (implementation, before merge): confirm `JEV_API_KEY` resolves
  in the pii-scan job with a dry run that logs only a boolean; if it is
  missing, Darren adds the repo secret.
- Live proof after merge: the next daily run still covers the #203 merge
  commit (last-2-days window), and the Sunday full-history run covers it
  forever — both must produce no email naming the fixture, and the runs
  stay green. No email is the signal: the workflow stays green whether or
  not findings exist, so the proof is the absence of the email, checked by
  Darren.

## Out of scope

- No allowlist entries added (deliberate — Darren's direction).
- No change to `.trufflehog.yml` detector shapes, `pii-scan-names.py`,
  `scripts/check-no-pii.py`, or the scan schedule.
- No caching or persistence of JEV verdicts: each run re-adjudicates, at
  current volumes (a handful of new findings per run). If the count grows,
  a cache is a follow-up, not this change.
- No change to the email subject, recipients, or SMTP setup; no JEV
  adjudication in CI (`test.yml`) — the scheduled scan job only.

## Risks and honest limits

- JEV's verdict on the fixture is unproven until the live probe. If it
  says real or uncertain, this plan is revised — the allowlist remains the
  escape hatch, not the default.
- A value appearing in both a fixture and a real file is adjudicated on
  all its locations together (round 2, M1), so fixture context alone
  cannot suppress the real occurrence.
- A genuine finding JEV misjudges as a false positive would be dropped
  from the email. Mitigated by the confidence-plus-margin gates and the
  detector allowlist; the email footer count makes suppression visible so
  Darren can ask about it.
- The residual exfiltration risk in QUESTIONS Q3 stands: a genuine
  personal name/email leak would be sent to TypeSafe. Accepted at approval
  time, bounded to PII-shape findings only.
- Adjudication runs after collect(), so the Sunday full-history run
  adjudicates only findings the allowlist did not already suppress — the
  known historical ones are dropped before JEV ever sees them. No verdict
  cache in this change; if the surviving count grows, a cache is a
  follow-up, not this change.
