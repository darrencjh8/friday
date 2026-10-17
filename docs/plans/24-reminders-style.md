QUESTIONS
q: Scope? | a: Visual refresh plus small layout work approved mid-review: direction A (chips, tinted pills, accent buttons/inputs, card/type polish, empty states) expanded with B (tab bar for Daily/Weekly/Monthly inside the habits card, pending/done visual separation in the snapshot table, sticky header). Every route, API shape, auth path, and JS data flow is frozen; JS gains only tab switching and row-class placement logic.
q: How are tabs done? | a: One visible section at a time inside the habits card: a flex tab bar with the three sections and their pill counts; a `data-tab` button sets `hidden` on the other two block groups and switches the add form's section select to match (so the form's always right). All rendering stays textContent; no persistence beyond the existing localStorage pattern? A: no — tab choice is session-only, no localStorage (a themed page remembers not needed; avoids a third stored key).
q: Pending/done separation in the snapshot table? | a: Snapshot rows labelled `pending` (includes overdue-manual + conflict-ish "not created" rows? No — strictly `pending` pill class) get top placement and an accent left border; created/skipped rows stay below in muted styling. Order comes server-side already (items array order preserved); JS only applies classes and two grouping headers via textContent rows.
q: Sticky header? | a: The existing page header becomes `position:sticky;top:0` on the scroll container with the theme select, small blur backdrop; max-width:960px wrapper unchanged.
q: Typography/spacing? | a: One CSS scale: rem sizes, cards 18px padding desktop / 16px mobile, h1 letter-spacing tuned. System font stack stays — zero external fetches.
q: Chips summary? | a: Meta line becomes a chip row: created/skipped/pending counts + problems chip in the error color when nonzero, run date as muted caption chip. Data source unchanged. When no snapshot: the existing "No snapshot yet" line stays.
q: Buttons/inputs? | a: Accent primary Add button, quiet bordered Remove, focus-visible rings, disabled state. Inputs/buttons/selects stay >= 16px-equivalent under the new scale (iOS focus-zoom guard).
q: Pills? | a: Filled-tint variant via explicit per-theme tint vars (--*-soft in the four existing var blocks; no color-mix anywhere — older mobile would silently drop it). Status names unchanged.
q: Theme risk? | a: Both themes re-verified by var usage reading; body.light/body.dark override layers untouched.
q: Testability? | a: JS/CSS behavior not unit-testable in stdlib; static hook tests only: chips hook + tab-bar hooks present and wired to hidden attributes, btn classes in CSS, tabs use hidden attribute via textContent-detectable data-tab wiring, and a no-color-mix static guard (forbid color-mix in PAGE) that fails the M1 regression. Existing hooks stay green.

## Change surface

- `modules/hermes/scripts/reminders-server.py` PAGE only:
  - `<style>` rewrite: type scale, card shadow/radius, chip row, tint pills via --*-soft vars, button/input classes, focus rings, accent section headers, dashed empty states, sticky header, tab bar, pending-row accent border.
  - Habits card: tab bar (three buttons with counts) + three wrappers `data-section="daily|weekly|monthly"`; `switchTab()` toggles hidden; tab click also syncs the add form's section select.
  - Meta line → chip container; `load()` fills with textContent spans; unchanged snapshot payload.
  - Snapshot rows: load() applies `RS+pill-derived class` to group pending-like rows first (server order) and renders two caption rows ("Needs attention" / "Done") via textContent.
  - No route/auth/wiki/API changes; no innerHTML; no color-mix.
- `modules/tests/test_reminders_server.py`: +2 static assertions (tab/chip hooks + no-color-mix guard) — both fail at base.

## Test command and scope

- `.venv/bin/python -m unittest modules.tests.test_reminders_server`
- `.venv/bin/python -m unittest discover -s modules/tests -p "test_wiki_reminder*.py"`
- `bash modules/hermes/tests/test-50-seed-defaults.sh`
- `bash modules/hermes/tests/test-docker-compose-env.sh`
- `.venv/bin/python scripts/check-no-pii.py`

## Constraints

- textContent-only rendering (no-innerHTML test keeps covering); no new fetches, no external assets.
- Tailnet-only auth/wiki rules unchanged; PII scan clean.
- Dark and light themes keep contrast via explicit per-theme vars; sticky header fully readable in both.

## RED control

Feature: no repro. Gating test id for the tests gate:
`modules.tests.test_reminders_server.HabitsEditTests.test_chips_and_button_style_hooks`
(static: fails at base — no chip class, no tab bar, no btn-primary in PAGE).
