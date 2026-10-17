QUESTIONS
q: Where do edits land — snapshot or wiki? | a: Wiki (daily-habits.md); the snapshot regenerates daily and edits to it would be overwritten.
q: Which reminders are editable in v1? | a: Daily-habits table rows only; dated items stay read-only (unstructured Notion/route context unsafe for forms).
q: How are writes authenticated? | a: Bearer token (REMINDERS_EDIT_TOKEN env) on POSTs only; GETs stay open; empty/unset token disables editing (403 fail-closed).
q: How does the token reach production? | a: GitHub secret REMINDERS_EDIT_TOKEN via deploy.yml env into compose interpolation (same path as GTASKS_CLIENT_ID); never in git.
q: What happens to already-created Google Tasks when a habit is removed? | a: Nothing — the helper never deletes; removal stops future creation only, stated as a page caveat.
q: Wiki concurrent rewrite with the 08:15 agent run? | a: Atomic tmp+rename both sides, last-writer-wins; ~1 min/day collision window accepted and documented, no locking.
q: When does an edit take effect? | a: Next 08:15 cron run; no refresh-now in v1; page shows live wiki table separately from last snapshot so pending changes are visible.
q: How are untrusted titles/notes rendered in the editor? | a: DOM textContent only, same as snapshot table; no-innerHTML test extends to new script code.

## Change surface

- `modules/hermes/scripts/reminders-server.py`:
  - `HABITS = os.environ.get("REMINDERS_HABITS",
    "/opt/data/home/wiki/entities/accounts/daily-habits.md")`
  - `EDIT_TOKEN = os.environ.get("REMINDERS_EDIT_TOKEN", "")`
  - Table parse: read file, extract `## Daily candidates` markdown rows into
    `[{key, title, note}]` (keys are backtick-quoted in the first column).
    Missing file → empty list (same fallback as the seed prompt: zero habits,
    never a problem). Malformed rows are skipped, never fatal.
  - Table write: replace only the Daily-candidates rows, preserve every other
    line byte-for-byte; atomic tmp+rename.
  - Input charset (table-injection guard): titles and notes are 400-rejected
    when they contain `|`, backtick, CR, or LF; title cap 120 chars, note cap
    500 chars. Keys are server-derived, never user-supplied.
  - Key derive: `habit-` + lowercase title, non-alphanumerics → `-`,
    collapsed/stripped; reject duplicates and empty titles; reject keys with
    newlines/control chars. Type is always `daily`, action_date always today
    at cron time — neither is user-editable.
  - Routes: `GET /api/habits` → `{"habits": [...]}` (open);
    `POST /api/habits` with `{"action": "add"|"remove", ...}` +
    `Authorization: Bearer <token>` → `200 {"habits": [...]}` or
    `401` (missing), `403` (wrong/disabled), `400` (validation),
    `413` (body over 16KB). Auth is checked before the body is read;
    malformed JSON is 400. No token value, key, or wiki content in logs —
    only status + route.
  - Page: Habits card (live table + add form + remove buttons + the
    already-created-tasks caveat + token unlock stored in localStorage);
    snapshot card relabeled "Last run"; dated items unchanged.
- `modules/hermes/webui/s6-rc.d/reminders/run`: export
  `REMINDERS_EDIT_TOKEN=${REMINDERS_EDIT_TOKEN:-}` and
  `REMINDERS_HABITS=${REMINDERS_HABITS:-/opt/data/home/wiki/entities/accounts/daily-habits.md}`
  next to the existing PORT/SNAPSHOT exports, so the server env does not
  depend on with-contenv forwarding through s6-setuidgid.
- `modules/docker-compose.yml`: hermes environment
  `- REMINDERS_EDIT_TOKEN=${REMINDERS_EDIT_TOKEN:-}`.
- `.github/workflows/deploy.yml`: `REMINDERS_EDIT_TOKEN: ${{ secrets.REMINDERS_EDIT_TOKEN }}`
  in the deploy env block.
- `docs/operations.md`: token generation (`python3 -c
  "import secrets; print(secrets.token_urlsafe(32))"`), `gh secret set`,
  and the caveat that removal does not delete created Tasks.
- Tests in `modules/tests/test_reminders_server.py` (stdlib, no yaml).

## Test command and scope

- `.venv/bin/python -m unittest modules.tests.test_reminders_server`
  (habits GET/POST incl auth 401/403/disabled, delimiter/length rejection
  incl pipe/backtick/newline round-trip, 413 on oversize, 400 on malformed
  JSON, 401 before body read, table parse/write incl malformed rows,
  no-innerHTML over the extended page).
- `.venv/bin/python -m unittest discover -s modules/tests -p
  "test_wiki_reminder*.py"` (helper untouched, regression only).
- `bash modules/hermes/tests/test-50-seed-defaults.sh`
- `bash modules/hermes/tests/test-docker-compose-env.sh`
- `.venv/bin/python scripts/check-no-pii.py`

## Constraints

- Tailnet-only exposure; loopback-only publishes (port guardrail test).
- No secrets/tokens in snapshot, wiki writes, logs, or page (PII scan +
  gitleaks in CI). The token travels only in the Authorization header and
  server env; the page never renders it.
- Editing disabled unless the token env is non-empty (fail closed).
- Dated reminder rows are never writable via this API (400).
- Titles/notes with table delimiters (`|`, backtick, CR/LF) or over length
  caps are rejected (400) before any file write.

## RED control

Feature: no repro. Gating test id for the tests gate:
`modules.tests.test_reminders_server.ServerTests.test_edit_needs_token`
(absent at base → mutation control fails there; present + passing at HEAD).
