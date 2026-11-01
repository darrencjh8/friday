QUESTIONS
q: Should completed tasks be deleted or only hidden? | a: Deleted; the operator asked for it on 2026-11-01 after the hidden tasks still showed.
q: Which completed tasks must survive? | a: Completed wiki reminders whose marker date is today or later, and completed parents with an open subtask.
q: Does the Tasks API delete a parent's subtasks with it? | assumption: It may, so a completed parent with any open subtask is kept rather than risk deleting open work.
END QUESTIONS

# Delete completed Google Tasks monthly (#129)

## Problem

`modules/hermes/scripts/gtasks-clear-completed.py` calls the Tasks API `clear`
method on every list. `clear` only sets `hidden` on completed tasks. The
1 Nov 2026 run succeeded, yet 31 hidden completed tasks remain, and the
operator still sees completed tasks. The docstring's claim that `clear`
matches "Delete all completed" is wrong.

## Constraint

`modules/hermes/scripts/wiki-reminder-tasks.py` reads `Planned` with
completed tasks included and skips a candidate whose
`wiki-reminder-marker:<key>:<date>` line already exists. It creates a task
while `0 <= action_date - today <= lead_days`. A completed reminder whose
marker date is today or later is therefore still a live dedup record:
deleting it lets the next daily run create the reminder again. A marker
date before today can never be created again, so it is safe to delete.

## Change

1. `gtasks-clear-completed.py`: for each list (paged as now), read its tasks
   with `gtasks._ordered_tasks(list_id, include_completed=True)` (completed
   and hidden, paged), and `DELETE` each completed task unless:
   - a marker line dates it today or later, or its date does not parse
     (kept: never risk a duplicate reminder), or
   - an open task names it as `parent`.
   Then call `clear` as before, so the kept tasks stay hidden. `main()`
   takes an optional `today` for tests. Any API error still exits non-zero.
2. `modules/hermes/skills/gtasks-cli/SKILL.md`: the job deletes completed
   tasks, keeping the reminder dedup records.
3. Tests: new `modules/tests/test_gtasks_delete_completed.py` (deletion,
   kept reminders, kept parent). Update `test_clears_every_list_across_pages`
   in `modules/tests/test_gtasks_clear_completed.py`, which asserts only
   GET and POST calls.

No seed or schedule change: the job, its name and its 1st-of-month 07:00
schedule stay. CI already runs `modules/tests` by discovery.

## Verification

- RED: `python -m unittest modules/tests/test_gtasks_delete_completed.py`
  fails at base (`main()` takes no `today`, nothing is deleted).
- GREEN at HEAD, plus `python -m unittest discover -s modules/tests -p 'test_*.py'`.
- After deploy, the next run is 1 Dec 2026; a manual `hermes cron run` is
  the operator's choice, not part of this change.
