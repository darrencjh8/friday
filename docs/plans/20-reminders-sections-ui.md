QUESTIONS
q: Why is the live page blank? | a: JS fetches absolute /api/... paths; under the tailscale /reminders mount the prefix is lost, so both fetches 404 at the proxy (confirmed by user screenshot + live curl).
q: How is the mount bug fixed? | a: API base derived at runtime — const BASE = location.pathname.replace(/\/+$/, "") then fetch(BASE + "/api/..."); works at /reminders, /reminders/, and root. Plus Cache-Control: no-store on every response so deploys are never masked by heuristic caching, and localStorage access wrapped in try/catch (privacy modes throw SecurityError).
q: Do weekly habits exist today? | a: No — no weekly type in the helper, no weekly wiki section, no prompt rule. This change adds all three; without any one of them the cron would never create weekly tasks.
q: How do weekly/monthly rows work end-to-end? | a: New "## Weekly candidates" section and existing "## Monthly candidate" section carry a freeform Recurrence column ("Monday", "1st of each month"); the agent computes the next action_date at run time (it already does this for monthly clean-room). Helper gains LEAD_DAYS["weekly"] = 0 (due on the day); seed prompt gains one weekly rule sentence and "weekly" in the types list.
q: What does the server edit surface become? | a: GET /api/habits returns {"daily": [...], "weekly": [...], "monthly": [...]}; POST gains "section": "daily"|"weekly"|"monthly" (default daily) plus "when" (recurrence text) for weekly/monthly adds. Same guards: delimiter/length rejection (when cap 120), server-derived keys (habit-/weekly-/monthly- prefixes), line-based insert/delete, fail-closed 500 on missing section, malformed rows preserved verbatim.
q: What happens when the live wiki lacks the weekly section? | a: Same fail-closed rule as daily: reads of that section return empty, writes 500 with no file change. After deploy the operator adds the "## Weekly candidates" heading to daily-habits.md once via Hermes (explicit permission, per wiki rules) — no section-creation code is built for a one-time setup step.
q: Are the three #18 Lows included? | a: Yes — isascii() guard before compare_digest (403), Content-Length try/except → 400 and negative → 413, and title/note/when reject Unicode line-boundary chars (splitlines set: \x0b \x0c \x1c-\x1e \x85 \u2028 \u2029) in _validate_text.
q: Favicon? | a: Inline SVG data-URI (alarm-clock glyph) in the page head; no asset file, no extra route, no request.
q: Dark mode? | a: The page already honors prefers-color-scheme; add an Auto/Light/Dark selector persisted in localStorage (guarded), implemented as a body.light/body.dark override class on top of the existing media query. Defaults to Auto.
q: Concurrency, locking, refresh-now? | a: Still out of scope — single-threaded server, atomic tmp+rename, next-cron-run effect. Unchanged from plan 19303d0e.

## Change surface

- `modules/hermes/scripts/reminders-server.py`:
  - `SECTIONS = {"daily": "## Daily candidates", "weekly": "## Weekly candidates", "monthly": "## Monthly candidate"}`; parse/write parameterized by section (same row shape: key, title, recurrence-or-today, type, note).
  - Runtime API base + `no-store` on all responses; guarded localStorage.
  - Habits card becomes three sub-tables (Daily / Weekly / Monthly) each with rows + remove; add form gains a section selector and a When field (weekly/monthly only). All rendering stays DOM textContent.
  - Auth/content hardening: isascii guard, Content-Length parse 400/413, extended delimiter set.
  - Favicon `<link rel="icon">` data-URI; theme selector + body class override CSS.
- `modules/hermes/scripts/wiki-reminder-tasks.py`: `LEAD_DAYS["weekly"] = 0` and the prompt-comment types list (docstring) gains weekly.
- `modules/hermes/50-seed-defaults`: wiki-due-reminders prompt — types list gains `weekly`; step 3 gains "Weekly habits: emit one candidate per weekly habit with action_date set to its next recurrence date, type weekly."
- Tests: `modules/tests/test_reminders_server.py` (three-section GET/POST, when-field, section validation, no-store header, new hardening cases) and `modules/tests/test_wiki_reminder_helper.py` (weekly lead-days accepted). Seed suite stays green (prompt text is asserted there).

## Test command and scope

- `.venv/bin/python -m unittest modules.tests.test_reminders_server`
- `.venv/bin/python -m unittest discover -s modules/tests -p "test_wiki_reminder*.py"`
- `bash modules/hermes/tests/test-50-seed-defaults.sh`
- `bash modules/hermes/tests/test-docker-compose-env.sh`
- `.venv/bin/python scripts/check-no-pii.py`

## Constraints

- Tailnet-only; loopback-only publish; token auth on POSTs unchanged (fail closed).
- No secrets/tokens/wiki content in logs or page; textContent-only rendering (no-innerHTML test covers new code).
- Dated reminder items (Trust Bank, GXS, waiver calls) stay read-only.
- Removing any habit stops future tasks only; created Google Tasks are never deleted.

## RED control

Feature: no repro. Gating test id for the tests gate:
`modules.tests.test_reminders_server.HabitsEditTests.test_api_base_relative_to_mount`
(static assertion: PAGE contains no `fetch("/` absolute fetch; plus live behavior covered by existing suites). Secondary new-behavior control: weekly add round-trip test absent at base.
