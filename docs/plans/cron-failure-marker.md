QUESTIONS
q: How does Hermes let an agent cron run report failure? | a: `cron/scheduler.py` defines `CRON_FAILURE_MARKER = "[CRON_FAILURE]"`; when the exact first line of the final reply is that marker, `_cron_failure_marker_error` routes the rest of the reply through normal failure bookkeeping, so `last_status` is not `ok`. Any other reply is recorded as `ok`.
q: Which jobs need it? | a: The six seeded agent jobs: ops-log-issues, memory-compact, memory-approve-queue, wiki-finance-refresh, wiki-repo-docs and wiki-due-reminders. Script jobs (`no_agent`) already fail on a non-zero exit, and user-created reminder jobs are not seeded.
q: Do existing jobs pick up the new prompt? | a: Yes. Each block's `MANAGED` dict is written over the live job's keys when they differ, so the next deploy's boot updates the live prompts.
q: Does a failure line conflict with `[SILENT]`? | a: No. The rule says to reply `[SILENT]` only when nothing failed; a failed step always produces a report, so the marker and silence never apply to the same run.

# Plan: seeded agent cron jobs declare failed runs (issue #91)

## Problem

ops-log-issues recorded `ok` while every log collection failed (#72), and the memory jobs recorded `ok` after skipping a skill that could not be found. Hermes records a failure only when the reply's first line is exactly `[CRON_FAILURE]`, and no seeded prompt asks for it.

## Change

1. In `modules/hermes/50-seed-defaults`, append the same short FAILURE paragraph to the end of each of the six seeded agent prompts: when a required step failed (a tool or script error, a failed, partial or blocked stage, a listed skill not found, missing credentials), make the first line of your reply exactly [CRON_FAILURE], then report what failed; never reply [SILENT] after a failed step.
2. No change to script jobs, Hermes itself, or delivery settings.

## Tests

- New `modules/tests/test_cron_failure_marker.py::CronFailureMarkerTest.test_every_agent_cron_prompt_declares_failures` (the reproduction): reads each of the six prompts out of the seed and asserts it carries the marker rule. RED at base, GREEN after.
- Existing `python3 -m unittest discover -s modules/tests -p 'test_*.py'` and `modules/hermes/tests`.

## Out of scope

Making script jobs or `portfolio-sync.sh` stricter (#81 tracks the taxonomy export warning), and changing how Hermes parses the marker.
