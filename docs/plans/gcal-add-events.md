# Friday adds calendar events from mail

## Why

The nightly maintenance run (a Claude scheduled task) read the user's mail every night only to put dated items in the calendar. Friday's hourly `proactive-tick` already reads the same mail and tracks to-dos, so the calendar step moves to her and the nightly drops its personal-admin work.

## Change

- `google login` asks for one more scope, `https://www.googleapis.com/auth/calendar.app.created` ("Make secondary Google calendars, and see, create, change, and delete events on them", per the [Calendar API scope list](https://developers.google.com/calendar/api/auth)). Google limits it to calendars the app created, so the token cannot change the user's own calendars or events. Login still refuses a token with anything broader (including `calendar.events` and `calendar.events.owned`).
- `gcal add` inserts one event on a secondary calendar named "Friday":
  - the CLI creates that calendar on first use (summary "Friday" plus a marker description), saves its id next to the token, and finds it again by the marker if the saved id is lost;
  - timed (`--start`/`--end` with `--tz`) or all-day (`--date`), optional location, description and one popup reminder;
  - `--source gmail:<id>` is required and stored as a private extended property, so the same message never makes a second event; an event with the same title starting within a day on the primary or Friday calendar also counts as existing;
  - mail is untrusted, so links are stripped from the title, location and description, and the description always starts with "Added by Friday from email (gmail:<id>)";
  - no attendees, `sendUpdates=none`; there is still no update, move, accept or delete command.
- `proactive-tick` step 5 adds events for dated mail (appointments, bookings, flights, due dates), at most 5 per tick, reports each added event with its link (outside the 5-item message cap), and proposes rather than adds anything unclear.
- `gcal-readonly` keeps its name (cron jobs and pins refer to it); its text now covers `add`.

## Trade-off

Events live on the "Friday" calendar, not the primary one. They show beside the user's own events, can be hidden or recoloured as one calendar, and keep their own reminders. In exchange Google, not just the CLI and the prompt, prevents any change to the user's own events, which matters because the agent reads untrusted mail.

## Rollout

After deploy, the user runs `google login` once and ticks the new calendar box. Until then `gcal add` exits with the missing-scope message and the tick reports `[CRON_FAILURE]`, so the gap is visible.

## Tests

- `modules/tests/test_gcal_add.py`: calendar created once and reused or found by its marker; request shape (Friday calendar, `sendUpdates=none`, no attendees, nothing on primary); all-day with reminder; links stripped; idempotency by source and by title, with the ±1 day window; missing scope makes no request; bad input makes no request; no edit/delete commands; login scope set and refusal of broader calendar scopes.
- `modules/tests/test_gmail_readonly.py`: login scope set updated; gmail still never POSTs, gcal has exactly one POST helper.
- `modules/hermes/tests/test-50-seed-defaults.sh`: the seeded `proactive-tick` prompt uses `gcal add` with a source, no invites and no edits.
