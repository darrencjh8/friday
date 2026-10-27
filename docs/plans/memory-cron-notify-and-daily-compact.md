QUESTIONS
q: Should a nearly full store still be shown in the approve digest? | a: Yes, as an informational line when a digest is sent anyway; it no longer forces a message on its own.
q: Should a dashboard-chosen compact schedule be overwritten? | assumption: No. Only the exact previous defaults (30 8 * * 0 and 30 7 * * 0) migrate to the new daily default, matching the existing one-time migration pattern.
q: Does `memory-triage.sh compact` accept more than one target per plan? | a: No, one `target` per plan, so the prompt runs one plan file per store.

# Memory crons: notify only when actionable, compact daily and per store

## Problem

- `memory-approve-queue` (daily 08:00) treats "a store above 95%" as a reason to message the owner. They cannot act on that: only `memory-compact` frees room. With `USER.md` at 1322/1375 he gets a message every morning even when the queue is empty.
- `memory-compact` runs weekly (Sunday 07:30). The stores grew from 905 to 1322 (user) and 1667 to 2321 (memory) inside one week, so weekly is too slow.
- `memory-compact` only compacts the fullest store per run, so a second store over 80% waits another cycle.

## Change (modules/hermes/50-seed-defaults only)

1. memory-approve-queue prompt: drop "no store above 95%" from the `[SILENT]` condition. Keep the "⚠️ store nearly full" line as information in a digest that is sent for another reason.
2. memory-compact default schedule `30 7 * * *` (daily, still before the 08:00 approve run). One-time migration rewrites the exact previous defaults `30 8 * * 0` and `30 7 * * 0`, sets `schedule_display`, and clears `next_run_at` so the scheduler recomputes it. Custom schedules are kept.
3. memory-compact prompt: handle every store at or above 80%, fullest first, each with its own plan file (`/opt/data/tmp/compact-plan-memory.json`, `/opt/data/tmp/compact-plan-user.json`), dry-run then apply per store; the digest has one table row per compacted store. Still `[SILENT]` when no store needs it.
4. Update `modules/hermes/tests/test-50-seed-defaults.sh` expectations that pin the weekly schedule and the single plan file name.

## Tests

New `modules/tests/test_memory_cron_notify.py` (already collected by CI's `unittest discover -s modules/tests`):
`test_full_store_alone_does_not_notify`, `test_compact_runs_daily`, `test_weekly_compact_schedule_migrates_to_daily`, `test_compact_handles_every_full_store`. All four fail at base and pass after the change. `bash modules/hermes/tests/test-50-seed-defaults.sh` must stay green.

## Risk

Prompt and schedule text only; existing jobs pick up the prompt through the MANAGED reconcile on next boot. Daily compaction costs one short agent run per day, and it is silent when nothing is needed.
