QUESTIONS
q: Scope? | a: Visual refresh only — PAGE CSS + tiny DOM tweaks inside the existing structure; every route, API shape, auth path, and JS flow is frozen. Approved direction A (no tabs, no layout restructuring).
q: How is typography/spacing handled? | a: One CSS scale: font sizes via rems on existing elements, consistent card padding (18→16/18 grid kept), larger h1 with letter-spacing tuning. No new fonts — system stack stays (zero fetches).
q: Chips summary? | a: The meta line becomes a flex row of chips: counts for created/skipped/pending (+problems chip in the error color when nonzero), with the run date as a small muted caption chip. Data source unchanged (same snapshot fields). When no snapshot: keep today's "No snapshot yet" line.
q: Buttons/inputs? | a: Accent-blue primary button style for Add (and a quiet bordered style for Remove), consistent border-radius, focus-visible ring, disabled state. No icons.
q: Pills? | a: Filled-tint variant (color background at low alpha, dark text of the same hue) replacing the current outline pills; status text unchanged; created/skipped green, pending amber, overdue-manual/conflict/unclassified red.
q: Section headers / counts? | a: h4 stays but gets an accent underline; count stays in the existing h-count-* spans styled as a rounded pill.
q: Empty states? | a: Same text, calmer style (muted, dashed border box) — still driven by the existing habit-empty-* hidden flags. No JS flow changes.
q: Cards? | a: Softer 1px borders + subtle shadow + larger radius; hover lift dropped (scroll-heavy read page; lift adds nothing).
q: Theme risk? | a: Both themes verified by re-reading var usage; chips/pills use color-mix or explicit tint vars per theme so dark mode keeps contrast. body.light/body.dark overrides untouched.
q: Testability? | a: JS/CSS visual properties are not unit-testable; the suite keeps its existing static hooks green and adds two: a chip-hook id assertion + a no-inline-style regression on the new button classes (calls it class-based, keeps hook test honest). All existing behavior tests (server API/auth) untouched and green.

## Change surface

- `modules/hermes/scripts/reminders-server.py` PAGE only:
  - `<style>` rewrite of the visual layer: type scale, card shadow/radius, chip row, pill tint variant, button/input classes, focus-visible rings, section-header accents, empty-state boxes. `.pill` markup keeps its class contract (status names unchanged).
  - Meta line: `<p id="meta">` becomes a chip container — `load()` fills it with span.chip elements (textContent only); date caption inside the same line. No other JS edits.
  - Button: `#h-add` gets class `btn-primary`; row Remove buttons get `btn-quiet`; both classes defined once in CSS.
- `modules/tests/test_reminders_server.py`: +2 static assertions (chips hook present and filled via textContent; btn classes referenced in CSS) — both fail at base.

## Test command and scope

- `.venv/bin/python -m unittest modules.tests.test_reminders_server`
- `.venv/bin/python -m unittest discover -s modules/tests -p "test_wiki_reminder*.py"`
- `bash modules/hermes/tests/test-50-seed-defaults.sh`
- `bash modules/hermes/tests/test-docker-compose-env.sh`
- `.venv/bin/python scripts/check-no-pii.py`

## Constraints

- textContent-only rendering (no-innerHTML test keeps covering); no new fetches, no external asset requests, no inline event handlers.
- Tailnet-only auth/wiki rules unchanged; PII scan clean.
- Dark and light themes both keep WCAG-ish contrast (vars per theme; no hard-coded colors outside var definitions).

## RED control

Feature: no repro. Gating test id for the tests gate:
`modules.tests.test_reminders_server.HabitsEditTests.test_chips_and_button_style_hooks`
(static: fails at base — no chip class or btn-primary in PAGE).
