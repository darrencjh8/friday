# Friday calendar: delete, cross-calendar duplicates, daily Notion dates

## Why

- Friday could add events but not undo a wrong one.
- The duplicate check matched only identical titles on the primary and Friday calendars, so "Call Mum for her birthday" would duplicate an existing "Mum's Birthday".
- Account action dates in the Notion Accounts data source reached reminders only after the weekly wiki refresh.
- Review follow-ups from #118: a deleted Friday calendar broke every add; bare `domain.tld/path` links were not stripped.

## Change

- `gcal delete --id <id>`: deletes one event from the Friday calendar only, and only one that carries Friday's source mark; `sendUpdates=none`. The token (`calendar.app.created`) cannot touch other calendars anyway.
- `gcal add` duplicate check reads every calendar in the user's list (calendar.readonly) for ±1 day: an identical title is `exists`; similar key words (most key words of the shorter title shared) is `possible_duplicate` with the matches, and nothing is added unless `--confirm-new`.
- A 404 on the cached Friday calendar clears the cache and finds or creates it once more.
- Link stripping also removes bare `domain.tld/path` forms.
- `wiki-source-snapshot.py --only <source>`; `notion-accounts-snapshot.py` runs it for `notion-accounts` as the pre-run script of `wiki-due-reminders`, whose prompt now reads that snapshot's action dates (Notion wins over a lagging wiki page, and the difference is reported).
- `proactive-tick` asks the user about a `possible_duplicate` and adds with `--confirm-new` only after a yes.

## Tests

- `modules/tests/test_gcal_add.py`: delete on Friday calendar only (refuses ids elsewhere, hand-added events, path tricks); possible duplicate on another calendar and `--confirm-new`; unrelated same-day event does not block; deleted Friday calendar recreated once; bare links stripped.
- `modules/tests/test_wiki_source_snapshot.py`: `--only` captures one source, unknown source rejected, wrapper runs notion-accounts only.
- `modules/hermes/tests/test-50-seed-defaults.sh`: wiki-due-reminders has the Notion pre-run script and prompt step; proactive-tick handles `possible_duplicate`.
