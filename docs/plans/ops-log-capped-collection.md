QUESTIONS
q: Which of the two fixes in #134 should we take, accept a capped tail or raise the caps? | a: Accept a capped tail. The owner approved "accepts a capped log instead of failing" on the 2026-11-02 digest. Raising caps only moves the threshold.
q: Should a capped snapshot stay eligible for reproduction? | a: Yes. Reproduction uses a sanitized fixture and the captured image revision, and it does not depend on the snapshot being complete.
q: Does a capped snapshot hide the cap from the model? | a: No. The snapshot keeps `truncated: true`, and the prompt tells the job to mention the cap in its report.

# Accept capped log collections in ops-log-issues (#134)

## Problem
`_collect` in `modules/hermes/plugins/log-issue-triage/__init__.py` returns `partial` when a snapshot is `truncated`, and the `ops-log-issues` prompt says truncation means partial/blocked. A busy service always exceeds the cap in a day, so the job ends with `[CRON_FAILURE]` most days without finding anything. The scheduler-health publisher then files follow-ups such as #136.

## Change
1. `_collect`: only `collection_errors` produce `partial`. A truncated snapshot gets a `collection_id` and status `ok`; the snapshot still carries `truncated: true`.
2. `LOG_ISSUE_TRIAGE_PROMPT` in `modules/hermes/50-seed-defaults`, step 4: drop truncation from the failure list and say a `truncated: true` snapshot is a capped sample of usable evidence whose cap is mentioned in the report.

The collector stays as is. Collection failures, invalid JSON and collection errors still fail.

## Tests
New `modules/hermes/tests/test_log_issue_triage_capped.py`, picked up by the CI pattern `test_log_issue_triage_*.py`:
- `test_capped_collection_is_usable_and_still_reports_the_cap`: fails at base with `partial`.
- `test_collection_errors_still_make_it_partial`: guards the failure path.

Existing suite: `python3 -m unittest discover -s modules/hermes/tests -p 'test_log_issue_triage_*.py'`.

## Workaround noted
codex-router#462: the repro overlay does not reach `modules/hermes/tests/`, so the recorded repro command copies the new test in before running it.

## Risk
A real error outside the capped tail goes unseen that day. That was already true, since the job produced no findings when it failed.
