QUESTIONS
q: Scope? | a: Visual refresh plus small layout work approved mid-review: direction A (chips, tinted pills, accent buttons/inputs, card/type polish, empty states) expanded with B (tab bar for Daily/Weekly/Monthly inside the habits card, pending/done visual separation in the snapshot table, sticky header). Every route, API shape, auth path, and JS data flow is frozen; JS gains only tab switching and row-class placement logic.
q: How are tabs done? | a: One visible section at a time inside the habits card: a flex tab bar with the three sections and their pill counts; `switchTab(name)` toggles `hidden` on the three `data-section` wrappers and sets the add form's section select to match. Both sync directions are explicit: a tab click sets `sectionSel.value` AND `whenBox.hidden = sectionSel.value === "daily"` directly (programmatic value sets do not fire the change listener); a manual `h-section` change calls `switchTab(sectionSel.value)` so tab bar and form can never disagree. Pereira: tab choice is session-only — no new localStorage key.
q: Pending/done separation in the snapshot table? | a: `load()` partitions `items` into two append passes keyed on the pill prefix of `status` ("Needs attention": pending, overdue-manual, conflict, create-failed, unclassified; "Done": created, skipped), pending group first, within-group server order preserved. Caption rows are rendered per group only when that group is non-empty (textContent); when both groups are empty nothing is rendered and the existing "No snapshot yet" path already covers items:[] (list falls through to the dashed empty-state paragraph).
q: Sticky header? | a: The existing page header becomes `position:sticky;top:0` with an opaque per-theme background var (`--card`; blur backdrop-filter layered after as pure enhancement so old-mobile without backdrop-filter still gets an opaque bar) — same old-browser discipline as the tint vars. A `[hidden]{display:none!important}` rule is added next to the `*` reset so any display rule on the tab wrappers (this batch styles them) can never defeat the hidden attribute.
q: Typography/spacing? | a: One CSS scale: rem sizes, cards 18px padding desktop / 16px mobile, h1 letter-spacing tuned. System font stack stays — zero external fetches.
q: Chips summary? | a: Meta line becomes a chip row: created/skipped/pending counts + problems chip in the error color when nonzero, run date as muted caption chip. Data source unchanged. When no snapshot: the existing "No snapshot yet" line stays.
q: Buttons/inputs? | a: Accent primary Add button, quiet bordered Remove, focus-visible rings, disabled state. Inputs/buttons/selects stay >= 16px-equivalent under the new scale (iOS focus-zoom guard).
q: Pills? | a: Filled-tint variant via explicit per-theme tint vars (--*-soft in the four existing var blocks; no color-mix anywhere — older mobile would silently drop it). Status names unchanged.
q: Theme risk? | a: Both themes re-verified by var usage reading; body.light/body.dark override layers untouched.
q: Testability? | a: JS/CSS behavior not unit-testable in stdlib; 2 added static test methods, several asserts each: (1) `test_chips_and_button_style_hooks` — chip hook, btn-primary/btn-quiet classes in CSS, no-color-mix guard (forbid color-mix anywhere in PAGE, M1 regression), `[hidden]{display:none!important}` rule pin (M2), caption strings "Needs attention"/"Done" and the three `data-section` values (L2 pins); (2) `test_meta_line_above_snapshot` (existing). Existing hooks stay green.

## Change surface

- `modules/hermes/scripts/reminders-server.py` PAGE only:
  - `<style>` rewrite: type scale, card shadow/radius, chip row, tint pills via --*-soft vars, button/input classes, focus rings, accent section headers, dashed empty states, sticky header (opaque per-theme background var, backdrop-filter only as enhancement), tab bar, pending/done captions + row accent, `[hidden]{display:none!important}` reset rule.
  - Habits card: tab bar (three buttons with per-section count pills) + three wrappers `data-section="daily|weekly|monthly"`; `switchTab(name)` toggles `hidden` on wrappers, sets `sectionSel.value`, and sets `whenBox.hidden` directly; VALUE-CHANGE listener on `h-section` calls `switchTab(sectionSel.value)` so form select and tab bar move together in both directions.
  - Meta line → chip container; `load()` fills with textContent spans; unchanged snapshot payload.
  - Snapshot rows: `load()` partitions items on the pill prefix of `status` into two textContent append passes — "Needs attention" group (pending, overdue-manual, conflict, create-failed, unclassified) first, "Done" group (created, skipped) second, within-group server order preserved — each group headed by a caption row rendered only when that group is non-empty; both groups empty → nothing rendered (falls through to the dashed empty-state paragraph under the table).
  - No route/auth/wiki/API changes; no innerHTML; no color-mix.
- `modules/tests/test_reminders_server.py`: +2 static test methods, several asserts each (chips hook, btn classes in CSS, no-color-mix guard, `[hidden]{display:none!important}` pin, caption strings + three data-section values; meta ordering) — both methods fail at base.

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
