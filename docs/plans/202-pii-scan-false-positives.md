QUESTIONS
q: Which of (a) the .local detector exclusion / (b) the worker identity change does this fix adopt? | a: Both. (a) stops the 7 historical findings being reported on Sunday full-history runs; (b) stops new ones being created. (a) alone leaves the repo rule (author-email job: new commits use a noreply address) violated; (b) alone cannot silence history.
q: What is the bot's noreply address for the new worker identity? | a: 354272786+friday-muse-agent[bot]@users.noreply.github.com — bot id 354272786 verified via the GitHub API; the domain is already in the detector's exclude list and in the author-email job's allowlist.
q: Where is the identity change recorded? | a: Main chat owns it (worker brief template, AGENTS.md/MEMORY.md); this repo change carries only the detector config, allowlist, and tests. The plan names the new identity so the main chat can apply it.
q: How is the .local exclusion verified without a full TruffleHog run? | a: The new test compiles the exclude regexes from .trufflehog.yml and asserts a neutral synthetic .local address is excluded and a real-domain address is not; plus the alert script's own tests and CI. The next scheduled Sunday full-history run is the live proof — named as unverified until then.
q: Does the plan quote the flagged product names? | a: No, deliberately. It names them only by file, line, and commit, so the plan file creates no new scan surface and needs no allowlist entry of its own. The values live only in the allowlist (scan-excluded) and the test reads them from there.

Fix friday #202: the scheduled PII scan emails false positives — a bot
identity address in merge commit messages, and two product names already
allowlisted at older commits. No flagged email address is quoted anywhere
in this plan, the PR body, or any commit message; the product names are
named only by file, line, and commit.

## Background (verified from the repo)

The scan is `.github/workflows/pii-scan.yml`: TruffleHog (custom "PII
email" detector in `.trufflehog.yml`) plus `scripts/pii-scan-names.py`
(Presidio PERSON), emailed by `scripts/pii-scan-alert.py`. Daily runs
scan the last 2 days; Sunday runs scan full history.

- Group 1 — email in 7 merge commit messages (`22221df`, `6ec8ff9`,
  `4f2af1b`, `51cc1a0`, `b826d5b`, `9d4ec13`, `2bccac88`, short SHAs):
  each message carries a `Co-authored-by` trailer with the Friday bot's
  local commit identity address, a synthetic `.local` address. Verified
  per commit: every one of the 7 carries exactly one such trailer (the
  `51cc1a0` message carries a second trailer at an already-excluded
  noreply domain). The address is the worker git identity
  (`user.name` Friday, `user.email` the `.local` address) used for worker
  commits.
- Group 2 — product name at `.agents/skills/full-deploy/SKILL.md:155`
  (a section heading for a Chrome DevTools Protocol daemon), commit
  `8a182bcce1e0618e145986edd478ab2087fc5935`. The same value is already
  allowlisted at commit `de3ba48a`; suppression is per exact tuple, so
  the new commit needs a new entry.
- Group 3 — product name at
  `docs/plans/185-pii-allowlist-false-positives.md:38-40`, commit
  `2bccac8885aeac21762129286d66c98ed51c839a`. The #185 plan itself
  prescribes adding an entry for a newly flagged plan/test tuple; this is
  that tuple.

## Root cause

- Group 1: `scripts/pii-scan-alert.py` `collect()` suppresses a finding
  only on an exact `(detector, name, value, commit, file)` allowlist
  tuple, and `load_allowlist()` requires every entry to have a non-empty
  `file` — so a commit-message hit (no file) can never be allowlisted.
  Its only other escape is a no-file hit whose raw value is a substring
  of the commit's git email, which does not apply here: the trailer
  address is not the merge commit's author email. And
  `.trufflehog.yml`'s PII-email detector excludes noreply domains but
  has no exclusion for the `.local` pseudo-TLD. The source is the worker
  identity: the repo's author-email CI job
  (`.github/workflows/secrets-scan.yml`, report mode) already requires
  new commits to use a noreply author email, and the current worker
  identity violates it.
- Groups 2 and 3: suppression is per exact tuple, so a value flagged at
  a new commit needs a new entry even when the same value is allowlisted
  at an older commit.

## Changes

1. `.trufflehog.yml`: in the PII-email detector's first
   `exclude_regexes_match` entry, add `|[a-z0-9-]+\.local` to the domain
   alternation, next to the existing `[a-z0-9-]+\.invalid`. One line.
   `.local` is an RFC 6762 mDNS pseudo-TLD that never routes on the
   public internet, so no real person's address can end in it — the same
   reasoning as the existing `.invalid` exclusion. This stops TruffleHog
   emitting the finding at all, including Sunday full-history runs, for
   any `.local` address.
2. `scripts/pii-scan-allowlist.json`: append two entries at the end, after
   the existing Presidio entries, in the existing format. The value of
   each is the product name occurring at the cited line, read from that
   line at implementation time (it is not quoted in this plan, so the
   plan creates no new scan surface):
   - `{"detector": "Presidio", "name": "PII name", "value": <product name at .agents/skills/full-deploy/SKILL.md:155>, "commit": "8a182bcce1e0618e145986edd478ab2087fc5935", "file": ".agents/skills/full-deploy/SKILL.md"}`
   - `{"detector": "Presidio", "name": "PII name", "value": <product name at docs/plans/185-pii-allowlist-false-positives.md:38-40>, "commit": "2bccac8885aeac21762129286d66c98ed51c839a", "file": "docs/plans/185-pii-allowlist-false-positives.md"}`
3. `modules/tests/test_issue_185.py`: `EXPECTED_ENTRIES` 4 → 5. The new
   plan-file entry matches that test's filter (`commit == 48ca43c3…` OR
   `file == docs/plans/185-pii-allowlist-false-positives.md`). One line.
4. `modules/tests/test_issue_202.py`: new reproduction control, already
   written for the repro and committed unchanged by the implementation
   worker. It reads the two new allowlist entries (filtered by their
   commits) and asserts `collect()` suppresses their findings and each
   value still occurs in its file; it also compiles the PII-email
   exclude regexes from `.trufflehog.yml` and asserts a neutral synthetic
   `.local` address is excluded and a real-domain address is not. It
   never hardcodes a flagged value: values come from the allowlist, and
   the `.local` check uses a neutral synthetic address.
5. Process step, main-chat-owned (no repo change): worker git identity
   becomes `354272786+friday-muse-agent[bot]@users.noreply.github.com`
   (`user.name` stays Friday). The main chat records it in the worker
   brief template and `AGENTS.md`/`MEMORY.md`. Verified by inspection of
   the next worker commit's `Co-authored-by` trailer, not by CI.

## Tests

- Test id: `test_issue_202.TestIssue202.test_pii_scan_false_positives_suppressed`.
- RED already recorded: the test fails at base `e8d3a02` (phase
  REPRODUCED) — no allowlist entries at the two new commits, and the
  detector config has no `.local` exclusion.
- At HEAD, run: `python3 modules/tests/test_issue_202.py`,
  `python3 modules/tests/test_issue_185.py`, and
  `python3 scripts/test-pii-scan-alert.py` (its 15 tests). CI covers the
  full Python suite via the compose-config job and the alert tests via
  the secrets-scan job.
- The tests gate replays the recorded repro command at HEAD; it must pass.

## What this does not do

- No allowlist entry for the email findings: impossible by design (see
  Root cause). No history rewrite: the 7 merge commits keep their
  trailers; the detector exclusion silences them instead.
- No change to `scripts/pii-scan-alert.py`, `scripts/pii-scan-names.py`,
  the scan schedule, or the author-email job (it stays in report mode;
  flipping it to enforce is a separate decision).
- No change to the plan-cleanup workflow work.

## Verification limits (honest)

- No local full TruffleHog/Presidio run: heavy, and the plan verifies
  the regex by unit check plus the alert script's own tests and CI
  instead. The next scheduled Sunday full-history run is the live proof
  that the 7 email findings stop; until then it is unverified.
- The identity change is verified by inspection of the next worker
  commit, not by CI.
- The implementation worker re-derives the two product-name values from
  the cited lines; they are deliberately not quoted in this plan.

## Ponytail

Shortest diff: 1 regex line, 2 allowlist entries, 1 count line, 1 new
test file. No new scripts, no allowlist schema change, no alert-script
change. Skipped: a broader detector overhaul, rewriting history,
flipping author-email to enforce.
