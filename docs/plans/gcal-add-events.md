# Friday adds calendar events from mail

## Why

The nightly maintenance run (a Claude scheduled task) read Darren's mail every night only to put dated items in his calendar. Friday's hourly `proactive-tick` already reads the same mail and tracks to-dos, so the calendar step moves to her and the nightly drops its personal-admin work.

## Change

- `google login` asks for one more scope, `https://www.googleapis.com/auth/calendar.events.owned` ("See, create, change, and delete events on Google calendars you own", per the [Calendar API scope list](https://developers.google.com/calendar/api/auth)). It is narrower than `calendar.events`, which also reaches calendars only shared with Darren. Login still refuses a token with anything broader.
- `gcal add` inserts one event on the primary calendar:
  - timed (`--start`/`--end` with `--tz`) or all-day (`--date`), optional location, description and one popup reminder;
  - `--source gmail:<id>` is required and stored as a private extended property, so the same message never makes a second event; an event with the same title starting within a day also counts as existing;
  - no attendees, `sendUpdates=none`; there is still no update, move, accept or delete command.
- `proactive-tick` step 5 adds events for dated mail (appointments, bookings, flights, due dates), reports each added event with its link, and proposes rather than adds anything unclear.
- `gcal-readonly` keeps its name (cron jobs and pins refer to it); its text now covers `add`.

## Rollout

After deploy, Darren runs `google login` once and ticks the new calendar box. Until then `gcal add` exits with the missing-scope message and the tick reports `[CRON_FAILURE]`, so the gap is visible.

## Tests

- `modules/tests/test_gcal_add.py`: request shape (primary calendar, `sendUpdates=none`, no attendees), all-day with reminder, idempotency by source and by title, missing scope makes no request, bad input makes no request, no edit/delete commands, login scope set.
- `modules/tests/test_gmail_readonly.py`: login scope set updated; gmail still never POSTs, gcal has exactly one POST.
- `modules/hermes/tests/test-50-seed-defaults.sh`: the seeded `proactive-tick` prompt uses `gcal add` with a source, no invites and no edits.
