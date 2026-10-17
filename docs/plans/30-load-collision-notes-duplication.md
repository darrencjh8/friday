QUESTIONS
q: What is wrong? | a: The dashboard's Notes card renders the full note list twice (user screenshot on phone; headless Chrome against the live page shows 3 copies). The snapshot API itself has each item once (verified live: 14 items, no duplicate keys or notes).
q: Root cause? | a: PAGE declares `function load(k)` (the localStorage getter, used for the saved edit token and theme) and later `async function load()` (the snapshot loader, called once at page bottom). Function declarations are hoisted and the LAST declaration of the same name wins for the whole script — so the earlier calls `load("reminders-edit-token")` and `load("reminders-theme")` silently invoked the snapshot loader, kicking off extra snapshot fetch+render passes. Each pass clears `#rows` and `#meta` but never clears `#notes`, so the Notes card accumulates one full copy per accidental pass (3 in headless Chrome: two preload call sites + the real one; the user's screenshot shows the same mechanism with 2 completed passes at capture time).
q: What proves that? | a: Deterministic diagnosis — chips render once (`#meta` is cleared per pass; 2-3 passes each end on the same snapshot), `#rows` renders once (cleared per pass), `#notes` renders 2-3 copies (never cleared). Headless-Chrome dump-dom repro at base: `#notes` h4 sequence = 3 identical full lists — matching snapshots — with 1 `<script>` in the document.
q: The fix? | a: Rename the localStorage getter to `getStored(k)` (both call sites: token box preload and theme preload), leaving the snapshot loader as the only `load`. This restores: (1) token box and theme select preload the saved values again (they were receiving the Promise object instead of stored strings, so saved token/theme were silently not preloaded), (2) exactly one snapshot pass per view, (3) no notes duplication.
q: Defence in depth against a future re-render? | a: `load()` clears `#notes` (and hides `#notes-card`) at the top of each pass, mirroring how `#rows`/`#meta` already reset; if a future change re-invokes `load()`, the notes cannot silently accumulate. `#problems` already clears but only inside `if (probs.length)`; minor staleness if problems appear-then-vanish between passes — fix that in the same breath by always clearing and toggling the card hidden (one line, same class of reset).
q: Why not also change the async loader's name? | a: Fewest-file, smallest-diff: two call sites of the small getter are renamed, the big function keeps its name and its single bottom call; behavior of both functions otherwise untouched.
q: Is this state corrupting? | a: No — client-side rendering only; the snapshot file, wiki, and token storage are intact. Pure PAGE JS fix.
q: How is the fix pinned? | a: Static test `HabitsEditTests.test_single_load_declaration_l_one` (already written, RED at base, recorded repro): asserts exactly one `function load(` declaration in the server source and the notes-clear line present. The doubly-declared name is the root cause; the count pin makes the class of bug (shadowed declaration) fail the suite if reintroduced.
q: Behavior after fix — what should a user see? | a: Notes card with each item exactly once; token box and theme select preloaded from localStorage; no other visual change.

## Change surface

- `modules/hermes/scripts/reminders-server.py` (PAGE JS only):
  - `function load(k)` → `function getStored(k)`; update the two call sites (token preload, theme preload).
  - `load()`: at the top of the render section, clear `#notes` + hide `#notes-card` unconditionally (mirrors `#rows` reset), and clear/hide `#problems` unconditionally instead of only when problems exist.
- `modules/tests/test_reminders_server.py`: `test_single_load_declaration_l_one` (already committed RED; stays the gating repro and turns green at HEAD).

## Test command and scope

- `python3 -m unittest modules.tests.test_reminders_server` (stdlib stdlib; 44 tests at base + this one = 45 at HEAD)
- `bash modules/hermes/tests/test-50-seed-defaults.sh` (adjacent surface: seed untouched, must stay 117)
- `.venv/bin/python scripts/check-no-pii.py`
- Behavioral headless-Chrome check against a locally served fixture (evidence only, not a gate): notes h4 count == items with note count (1 pass).

## Constraints

- textContent-only rendering unchanged; no new fetches; no auth/API changes.
- PAGE diff stays page-only; helper/server Python untouched.
- No secrets/tokens/PII in snapshot, logs, or page — unchanged (the fix strictly improves token preload).

## RED control

Bug. Repro recorded via `loop.py repro` at base (exit 1: the static test fails with "2 != 1: load must be declared exactly once"; behavioral evidence: headless-Chrome dump-dom shows 3 copies at base). Gating test id for the tests gate:
`modules.tests.test_reminders_server.HabitsEditTests.test_single_load_declaration_l_one`

Mutation commands (throwaway worktree, `python3`, no `.venv`):
- `python3 -m unittest modules.tests.test_reminders_server.HabitsEditTests.test_single_load_declaration_l_one`

# Plan: fix notes-card duplication — rename the shadowed localStorage `load` getter (issue #30)

Bug. Base abb2384. PAGE JS rename + Notes/Problems reset hardening; static pin already RED.
