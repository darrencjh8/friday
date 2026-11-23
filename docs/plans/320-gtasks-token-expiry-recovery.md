QUESTIONS
q: Which scheduled job produced the observed notice — the daily wiki-due-reminders (08:15), the hourly proactive-tick, the Monday 04:00 wiki-finance-refresh digest, or the overnight nightly maintenance run? | assumption: wiki-due-reminders is the primary (it owns reminder-task creation; "no tasks were checked" matches its dedup view and helper), proactive-tick second (its tasks-source failure becomes an ALERT, which the prompt turns into [CRON_FAILURE]); the plan covers both. wiki-finance-refresh needs no change: its prompt never calls gtasks, so its digest simply stops seeing the failure once the two jobs stop failing. The build confirms which job it was from the host cron output for the affected job id before finalizing wording.
q: Where does the "run, rerun, edit and pause" wording in the observed notice come from? | assumption: Hermes's own failed-run delivery, not any seeded prompt or script — no such wording exists in modules/hermes/50-seed-defaults, modules/hermes/scripts/proactive-tick.py, modules/hermes/scripts/wiki-reminder-tasks.py, or modules/hermes/skills/gtasks-cli/SKILL.md. The fix avoids that delivery by never marking expiry a failed run; it does not change Hermes's failure-delivery wording.

# Expired Google Tasks credential: one plain recovery step, not scheduler internals

Issue: friday #320. When the Google Tasks credential expires, the scheduled check fails and the owner gets a failure notice written in scheduler internals (run, rerun, edit, pause), while task reminders silently stop until the owner reconnects by hand. Base: main `c168562`.

## What the code does today

- `modules/hermes/scripts/gtasks.py` already does the right thing. `_valid_token()` refreshes the access token when it is expired (expiry minus 60s) via `_refresh()`; `_refresh()` raises `AuthExpired` when there is no refresh token or the refresh fails with `invalid_grant` / `unauthorized` / `invalid_credentials` / `expired_token` / `autherror`. `_api()` retries once on HTTP 401 after a refresh, then raises `AuthExpired`. `main()` catches `AuthExpired` and prints the already-plain message "Google token expired or revoked. Run `google login` again interactively to reconnect." with exit code `EXIT_AUTH_EXPIRED = 3`. Acceptance criterion 4 (refresh attempted first) is already satisfied at the CLI layer, and the single recovery action is already named there. No change to gtasks.py.
- `modules/hermes/scripts/proactive-tick.py` (pre-run script for the hourly `proactive-tick` job, `0 8-21 * * *`) throws that away: `friday_tasks()` runs `gtasks.py tasks view -l Friday --format=json` and on any non-zero exit raises a generic `RuntimeError("gtasks failed: ...")`, except when the output says "not found". `main()` turns a source exception into a once-a-day `ALERT: source tasks failed: <error>` item, and the end-of-run open-tasks context appends `## Friday tasks\nunavailable: <error>`. The tick prompt's step 1 turns any ALERT line into a first-line `[CRON_FAILURE]` reply, and its FAILURE section names a gtasks error as a failed step. So one expired credential becomes a failed run.
- The token is shared, so the tick fails the same way through mail and calendar too. `gtasks.py` ("Login lives in `google login` … which grants one token shared with the read-only gmail and gcal CLIs"); `gmail.py` aliases `AuthExpired = gtasks.AuthExpired`, its `enabled()` only checks the scope is listed in the saved token and never validates it, and its `get()` calls `gtasks.token_for(scope)` outside its try block, so a dead refresh token raises `AuthExpired` out of `list_messages()`; `gcal.py`'s `list_events()` calls `gmail.get(..., scope=CALENDAR_SCOPE)`, so it raises the same way. Both land in `main()`'s generic per-source handler as `ALERT: source mail/calendar failed: Google token expired...`, and the tick prompt's step 1 turns any ALERT line into `[CRON_FAILURE]`. Fixing only the tasks source would still leave the tick failing in the exact scenario the issue describes.
- `modules/hermes/scripts/wiki-reminder-tasks.py` (helper for the daily `wiki-due-reminders` job, `15 8 * * *`) does the same: `view_tasks()` runs `gtasks tasks -l Planned view --format=json --include-completed` and on any non-zero exit raises `SystemExit("gtasks view failed: <stderr>")`; `main()` prints it and returns exit 2. The job prompt's FAILURE section turns any required-step failure into `[CRON_FAILURE]`. This helper is the job that creates the reminder tasks, so when its view fails no tasks are checked or created — the "reminders silently stop" half of the issue.
- `modules/hermes/50-seed-defaults` seeds both jobs' prompts (MANAGED prompt migrates in place on redeploy; schedule/enabled/deliver untouched). Neither prompt has an expiry carve-out today.
- The weekly `wiki-finance-refresh` digest (Mondays 04:00) has a "failed or stale checks" section, but its prompt never calls gtasks; it only reports failures the other jobs produce. No change there.

## Root cause

The expiry signal exists and is distinct (exit 3 from the CLI, `AuthExpired` in-process), but the callers collapse it into a generic failure, and both prompts treat any gtasks failure as a failed run. Hermes records a run as failed only on a first-line `[CRON_FAILURE]` reply, and delivers that failure with its own scheduler commands. The same dead token also fails the tick's mail and calendar sources through the same generic handler, so a tasks-only fix would still produce a failure notice — the handler must treat the expired-token signal from any source as the plain item. Fix the collapse points and the two prompts; the failure delivery is never triggered for expiry.

## Change

Build on a `fix/320-...` branch from main `c168562`. Four edits, nothing else.

1. `modules/hermes/scripts/proactive-tick.py`
   - Add `class TasksAuthExpired(Exception)`.
   - `friday_tasks()`: when the gtasks subprocess exits 3, raise `TasksAuthExpired` instead of `RuntimeError`. (Exit 3 is the CLI's expired/revoked signal; the "not found" → `[]` case is unchanged.)
   - `main()` per-source handler: catch `(TasksAuthExpired, gtasks.AuthExpired)` before the generic handler and emit a once-a-day plain item through the existing `seen` key (`google:auth-expired`), text exactly: `Google Tasks reminders are paused — run `google login` again to reconnect.` Never an ALERT line. (`TasksAuthExpired` is the tasks subprocess's exit-3 signal; `gtasks.AuthExpired` is the same failure raised in-process by the gmail/gcal modules when the shared token's refresh fails — `gmail.py` aliases it, `gcal.py` raises it. Resolve it with the same lazy SCRIPTS-on-sys.path import `google()` already uses.) One token, one recovery action: reconnecting restores mail, calendar, and tasks together, so one line covers all three sources.
   - `main()` open-tasks context: catch `TasksAuthExpired` and append nothing (the once-a-day item already carries it; on later runs the same day the section is simply omitted so the rest of the digest still delivers).
2. `modules/hermes/scripts/wiki-reminder-tasks.py`
   - `view_tasks()`: when the `gtasks` subprocess exits 3, raise `SystemExit` with only the plain message from stderr (no `gtasks view failed:` prefix — the prefix is what frames it as a tool error). Other exits keep the prefix.
   - No change to `create_task()`: a refresh token that is dead already fails the view first, so a create-time expiry is not a real path; if a problems list ever comes back containing only token-expired lines, the prompt carve-out below covers it.
3. `modules/hermes/50-seed-defaults` — add the same short paragraph to both prompts (tick: after step 1; reminders: before FAILURE):
   - `Expired Google token: when the tasks data, or any gtasks, gmail or gcal command output, says the Google token expired, that is not a failed step and never a [CRON_FAILURE] — even when a gtasks/gmail/gcal command reports it, including a `gcal add` login prompt or missing credentials. Send (tick: include in the digest) exactly one short line: "Google Tasks reminders are paused — run `google login` again to reconnect." Then continue with the rest of the run. Never name scheduler commands.`
   - Assumes the `gtasks` on the host PATH is this repo's `gtasks.py`, so exit 3 propagates; the build verifies that before finalizing.
4. Tests (RED first, then GREEN; no full suite locally, CI runs it on the PR)
   - New `modules/tests/test_proactive_tick_tasks.py` (same importlib + mock pattern as `test_proactive_tick_notepad.py`):
     - `test_friday_tasks_exit_3_raises_tasks_auth_expired`: stubbed subprocess exit 3 → `TasksAuthExpired`, not `RuntimeError`.
     - `test_friday_tasks_other_failure_still_raises_runtime_error`: exit 1 → `RuntimeError` (control: the generic path is untouched).
     - `test_main_reports_plain_line_once_a_day`: drive `main()` with the stubbed expiry → stdout carries the plain line and no `ALERT` line; a second run the same day omits the tasks line.
     - `test_mail_source_auth_expired_is_plain_line_not_alert` and `test_calendar_source_auth_expired_is_plain_line_not_alert`: stub the gmail/gcal calls to raise the in-process `AuthExpired` → `main()` emits the plain line and no `ALERT` line (the shared-token case: a dead refresh token fails all three tick sources, and the fix must hold for each).
   - Extend `modules/tests/test_wiki_reminder_tasks.py`:
     - `test_view_tasks_exit_3_reports_plain_message_only`: stubbed subprocess exit 3 with the CLI message on stderr → `SystemExit` message is exactly the plain message, with no `gtasks view failed:` prefix.
     - `test_view_tasks_other_failure_keeps_prefix`: exit 1 → message still starts `gtasks view failed:`.
   - Extend `modules/tests/test_cron_failure_marker.py` with a second test method following its `prompt_text()` extraction: both the `wiki-due-reminders` prompt and the `proactive-tick` prompt contain the expiry carve-out (add the tick prompt to the map with its opening line). The carve-out assertion checks the broad trigger (tasks data or any gtasks/gmail/gcal command output) and the explicit override of the FAILURE clauses. The existing `[CRON_FAILURE]` assertions stay untouched.
   - Validation: `cd modules/tests && python3 -m unittest test_proactive_tick_tasks test_wiki_reminder_tasks test_cron_failure_marker` (RED before the fix, GREEN after) and `bash modules/hermes/tests/test-50-seed-defaults.sh` (GREEN with the seed edits).

## Reproduction (bug gate; scratch harness only, never the host, never a real credential)

- Fake token: temp `XDG_CONFIG_HOME` holding `gtasks/token.json` with an expired `access_token` and no `refresh_token`. `gtasks.py tasks view -l Friday --format=json` exits 3 with the plain message.
- Tick today: `friday_tasks()` against that token raises `RuntimeError` → `main()` prints `ALERT: source tasks failed: gtasks failed: Google token expired...` → prompt step 1 replies `[CRON_FAILURE]`. After the fix: `TasksAuthExpired` → the plain line, no ALERT. Same for mail/calendar: stub `gmail.list_messages` / `gcal.list_events` to raise the in-process `AuthExpired` → today: `ALERT: source mail/calendar failed: ...` → `[CRON_FAILURE]`; after: the plain line.
- Reminders today: `wiki-reminder-tasks.py` with one candidate on stdin exits 2 printing `gtasks view failed: Google token expired...`. After the fix: exits 2 printing only the plain message, and the prompt carve-out turns it into the short Dots message instead of `[CRON_FAILURE]`.

## Out of scope

- Hermes's failed-run delivery wording (scheduler binary, not in this repo).
- Gmail / Calendar expiry in any other job's scripts: the tick's mail/calendar sources are in scope here because they share the tick run and the token; the reminders job's step 4a commands are covered by the prompt carve-out only, with no script change there.
- The monthly `gtasks-clear-completed` no_agent job: same pattern, not named by the issue.
- Any change to `gtasks.py` (refresh-first, plain message, exit 3 already exist) or the `gtasks-cli` skill (already says to tell the user to run `google login` again).
- Retry/backoff changes; the refresh is already attempted in the CLI.

## Verification after merge (host-side, for the PR description, not the build)

- After the seed migrates on deploy, the next expiry (or a host-side check of the affected job id's cron output at `$HERMES_HOME/cron/output/<job_id>/`) shows the plain line and no `[CRON_FAILURE]`. Host reads go through friday-claude per the repo rule; no host edit is part of this change.
