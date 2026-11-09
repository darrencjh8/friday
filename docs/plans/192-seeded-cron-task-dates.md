QUESTIONS
q: For wiki-due-reminders, keep its action_date as the task date, or apply the literal creation-date rule? | a: Keep action_date. Its helper already passes `-d <action_date>` on every task it creates, so every task is dated and shows in the calendar; replacing that with the creation date would destroy the reminder semantics (a task due in 60 days would show as due today). The issue's intent is "every created task is dated", which this job already satisfies. Flagged as a decision for Darren in the handover.
q: When the email states a date, use the email's date or always the creation date? | a: The email's date wins when one is stated (preserves existing behaviour for dated items); otherwise use the creation date. The creation date is the default, not a replacement for a real due date.
q: Should the gtasks-cli skill's "-d only for a user-confirmed date" line change too? | a: No — out of scope. It governs the interactive ask-first flow. No seeded job's creation path goes through it: proactive-tick's MANAGED block lists no skills, and wiki-due-reminders routes creation through its helper, which always dates.
q: Does the cron runner attach any default skills beyond a job's own skills list, which would make gtasks-cli govern proactive-tick after all? | assumption: No. Evidence: wiki-due-reminders explicitly lists gtasks-cli in its MANAGED skills (seed line 1683), the seed's skill-pin block reads only job.get("skills") (seed line 1888), and modules/hermes/config.yaml's skills section carries no default-skills setting (only guard_agent_created). Verification step 4 (below) re-checks this before implementation; if it finds otherwise, the skill line gets the same wording change and the plan is re-reviewed.
q: Where does the creation date come from, and in which timezone? | a: From the data block itself. scripts/proactive-tick.py computes today as datetime.now(SGT) (SGT = UTC+8, line 54/255) and prints "Today: <YYYY-MM-DD>" as the first line of the data block the agent receives, so the agent already sees today's Asia/Singapore date; the prompt tells it to use that date.

## Goal

Every task a seeded cron job creates carries a due date (`-d YYYY-MM-DD`), so it shows in the calendar. The dated default is the creation date (Asia/Singapore); a real due date stated by the source wins over the default.

## Evidence

Root cause, proven (proactive-tick is the reported case):

1. `modules/hermes/scripts/gtasks.py`, `cmd_tasks` "add" (lines 567-577): `dates = [args.due] if args.due else [None]`; `if due: body["due"] = _to_due(due)`. Without `-d`, the POST body omits `due`, so Google Tasks stores the task with no due date, and undated tasks do not appear in the calendar. The CLI is a faithful pass-through; nothing defaults the date.
2. The only instruction deciding whether the agent passes `-d` for proactive-tick is the seeded prompt, `modules/hermes/50-seed-defaults` line 1762, step 4: "`gtasks tasks add -l "Friday" -t "<short title>" -n "gmail:<id> <one-line context>"`, with `-d YYYY-MM-DD` only when the email states the date." Most mail to-dos state no date, so the agent creates them with no `-d`. That conditional is the root cause.
3. The `gtasks-cli` skill (`modules/hermes/skills/gtasks-cli/SKILL.md:21`) also says `-d` only for a user-confirmed date, but it does not govern proactive-tick: the job's MANAGED block (seed lines 1776-1782) lists no `skills`, and only wiki-due-reminders lists `gtasks-cli` (seed line 1683). The seeded prompt is the single control point for proactive-tick.
4. The creation date is already available to the agent: `modules/hermes/scripts/proactive-tick.py` line 54 defines `SGT = UTC+8`, line 255 computes `today = datetime.now(SGT).date()`, and the script prints `Today: <today>` as the first line of the data block. No new date plumbing is needed.

All seeded jobs that create tasks (all 15 seeded jobs enumerated from `50-seed-defaults`: 13 named jobs plus 2 `no_agent` script jobs seeded by the SEEDS loop at seed lines 1047-1050, `notion-monthly-bills-reset` and `actual-backup`):

- `proactive-tick` — creates via the prompt's `gtasks tasks add` (undated unless the email states a date). NEEDS THE FIX.
- `wiki-due-reminders` — creates via `modules/hermes/scripts/wiki-reminder-tasks.py`; `create_task` always passes `-d <action_date>` (lines 132-135, called at line 267 with `action_date`). Already dated; keep its action_date semantics (see QUESTIONS).
- The other 13 (`ops-github-token-refresh`, `memory-backup`, `memory-mnemosyne-vacuum`, `finance-portfolio-sync`, `gtasks-clear-completed`, `ops-log-issues`, `memory-compact`, `memory-approve-queue`, `wiki-finance-refresh`, `wiki-repo-docs`, `skills-merge-proposals`, `notion-monthly-bills-reset`, `actual-backup`) create no tasks: no `gtasks tasks add` in their seeded prompts, and no task-creating code in their scripts (`gcal.py`/`gmail.py`/`google_login.py` reference gtasks only for auth/events; `gtasks-clear-completed.py` only completes/deletes; the two SEEDS-loop scripts contain no gtasks call at all). Verified by grep over the seed file and `modules/hermes/scripts/`.

## Changes

One file, one prompt step (`modules/hermes/50-seed-defaults`, proactive-tick PROMPT step 4, line 1762). No code, no workflow file, no skill, no schedule, no delivery change.

Old (line 1762, step 4, relevant clause):
`gtasks tasks add -l "Friday" -t "<short title>" -n "gmail:<id> <one-line context>"`, with `-d YYYY-MM-DD` only when the email states the date.

New:
`gtasks tasks add -l "Friday" -t "<short title>" -n "gmail:<id> <one-line context>" -d <date>`. Always include `-d`: a specific calendar date the email states for the to-do itself wins when there is one (convert relative dates such as "tomorrow" or "next week" against the `Today:` date); otherwise use the `Today:` date at the top of the data block (today, Asia/Singapore).

The rest of step 4 (create the list once if missing; complete done tasks) is unchanged. `MANAGED` is reconciled in place on every boot (docs/glossary.md:187), so existing installs pick the new prompt up on the next boot; no data migration and no backfill of already-created undated tasks (out of scope — the issue asks for dating on creation, not retroactive dating).

No `.github/workflows/*` file is touched, so the GitHub App can push the branch and open the PR (no patch-comment handover needed).

## Tests

Repro test (already written, fails at base, recorded): `modules/tests/test_issue_192.py`, id `tests.test_issue_192.TestIssue192.test_proactive_tick_dates_every_created_task`. It runs the proactive-tick seeding block from `50-seed-defaults` against a throwaway jobs file (same extract-and-run pattern as `test_hermes_seed_allowlists.py` / `test_cron_skill_protection.py`) and asserts, within the seeded prompt's Track step itself, that the `gtasks tasks add` command carries `-d <date>`, that the old "only when the email states the date" restriction is gone, and that the Track step names the `Today:` date as the fallback. At base it fails on the `assertNotIn("only when the email states the date")` check.

Guard test (same file, passes at base and HEAD): `test_wiki_due_reminders_helper_always_dates_tasks`. Runs `wiki-reminder-tasks.py` against a fake `gtasks` on PATH and asserts the `tasks add` call carries `-d <action_date>`. Pins the already-dated path so it cannot silently regress.

Full suite command (as CI runs it): `python3 -m unittest discover -s modules/tests -p 'test_*.py'` from the repo root (CI uses `python`; this VM has `python3` only). The implementation run also re-runs the focused file from `modules/`: `python3 -m unittest tests.test_issue_192 -v`.

## Verification

1. `python3 -m unittest tests.test_issue_192 -v` (from `modules/`): repro passes at HEAD, guard passes.
2. Full suite `python3 -m unittest discover -s modules/tests -p 'test_*.py'`: green.
3. Code review round (fresh reviewer, driver contract report), then push branch `fix/issue-192-seeded-cron-task-dates` via the GitHub App, open the PR, request Darren's review (`darrencjh8` as requested reviewer), verify CI green via the App Checks read. No merge by the agent. Ship only through the normal merge-triggered CI/CD deployment; no manual prod edits or restarts.
4. Before implementing, re-check the Q4 assumption and record the result in the implementation report: (a) the seed skill-pin block reads only `job.get("skills")` (seed line 1888); (b) `modules/hermes/config.yaml`'s `skills` section carries no default-skills setting (only `guard_agent_created`); (c) the `gtasks-cli` skill's own "Friday's own list" section describes proactive-tick creating Friday-list tasks from new mail via its prompt. If any of these shows `gtasks-cli` attached to proactive-tick runs, the skill wording change enters scope and this plan is re-reviewed before implementation proceeds.

## Out of scope

- `gtasks-cli` SKILL.md line 21 (interactive ask-first flow; see QUESTIONS).
- `wiki-due-reminders` action_date semantics (already dated; see QUESTIONS).
- Backfilling due dates onto already-created undated tasks.
- Prompt wording elsewhere, schedules, delivery, or any other seeded job.
- Secrets: none involved; no credential is read, printed, or changed.

## Appendix: scan item list (2026-11-09, verified both sides)

- Seeded jobs enumerated: 15 (13 named jobs at seed lines 604, 799, 855, 969, 1010, 1162, 1286, 1440, 1538, 1625, 1702, 1797, 1855, plus 2 `no_agent` script jobs from the SEEDS loop at seed lines 1047-1050: `notion-monthly-bills-reset`, `actual-backup`).
- Task-creating paths found: 2 (proactive-tick prompt, wiki-due-reminders helper). All other jobs verified to create no tasks by grep over seed prompts and `modules/hermes/scripts/`.
- `gtasks tasks add` occurrences in `50-seed-defaults`: 1 (line 1762, proactive-tick).
- `gtasks-cli` in a job's skills: 1 job (wiki-due-reminders, line 1683). proactive-tick MANAGED has no `skills` key.
