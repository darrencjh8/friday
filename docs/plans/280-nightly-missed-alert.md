QUESTIONS
q: Is the marker exactly "Nightly maintenance" — the first text of the nightly's first Friday call — and where does the nightly prompt live? | assumption: Yes, exactly "Nightly maintenance", per the issue (authored by friday-claude, which runs the nightly). The nightly prompt is not in this repo — the nightly is a Claude Code run on the host, not a Hermes cron job — so verification step 1 confirms the literal text from the nightly prompt on the host. If it differs, the constant changes and the plan is re-reviewed.
q: Which state.db columns hold a session's first-message text, and which value marks an API-server session? | assumption: The `messages` table carries a text column and a role/type column, queryable per session by earliest timestamp, and `sessions.source` (or `created_source`) marks API-server sessions. Verification step 1 records the exact schema from the deployed image/host. If the messages table carries no text, the fallback is the first user line of `$HERMES_HOME/sessions/<id>.jsonl`; if neither yields first-message text, stop and re-review.
q: Does `sessions` carry a created timestamp, or is session start derived from the earliest message? | assumption: Derived from min(messages.timestamp) for the session. Verification step 1 records whichever the schema offers, preferring a sessions-table created column when one exists.
q: Does the nightly reliably run between 02:00 and 07:00 SGT, so "no session since 02:00" at 07:00+ means missed, not merely not-yet-run? | assumption: Yes — the issue's 02:00 lower bound is the nightly's scheduled window. Verification step 1 confirms the nightly's scheduled time on the host. If the nightly can legitimately run after 07:00, the threshold moves past its latest expected finish and the plan is re-reviewed.
q: First alert at the 08:00 tick (schedule unchanged) rather than adding a 07:00 tick? | assumption: Yes. The tick runs hourly 08:00–21:00, so 08:00 is the first tick that can fire the alert; the 07:00 threshold is the check condition, evaluated at that tick. Darren can ask for a 07:00 tick at approval.

## Goal

Nobody notices when the Claude Code nightly maintenance run does not fire, because a missed run sends nothing (issue #280). Darren said "yes, please do this" on the 2026-11-19 nightly digest to the idea "Alert when the nightly is missed". One check in the hourly proactive-tick job alerts him, once a day, when the nightly did not reach Friday today.

## Evidence

1. `proactive-tick` is an hourly agent job, `0 8-21 * * *`, deliver `dots` (`modules/hermes/50-seed-defaults`, seed block "Seed proactive-tick cron job", line 1973; `MANAGED` prompt/script/`attach_to_session`, `DEFAULTS` schedule line 2026). Its pre-run script is `modules/hermes/scripts/proactive-tick.py`; empty stdout skips the agent run, so a tick with nothing new costs no tokens.
2. The once-per-day `seen` mechanism is the state file `$HERMES_HOME/proactive-tick/state.json` (`STATE`, `proactive-tick.py:59`; `HOME` defaults to `/opt/data`, line 57). `save_state` (line 305) keeps only entries dated today. A source returns `[(key, text)]` items; `main()` marks each printed key seen for today, so it is offered at most once a day.
3. The exact precedent is `patch_source` (`proactive-tick.py:122`): key `patch:mnemosyne-cron-readonly`, returns `[]` once seen, otherwise one `ALERT:` line (line 129). The hour-gate precedent is `persona_source` (line 255): `datetime.datetime.now(SGT).hour < PERSONA_HOUR` returns `[]` before the hour (`PERSONA_HOUR = 18`, line 251). `SGT = timezone(timedelta(hours=8))` (line 64); `today = datetime.now(SGT).date()` in `main()` (line 314).
4. No prompt change is needed. The seeded prompt step 1 (`50-seed-defaults:1997`): "Alerts: if the data has any line starting with ALERT, make the first line of your reply exactly [CRON_FAILURE], then relay each alert in one line." A script-emitted `ALERT:` line is relayed to Darren by the agent. No seed-block change is needed either: the schedule already covers the alert window and the `MANAGED` block is unchanged.
5. Sessions live in Hermes' state database, `$HERMES_HOME/state.db` (`modules/hermes/plugins/dots/adapter.py:650`, `get_hermes_home() / "state.db"`; same `HERMES_HOME`, default `/opt/data`). The `sessions` table columns verified from repo references: `id`, `input_tokens`, `output_tokens`, `last_active`, `source`, `created_source`, `system_prompt_hash`, `tool_names`, `cwd`, `parent_session_id`. The `messages` table has `session_id` and `timestamp` (`adapter.py:412`, `_spread`). Session transcripts also exist as `$HERMES_HOME/sessions/<id>.jsonl` (vendored upstream `hermes_state` fixture, line 435). The messages-table text/role columns and the API-server `source` value are NOT in this repo — the schema lives in the deployed upstream image (`nousresearch/hermes-agent:stable`, `modules/hermes/Dockerfile:1`) — so verification step 1 records them from the host before implementation.
6. The read-only sqlite pattern already exists in this script: `sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)` (`read_slots`, `followups_source`), and in the adapter (`adapter.py:368`). A broken source is reported, never hidden: `main()` wraps each source in try/except and emits a once-per-day `ALERT: source <name> failed: <error>` (line 331), the same wrapper `tasks_source` relies on when `gtasks` fails.
7. The "Nightly maintenance" marker text does not appear anywhere in this repo, and neither does the nightly's schedule: the nightly is a Claude Code run on the host, not a Hermes cron job. The marker and the 02:00 window come from the issue, and verification step 1 confirms both on the host.
8. The script ships with the rest of `modules/hermes/scripts/` at deploy (`DEPLOY.md:244` copies `scripts/*` into `/opt/data/scripts/`), so no install step and no seed change.

## Changes

Two files. No new script, no new job, no prompt change, no schedule change, no seed change.

1. `modules/hermes/scripts/proactive-tick.py` — one new source, same shape as `patch_source`:
   - Constants next to `PERSONA_HOUR`: `NIGHTLY_HOUR = 7`, `NIGHTLY_SINCE_HOUR = 2`, `NIGHTLY_MARKER = "Nightly maintenance"`, key `"nightly:missed"`. The marker constant changes if verification step 1 finds different literal text.
   - `nightly_source(today, seen, cursors)`:
     - Return `[]` when `seen.get("nightly:missed") == today.isoformat()` (already alerted today).
     - Return `[]` when `datetime.datetime.now(SGT).hour < NIGHTLY_HOUR` (before 07:00 SGT).
     - Open `$HERMES_HOME/state.db` read-only (`sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=10)`, new module constant `STATE_DB = os.path.join(HOME, "state.db")`, same `HOME` as line 57). A missing state.db raises, so `main()`'s existing wrapper (line 331) emits the once-per-day `ALERT: source nightly failed:` line instead of silently reporting a missed nightly when Hermes itself is down. Never return `[]` for an unreadable database.
     - Query sessions whose start is at or after 02:00 SGT today, compared as epoch seconds against `messages.timestamp`: `int(datetime.datetime.combine(today, datetime.time(NIGHTLY_SINCE_HOUR), SGT).timestamp())`. (`messages.timestamp` is epoch seconds — `adapter.py` `_spread` buckets `timestamp / 3600` against `time.time() // 3600` — so the threshold must be seconds, not milliseconds, or every session reads as starting before 02:00 and the alert fires on mornings the nightly ran.) Session start is min(`messages.timestamp`) per session, or the sessions-table created column when verification step 1 finds one. For each such session take its earliest message; if its text, after stripping leading whitespace, starts with `NIGHTLY_MARKER`, the nightly reached Friday — return `[]`.
     - Otherwise return `[("nightly:missed", "ALERT: The nightly maintenance run did not reach Friday today")]`. Exact text, per the issue.
   - Register it in `SOURCES` (line 301), after `"patch"`: `"nightly": nightly_source`. Dict order is the section order in the printed data block.
   - ponytail: no new file, no helper module, no config key, no schedule edit. The 08:00 tick is the first that can fire; adding a 07:00 tick would buy one hour for a tick that prints nothing on every normal morning.
2. `modules/tests/test_issue_280.py` — new unittest module, same shape as `modules/tests/test_proactive_tick_notepad.py`: load the script with `importlib.util.spec_from_file_location`, patch the module-level `STATE_DB` path with `mock.patch.object`, build throwaway state.db fixtures with the schema verification step 1 recorded. Test ids (see Tests below).

## Tests

New `modules/tests/test_issue_280.py`, class `TestNightlyMissed`, run from `modules/` as `python3 -m unittest tests.test_issue_280 -v`. RED control: the tests fail at base (no `nightly_source`) and pass at HEAD. Fixture state.db files use the host-verified schema with second-unit `messages.timestamp` values; the fixture builder is written after verification step 1, not before.

- `test_marker_session_after_0200_is_silent`: a session started 03:00 SGT today whose first message starts with "Nightly maintenance", tick at 08:00 → `[]`.
- `test_no_session_after_0200_alerts_once`: no session since 02:00, tick at 08:00 → exactly one item, key `nightly:missed`, text `ALERT: The nightly maintenance run did not reach Friday today`; a second call the same day with that key seen → `[]`.
- `test_before_0700_is_silent`: no session since 02:00, tick at 06:00 → `[]`.
- `test_yesterdays_session_does_not_count`: a marker session started 03:00 SGT yesterday only, tick at 08:00 today → the ALERT item.
- `test_unmarked_session_after_0200_alerts`: a session started 03:00 SGT today whose first message does not start with the marker (other API traffic) → the ALERT item.
- `test_first_message_only`: a session started 03:00 SGT today whose first message lacks the marker but a later message contains it → the ALERT item (the check reads the first message, not any message).
- `test_missing_state_db_raises`: `STATE_DB` path absent → the source raises (so `main()` reports it as the once-per-day source-failure ALERT rather than silently alerting or staying silent).

## Verification

1. Before implementing, on the host (production inspection needs Darren's approval first, per repo `AGENTS.md`): record the exact `sessions`/`messages` schema from the deployed Hermes image — the messages-table text and role/type columns, the `messages.timestamp` unit (epoch seconds), any sessions-table created column, and the `source`/`created_source` value of an API-server session (check one made by the nightly's last successful run). Record the nightly prompt's literal first-call text and the nightly's scheduled time. Stop and re-review if: the messages table carries no first-message text AND the session JSONL transcript has no usable first user line; the marker literal differs from "Nightly maintenance" (change the constant and re-review); or the nightly can legitimately run after 07:00 (move the threshold and re-review).
2. `python3 -m unittest tests.test_issue_280 -v` (from `modules/`): all pass at HEAD; the RED control fails at base.
3. Full suite `python3 -m unittest discover -s modules/tests -p 'test_*.py'` from the repo root (CI command, `.github/workflows/test.yml:148`): green.
4. Code review round (fresh reviewer, driver contract report), then push branch `fix/issue-280-nightly-missed-alert` via the GitHub App, open the PR, request Darren's review (`darrencjh8` as requested reviewer), verify CI green via the App Checks read. No merge by the agent. Ship only through the normal merge-triggered CI/CD deployment; no manual prod edits or restarts. The seed reconciles nothing for this change — the script ships at deploy.
5. Live check after deploy: on a morning the nightly ran, the 08:00 tick output carries no nightly section. The alert path itself is proven by the unit test, not forced live — a missed nightly cannot be staged without skipping the real run.

## Out of scope

- Changing the proactive-tick schedule to add a 07:00 tick, or the seeded prompt. The prompt already relays `ALERT:` lines; the 08:00 tick is the first that can fire.
- Any other nightly-health signal (scheduler logs, bridge status, host checks). The issue asks only for the missed-run alert from the session record.
- Backfill: no alert for nights before this ships; the first morning after deploy is the first check.
- Retrying or re-running the nightly when it is missed. This change only alerts; Darren decides what to do.
- Secrets: none involved; the script reads only local Hermes state and prints one line.
