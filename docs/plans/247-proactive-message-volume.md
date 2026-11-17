QUESTIONS
q: Threshold — one line to the owner when the weekly message count passes 3 a day on average (21/week)? | assumption: Yes, 21/week, constant in the script. Darren can change the number at approval; no per-day threshold, no second threshold.
q: Weekly run day and time? | assumption: Sunday 09:00 SGT, cron expr `0 9 * * 0`. Mirrors the existing Sunday weekly jobs (memory-mnemosyne-forget 02:30, memory-mnemosyne-vacuum 03:00) at an hour that does not collide with them. Darren can move it.
q: Are /opt/data/cron/output/<job_id>/ files retained at least 7 days, and what is the timestamped filename format? | assumption: Retained 7+ days; the run day is read from the filename timestamp, falling back to file mtime (SGT) when the name does not parse. Verification step 1 checks this on the host before implementation; if retention is shorter, the script keeps its own weekly tally file instead and the plan is re-reviewed.
q: Does a tick skipped by the empty-stdout pre-run script write an output file? | assumption: Unknown; verification step 1 checks. Either way a skipped tick counts as no tick, not a silent tick: only runs that produced an output file are counted (message vs silent vs failure).
q: Does a no_agent job with deliver: dots deliver its stdout to Dots, with empty stdout staying silent? | a: Yes. gtasks-clear-completed is no_agent + deliver: dots, prints nothing on success (seed comment "Silent on success; a failure is alerted", script prints nothing, API error exits non-zero). Same contract for this script.
q: Items per message — count from the proactive-tick notepad `reported` key? | a: Yes. The seeded prompt (step 11) writes one `YYYY-MM-DD: <item>` entry per item sent into the `reported` key, kept for the last 7 days. Caveat: it is agent-written and can drift, so it is only the item count; the output files are ground truth for message-vs-silent. If `reported` and the output files disagree on a day, the output files win.

## Goal

Nothing measures whether Friday's proactive messages are too many or too few (issue #247). A weekly no-agent cron script counts, per day over the last 7 days, proactive-tick runs that delivered a message versus `[SILENT]`, plus items per message, and sends the owner one line only when the weekly count passes 3 messages a day on average.

## Evidence

1. `proactive-tick` is an hourly agent job, `0 8-21 * * *`, deliver `dots` (`modules/hermes/50-seed-defaults`, seed block "Seed proactive-tick cron job", ~line 1948; schedule `DEFAULTS`, MANAGED prompt/script/`attach_to_session`). Its prompt step 9: "If nothing needs him and you send no persona message (step 10), reply exactly [SILENT]". Step 11 writes the `reported` notepad key, one `YYYY-MM-DD: <item>` entry per item sent, last 7 days. A first-line `[CRON_FAILURE]` marks a failed run. So a delivered message is exactly a run whose reply is neither `[SILENT]` nor `[CRON_FAILURE]` — including a reply that is only a persona message.
2. Every cron run writes a timestamped `.md` file with stdout, stderr and exit code to `$HERMES_HOME/cron/output/<job_id>/`, and for agent jobs the file contains the full agent transcript (`modules/hermes/skills/hermes-troubleshooting/SKILL.md:164`). `/opt/data` is `HERMES_HOME` on the host, so the issue's `/opt/data/cron/output/<job id>/` path is real. The exact filename timestamp format is not stated anywhere in this repo — verification step 1 confirms it on the host.
3. The proactive-tick job id is minted at seed time (`uuid.uuid4().hex[:12]`), not fixed, so the script must resolve it from `/opt/data/cron/jobs.json` by name. Precedent: `proactive-tick.py` `own_job_id()` reads `JOBS` the same way, and `modules/tests/test_proactive_tick_notepad.py` tests it against a fake jobs file.
4. The no-agent + `deliver: dots` delivery contract already exists: `gtasks-clear-completed` is seeded `no_agent: True`, `deliver: dots`, script `gtasks-clear-completed.py`, which prints nothing on success and exits non-zero on API error. A weekly script that prints one line only over threshold and nothing otherwise is the same shape — no new delivery mechanism.
5. The notepad read is read-only sqlite on the `cron_notepad` table (`job_id`, `key`, `value`): `proactive-tick.py` line 283 reads the `followups` key with `mode=ro`-style handling and tolerates a missing table. The weekly script reads the `reported` key the same way.
6. Weekly Sunday precedent: `memory-mnemosyne-forget` `30 2 * * 0`, `memory-mnemosyne-vacuum` `0 3 * * 0`. A 09:00 Sunday slot collides with neither.

## Changes

Two files, one new script plus one seed block. No change to `proactive-tick.py`, its prompt, any other job, or any workflow file.

1. New `modules/hermes/scripts/proactive-tick-volume.py` (~120 lines, stdlib only):
   - `HOME = os.environ.get("HERMES_HOME", "/opt/data")`, same as `proactive-tick.py` line 54.
   - Resolve the proactive-tick job id from `$HOME/cron/jobs.json` by `name == "proactive-tick"`. A missing or corrupt jobs file exits non-zero (never treat an unreadable file as empty — same guard as the seed blocks); a missing output directory for a resolved job id also exits non-zero, so a broken path surfaces instead of silently reporting zero.
   - Read `$HOME/cron/output/<job_id>/*.md` from the last 7 SGT days. Classify each file by its reply: first line `[CRON_FAILURE]` → failure; reply exactly `[SILENT]` → silent; anything else → one delivered message. Runs with no output file (pre-run script printed nothing, tick skipped) are not counted at all.
   - Items per day from the notepad: read-only sqlite on `$HOME/cron/notepad.db`, `cron_notepad` table, `key = 'reported'` for this job id; count the `YYYY-MM-DD: <item>` entries per date. A missing table or key means 0 items, not an error.
   - Print exactly one line, and only when messages > 21: `Proactive messages, last 7 days: <N> (<avg>/day), <M> silent, <F> failed, <P> items.` Print nothing otherwise. Exit non-zero only on the unreadable-input cases above; a quiet week is exit 0 with no output. The script writes nothing anywhere.
   - `ponytail:` counts are a heuristic on the reply text, not a delivery receipt — a run that crashed after replying still counts as a message. That ceiling is accepted; exact delivery receipts would need a change to the runner, out of scope.
2. Seed block in `modules/hermes/50-seed-defaults`, same shape as `gtasks-clear-completed` (lines ~1199-1235): job `proactive-tick-volume`, `MANAGED = {"script": "proactive-tick-volume.py", "no_agent": True, "deliver": "dots"}`, `DEFAULTS` schedule cron `0 9 * * 0`, display `Sunday 9am`, enabled, `next_run_at: None`. No prompt (no_agent jobs carry none). MANAGED reconciled on every boot; schedule minted once and left alone, so a dashboard change to the time is not reverted. The script ships to `/opt/data/scripts/` with the rest of `modules/hermes/scripts/` at deploy (DEPLOY.md:241), so no separate install step.

## Tests

Repro-style test file (new, `modules/tests/test_issue_247.py`, ids named here), same importlib-load + tmp-dir pattern as `modules/tests/test_proactive_tick_notepad.py` — fake `jobs.json`, fixture output `.md` files, fake `notepad.db`:

- `tests.test_issue_247.TestVolume.test_message_silent_failure_counts`: a message reply, a `[SILENT]` reply and a `[CRON_FAILURE]` reply classify 1/1/1; a run with no output file is not counted.
- `tests.test_issue_247.TestVolume.test_threshold_boundary`: 21 messages in 7 days prints nothing; 22 prints the one line with the right counts.
- `tests.test_issue_247.TestVolume.test_items_from_reported`: `reported` entries dated per day count per day; a missing `reported` key means 0 items.
- `tests.test_issue_247.TestVolume.test_day_buckets_sgt`: a file dated either side of the SGT midnight boundary lands in the right day bucket.
- `tests.test_issue_247.TestVolume.test_unreadable_inputs_fail`: corrupt `jobs.json` and a missing output directory both exit non-zero.
- Guard: `test_seed_proactive_tick_volume` in `modules/hermes/tests/test-50-seed-defaults.sh` (same `extract_seed_block` pattern as the proactive-tick assertions ~line 2156): the seed creates `proactive-tick-volume` with `no_agent`, script `proactive-tick-volume.py`, `deliver: dots`, Sunday `0 9 * * 0` schedule, and no prompt.

Full suite command (as CI runs it): `python3 -m unittest discover -s modules/tests -p 'test_*.py'` from the repo root (CI uses `python`; this VM has `python3` only). Focused: `python3 -m unittest tests.test_issue_247 -v` from `modules/`. Seed harness: `bash modules/hermes/tests/test-50-seed-defaults.sh`.

## Verification

1. Before implementing, on the host (production inspection needs Darren's approval first, per AGENTS.md): list `/opt/data/cron/output/<proactive-tick job id>/` and confirm the timestamped `.md` filename format, that files go back at least 7 days, that a `[SILENT]` reply and a delivered reply are both readable in the files, and whether a skipped tick writes a file. Record the format. If retention is under 7 days, stop and re-review: the script would keep its own weekly tally file instead.
2. `python3 -m unittest tests.test_issue_247 -v` (from `modules/`): all pass at HEAD.
3. `bash modules/hermes/tests/test-50-seed-defaults.sh`: green.
4. Full suite `python3 -m unittest discover -s modules/tests -p 'test_*.py'`: green.
5. Code review round (fresh reviewer, driver contract report), then push branch `fix/issue-247-proactive-message-volume` via the GitHub App, open the PR, request Darren's review (`darrencjh8` as requested reviewer), verify CI green via the App Checks read. No merge by the agent. Ship only through the normal merge-triggered CI/CD deployment; no manual prod edits or restarts. The seed reconciles on the next boot.
6. Live check after deploy: the new job's own output file on the first Sunday shows exit 0 and no delivery when under threshold. The 22-message boundary is proven by the unit test, not live — it cannot be forced without 22 real messages.

## Out of scope

- The issue's optional later step: a fixed set of recorded tick inputs with expected tell/skip decisions run against prompt changes in CI. Not built now — a follow-up if Darren wants it.
- Changing the proactive-tick prompt, the threshold beyond the single constant, per-source breakdowns, a dashboard, or output-file retention.
- Backfill: no history before the output files exist.
- Secrets: none involved; the script reads only local cron state and prints counts.
