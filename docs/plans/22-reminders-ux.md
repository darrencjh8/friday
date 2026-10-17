QUESTIONS
q: Deliberate scope? | a: Client-side polish only — no server route, auth, or wiki-write changes; the page is the sole surface touched.
q: How is Enter-to-add done? | a: Wrap the add inputs in a real <form id="h-form"> with a submit handler (preventDefault); Enter works on desktop and mobile keyboards.
q: What feedback? | a: habitMsg shows "Added ✓" / "Removed ✓" briefly (success), "Saving…" while a POST is in flight, and errors as today; no toasts, no timer teardown complexity — next action overwrites it.
q: Busy state? | a: Add/Remove buttons set disabled during their POST, restored afterwards (single-threaded server makes fast double-posts possible; this prevents double-add).
q: Token friction? | a: On 401/403 the token <details> gets .open = true and the token input receives focus.
q: Meta line? | a: The "Run …" line moves from between the habits and snapshot cards to directly above the snapshot table, labeled for what it describes.
q: Count badges? | a: Section headers get a <span id="h-count-daily|weekly|monthly"> "(N)" updated by loadHabits.
q: Mobile? | a: One @media (max-width:600px) rule trimming cell padding; no layout rewrite.
q: Testability? | a: JS behavior is not unit-testable in stdlib unittest; the suite pins the hooks statically (form element present, no absolute fetch, feedback strings, count-span ids, media query, meta-below-token ordering).
q: Out of scope? | a: Sorting, editing existing row text, drag reorder, inline when-editing — all cut until asked for.

## Change surface

- `modules/hermes/scripts/reminders-server.py` PAGE only:
  - Add form: inputs + button inside `<form id="h-form">`, submit handler calls the same add flow (button becomes type submit).
  - `habitMsg`: success strings "Added ✓"/"Removed ✓"; editHabits sets "Saving…" and disables its caller button before fetch, re-enables after (buttons tracked via the payload's trigger; add flow disables #h-add).
  - 401/403 path: `document.getElementById("h-token-details").open = true; tokenBox.focus()`.
  - Move `<p class="sub" id="meta">` below the habits card, immediately above the snapshot card; snapshot header row unchanged.
  - Count spans in the three section headers; loadHabits sets their text.
  - `@media (max-width:600px)` padding trim in the existing style block.
  - Rendering stays textContent-only; no new fetch endpoints.
- `modules/tests/test_reminders_server.py`: static PAGE hook tests (form presence, success/busy strings, count ids, media query, meta-after-token ordering); existing suites untouched.

## Test command and scope

- `.venv/bin/python -m unittest modules.tests.test_reminders_server`
- `.venv/bin/python -m unittest discover -s modules/tests -p "test_wiki_reminder*.py"`
- `bash modules/hermes/tests/test-50-seed-defaults.sh`
- `bash modules/hermes/tests/test-docker-compose-env.sh`
- `.venv/bin/python scripts/check-no-pii.py`

## Constraints

- Tailnet-only, token-gated writes, fail-closed unset token — all unchanged.
- textContent-only rendering (no-innerHTML test keeps covering).
- No API shape changes; page/server contract frozen.

## RED control

Feature: no repro. Gating test id for the tests gate:
`modules.tests.test_reminders_server.HabitsEditTests.test_add_form_and_feedback_hooks`
(static: fails at base because PAGE lacks a <form element and the success strings).
