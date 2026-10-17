QUESTIONS
q: What is wrong on mobile today? | a: Two things, both from the #24 batch: (1) the fixed type scale (16px body/fields, 14px tables, 12px pills) reads a notch too big on a phone, and (2) `#h-form` wraps by min-width, so on ~412px viewports the When placeholder truncates and Add strands on its own short row.
q: What changes for text sizes? | a: Inside the existing `@media (max-width:600px)` block only: body 15px/1.45, table 13px, h1 1.35rem, card-title 1rem, hint/note 12.5px, empty 13.5px, tab 14px with 5px/12px padding, chip/pill 11px, btn-quiet 12px, topbar padding 10px 12px, card padding 16px (kept), th/td padding 4px (kept). `.field` (inputs/selects) stays 16px everywhere — the iOS focus-zoom guard is non-negotiable; buttons may go smaller because focus on a button never zooms.
q: What changes for the form? | a: Same media block: `#h-form input, #h-form select, #h-form button {flex:1 1 100%}` so each control is its own full-width row — nothing truncates, Add is a comfortable target. Desktop untouched.
q: Also the snapshot table? | a: On mobile only, the snapshot table's Type column hides (`table.snapshot th:nth-child(2), td:nth-child(2) {display:none}`; the table gets `class="snapshot"`). Reminder/Due/Status are what a phone reader acts on. Habit tables are not touched (monthly rows need their When column).
q: How does edit work server-side? | a: New branch in the POST handler: `action:"edit"` with `{section, key, title, note, when}`. Same auth, BAD_CHARS validation (`_validate_text`), section check, and daily semantics as add (`when` forced to "today" for daily; required for weekly/monthly). Implementation: `edit_habit(section, key, title, note, when)` reads lines, locates the row whose `` `key` `` cell matches, validates the new data, derives the new key from the new title (`derive_key`, which also rejects an empty slug), and rewrites that row in place with the same `| key | title | when | section | note |` shape — position preserved, no insert/delete. New key collision with another row in the same section → ValueError → 400 ("habit already exists"), same message as add. Unknown key → KeyError → 404 (existing handler). Reuses `_read_lines`/`_table_rows`/`_row_cells`/`_row_key`/`_write_lines`.
q: Why rewrite in place instead of remove+add? | a: Keeps the row's position, never loses a malformed neighbor row, and is one write.
q: What does the page do? | a: Each habit row gains an Edit (btn-quiet) button next to Remove. Edit click: fills `#h-title`, `#h-when`, `#h-note` with the row's values (textContent-safe via `.value`), sets `form.dataset.editingKey`/`editingSection`, syncs the section select via `switchTab(section)` (already two-sided), swaps Add's label to "Save", shows the `#h-cancel` chip button. Submit builds `{action:"edit", ...key}` when editing, else `{action:"add"}`; on success the editing state clears and the label returns to "Add". `#h-cancel` clears state + labels + fields without POSTing. Existing Saved…/Added feedback per action ("Saved."). No new fetches, no innerHTML.
q: Waiting spellings? | a: Habit slot line hint gains one clause: "Google Tasks created by earlier runs keep their old title." — the truthful cost of renaming (the existing hint already says tasks are never deleted).
q: Everything else frozen? | a: Routes, auth order (token checked before body read), key derivation, sections, seed prompts, helper, and wiki format are untouched.

## Change surface

- `modules/hermes/scripts/reminders-server.py`:
  - `edit_habit()` next to `add_habit`/`remove_habit`.
  - POST handler: `elif payload.get("action") == "edit": edit_habit(...)`.
  - PAGE `<style>`: mobile media block contents (sizes above) +
    `#h-form` full-width stacking + `.snapshot` column hide.
  - PAGE HTML: `class="snapshot"` on the snapshot table; `#h-cancel`
    chip button (hidden by default, type=button) next to Add.
  - PAGE JS: Edit buttons in habit rows; edit-mode state
    (`form.dataset.editingKey/editingSection`, Save/Cancel labels,
    `Saved.` feedback); submit branch picks add vs edit.
- `modules/tests/test_reminders_server.py`: new methods (below); no
  existing test edits expected.

## Test command and scope

- `.venv/bin/python -m unittest modules.tests.test_reminders_server`
- `.venv/bin/python -m unittest discover -s modules/tests -p "test_wiki_reminder*.py"`
- `bash modules/hermes/tests/test-50-seed-defaults.sh`
- `bash modules/hermes/tests/test-docker-compose-env.sh`
- `.venv/bin/python scripts/check-no-pii.py`

New tests, both red at base:
- `HabitsEditTests.test_edit_action_updates_row_in_place` (server,
  HTTP): add a daily habit, POST edit changing title+note, GET shows
  the new key/title in the same list position with the same section;
  POST edit missing-token returns 401.
- `HabitsEditTests.test_edit_validation` (server): unknown key → 404;
  weekly edit without when → 400; title with `|` → 400; duplicate
  title (key collision) → 400. Plus a static hook method:
- `HabitsEditTests.test_edit_ui_and_mobile_scale_hooks` (static):
  asserts `editing_key` wiring (`dataset.editingKey`), `#h-cancel`,
  `Saved.`, the mobile `font:15px` body override inside the media
  block, `flex:1 1 100%` form stacking, and `.btn-edit` absent-or-equal
  guard not needed — Edit uses btn-quiet (assert `"Edit"` handler wired
  via `btn.type`+textContent pattern existing in loadHabits).

## Constraints

- textContent-only rendering (no innerHTML) — unchanged, still tested.
- Inputs/selects/buttons-that-focus≥16px rule: `.field` stays 16px.
- Token auth flow unchanged (401/403 order, isascii guard, hmac compare).
- BAD_CHARS validation shared via `_validate_text` for edit fields.
- Row write shape identical to add: `| `key` | title | when | section | note |`.
- PII scan stays clean; no new fetch/origin in page JS.

## RED control

Feature: no repro. Gating test id for the tests gate:
`modules.tests.test_reminders_server.HabitsEditTests.test_edit_action_updates_row_in_place`
(fails at base: `action:"edit"` currently returns 400 unknown action).