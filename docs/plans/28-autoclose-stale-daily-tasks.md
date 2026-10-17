QUESTIONS
q: What happens to undone daily habit tasks today? | a: Each day the helper creates a task with a per-date marker (`wiki-reminder-marker:{key}:{action_date}`); an uncompleted one stays open in Google Tasks and the next morning another task for the new date is created — unfinished dailies accumulate as open tasks with past due dates. Nothing ever touches them again.
q: What is the change? | a: The helper's run now closes (marks completed, never deletes) stale open daily-habit tasks: any Planned-list task whose notes carry our marker prefix, whose key belongs to a `daily` candidate in the current run, whose stored date parses and is strictly before today, and whose status is not `completed` — is closed with the gtasks CLI. Weekly, monthly, and unscoped keys stay manual, exactly as the wiki-removal hint promises.
q: Why close and not delete? | a: Closing is the reversible, non-destructive path (completed tasks stay retrievable in Google Tasks); deletion would silently destroy user-visible history, contradicting the existing "tasks are never deleted" contract.
q: How is close invoked safely? | a: The helper shells arg-arrays to `gtasks tasks done -l Planned --id <taskId>`. Closing needs an explicit task id, because closing by the CLI's positional list index would re-resolve the whole list and could hit a moving target between view and PATCH. gtasks.py's `done`/`undo` subcommand gains an optional `--id` argument; without it the existing positional-number path is byte-identical.
q: Where does the list data come from? | a: The existing one-liner already runs `gtasks tasks -l Planned view --format=json --include-completed`; it is refactored into `view_tasks()` returning the full task records (id/status/due/notes), and `existing_markers()` derives its map from that — same fetched data, zero extra API calls, behavior identical for the current callers.
q: When in the run does the sweep happen? | a: After the candidate loop, before the snapshot write. Order relative to creation is irrelevant (today's marker differs from any stale one), but after-creation keeps creation failures first-class.
q: What if closing fails? | a: Each failure appends a `close-failed: {key}: {stderr}` problem — it renders on the dashboard Problems card and reports to Telegram like every other problem, without breaking the rest of the run (creation already committed).
q: What is logged? | a: The run summary gains a `closed` list of `{key}` (keys only, matching how created/skipped/pending already log keys; habit titles never go into stdout). Snapshot `summary` gains the same count. No new secrets, tokens, or PII surfaces.
q: What about the seed prompt contract? | a: The agent is told to "never update, delete, or move tasks" — that stays for the agent. The pinned rewrite of rule 5: "Dedup of Google Tasks is by the wiki-reminder-marker: note line, reading the Planned list with --include-completed; never update, delete, or move tasks yourself — the helper's own close sweep is the single sanctioned mutation: it auto-closes stale open daily-habit tasks dated before today (marks them completed, never deletes)." Step 6's helper description gains "(it also closes stale open daily-habit tasks from earlier days; close failures arrive in its problems list)". The seed harness has no assertion counter — the daily-reminder `checks` dict gains boolean keys ("stale_close": "auto-closes stale open daily-habit tasks" in prompt), not a count.
q: Why does the sweep require the key to exist in today's candidates? | a: Wiki-scoped: a daily habit removed from the wiki has its lingering tasks closed manually by the user (documented removal hint); auto-closing keys not sanctioned by today's wiki would be the helper deciding on stale authority. The wiki is the source of truth for what counts as a repeating daily habit today.
q: Everything else frozen? | a: Marker format, create path, conflict/skip/pending logic, snapshot item schema, TASK_LIST, auth surface, dashboard PAGE — untouched. gtasks.py's other verbs untouched.

## Change surface

- `modules/hermes/scripts/gtasks.py`: `tasks done|undo` accept `--id` (explicit task id); positional-number path unchanged. Gated argparse test pins `--id` parsing: `build_parser().parse_args(["tasks","done","-l","Planned","--id","X"])` → `args.id == "X"` (red at base: the arg does not exist, so parse_args raises).
- `modules/hermes/scripts/wiki-reminder-tasks.py`:
  - `view_tasks()` (refactor of the existing view subprocess call); `existing_markers()` derives from it; a comment names the pre-existing 100-record cap (no pagination) and its two silent consequences (same-day dedup skip, sweep coverage beyond page 1) as known accepted limits for a future plan.
  - `close_stale_daily(tasks, daily_keys, current)`: filter (marker prefix, key ∈ daily_keys, date parse, date < current, status ≠ completed) then close by id; returns closed keys + close-failed problems.
  - `main()`: daily keys from candidates; sweep after the loop; problems extended; printed summary gains `"closed"`; snapshot summary gains closed count.
  - Module docstring: "Never updates, deletes, or moves tasks" — with the single sanctioned exception spelled out.
- `modules/hermes/50-seed-defaults`: rule 5 rewording + step 6 helper note (prompt strings only).
- `modules/tests/test_wiki_reminder_helper.py`: fake gtasks harness entries gain `id`/`status` fields; new test methods below.

## Test command and scope

- `.venv/bin/python -m unittest modules.tests.test_wiki_reminder_helper`
- `.venv/bin/python -m unittest modules.tests.test_gtasks_tasks_id`
- `.venv/bin/python -m unittest modules.tests.test_reminders_server` (adjacent-surface guard)
- `bash modules/hermes/tests/test-50-seed-defaults.sh`
- `bash modules/hermes/tests/test-docker-compose-env.sh`
- `.venv/bin/python scripts/check-no-pii.py`

New tests, red at base:
- `HelperTests.test_close_stale_daily_tasks`: daily key with an open task dated before today → run issues `["gtasks","tasks","done","-l","Planned","--id",…]` exactly once for that task only; summary `closed` lists the key; task already completed or empty/missing id → no close call; weekly key overdue → no close call.
- `HelperTests.test_close_failure_is_a_problem`: done subprocess returns 1 → `close-failed: {key}` in problems and snapshot; created flow still completed.
- `GtasksIdArgsTests.test_done_accepts_id` (modules/tests, argparse-level against gtasks.py's `build_parser`): `tasks done --id X` parses with `args.id == "X"` and no number required (red at base: unknown argument raises).
- Seed script: the daily-reminder `checks` dict gains `"stale_close": "auto-closes stale open daily-habit tasks" in prompt` (no assertion counter exists in the harness); regression = the pinned rule-5 sentence above must keep both the forbid clause ("never update, delete, or move tasks yourself") and the exception clause — no bare absence assert on the old sentence, since the pinned rewrite legitimately contains the forbid words.

## Constraints

- Arg-array subprocess only (no shell) — unchanged pattern.
- Close is PATCH status=completed; no title/notes/due edits, nothing deleted.
- Marker prefix constant reused; date strictly `< current` (never today).
- Snapshot schema backward-compatible: summary dict gains one key; item schema untouched.
- Existing helper behavior byte-identified by the same suite (8 existing tests stay green unmodified except the fake tasks' added id/status fields, which mirror the real gtasks view JSON).

## RED control

Feature: no repro. Gating test id for the tests gate:
`modules.tests.test_wiki_reminder_helper.HelperTests.test_close_stale_daily_tasks`
(fails at base: no sweep exists, so no `done` command is ever issued).

Mutation commands (throwaway worktree, `python3`, no `.venv`):
- `python3 -m unittest modules.tests.test_wiki_reminder_helper.HelperTests.test_close_stale_daily_tasks`
- `python3 -m unittest modules.tests.test_wiki_reminder_helper.HelperTests.test_close_failure_is_a_problem`
- `python3 -m unittest modules.tests.test_gtasks_tasks_id.GtasksIdArgsTests.test_done_accepts_id`

# Plan: auto-close stale open daily-habit tasks (issue #28)

Feature. Base 5f2e1fc3. gtasks.py minor CLI extension; helper sweep; seed prompt wording; helper tests.
