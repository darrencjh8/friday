QUESTIONS
q: Does the dashboard need write actions (create/complete tasks)? | assumption: No — read-only v1; actions stay in the CLI/skill boundary.
q: Where does the snapshot file live? | a: /opt/data/reminders/reminders.json on the persisted volume, written atomically by the helper.
q: Which port and route? | a: Container 0.0.0.0:8300 (compose publishes 127.0.0.1:8300; Docker forwards to the container interface, same rationale as the WebUI), tailnet via `tailscale serve --set-path /reminders` (operator step post-deploy).
q: Does the seed prompt change risk reverting live behavior? | a: Yes — MANAGED includes prompt, so the seed is updated to the silent/problems-only version with the daily-habits source and --snapshot-out; verified by test-50-seed-defaults.sh.
q: How are untrusted task titles rendered? | a: DOM textContent only; a test asserts no innerHTML in the server source.
q: What happens on a corrupt snapshot or a missing habits file? | a: Corrupt snapshot logs to stderr and serves a flagged empty state (problems non-empty; covered by test); a missing daily-habits.md means zero habits, never a problem.

# Plan: reminders snapshot + read-only dashboard (PR #844)

## Change surface (base..HEAD on feat/reminders-ui)
- `modules/hermes/scripts/wiki-reminder-tasks.py`: `--snapshot-out PATH`
  flag; per-item status rows (created/skipped/pending/overdue-manual/
  conflict/create-failed/unclassified) with days_left/lead_days/note;
  atomic snapshot write. Existing stdout contract unchanged.
- `modules/hermes/scripts/reminders-server.py` (new, stdlib only):
  GET / (dashboard), GET /api/reminders (snapshot or empty state),
  GET /health, 404 otherwise. No content logging.
- `modules/hermes/webui/s6-rc.d/reminders/` (new longrun): run + type +
  dependencies.d/base; runs baked
  `/opt/hermes-defaults/scripts/reminders-server.py` as hermes.
- `modules/hermes/Dockerfile`: install the reminders service + contents.d.
- `modules/docker-compose.yml`: `127.0.0.1:8300:8300` (loopback only).
- `modules/hermes/50-seed-defaults`: wiki-due-reminders prompt →
  silent/problems-only + daily-habits.md source + daily type +
  --snapshot-out invocation.
- `docs/operations.md`: `/reminders` serve line (operator step post-deploy).
- Tests: `modules/tests/test_reminders_server.py` (new: health/index/api/
  empty-state/404/no-innerHTML), snapshot case in
  `test_wiki_reminder_helper.py`, port-guardrail + seed wording updates.

## Test command and scope
- `.venv/bin/python -m unittest discover -s modules/tests -p
  "test_wiki_reminder*.py"` for the helper, and
  `.venv/bin/python -m unittest modules.tests.test_reminders_server`
  for the server (health/index/api/empty-state/corrupt/404/no-innerHTML).
- `bash modules/hermes/tests/test-50-seed-defaults.sh`
- `bash modules/hermes/tests/test-docker-compose-env.sh`
- `scripts/check-no-pii.py`
- Named RED-control test id for the tests gate:
  `modules.tests.test_wiki_reminder_helper.HelperTests.test_snapshot_out_writes_structured_items`

## Constraints
- Tailnet-only exposure; loopback-only publishes (port guardrail test).
- No secrets/tokens in snapshot, logs, or page (PII scan + gitleaks in CI).
- Corrupt snapshot: stderr log + flagged empty state (problems non-empty),
  covered by `test_corrupt_snapshot_serves_flagged_empty_state`.
- Missing daily-habits.md: zero habits for the run, never a problem.
  Locked by a seed-suite assertion that the prompt carries the fallback
  language (`test-50-seed-defaults.sh`: `habits_fallback`); the helper
  itself never reads the file (candidates arrive on stdin), so there is
  no helper unit to pin — the prompt text is the contract.
- Skill safety boundary unchanged: no rm/update/clear from any flow.
- Live cron prompt is production state edited via Hermes API; seed keeps it
  from reverting on deploy.
- Router-manager iframe is out of scope (separate repo, follow-up).

## Verification already done (to be re-earned at gates)
- 6 helper + 5 server unit tests green; seed suite 117/117; compose 19/19.
- Live server smoke test (API/page/empty/404) passed pre-commit.
