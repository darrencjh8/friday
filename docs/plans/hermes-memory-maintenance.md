QUESTIONS
q: Which Hermes memory and wiki cron problems does this change fix, and on what evidence? | a: Read-only prod inspection on 2026-10-10/11. `memory-compact` sends unpinned replace/remove ops, which Hermes' `apply_memory_pending` refuses (`/opt/hermes/tools/memory_tool.py:294`); `mnemosyne-vacuum.sh` calls the `sqlite3` CLI, which the image lacks (`command -v sqlite3` is empty), so it only prints sizes; `memory-triage` applied the previous day's plan on 10-10 and has re-held the same 5 records daily since 10-07; four seed blocks treat an unreadable `jobs.json` as empty and rewrite it; the MEMORY.md pointer seed re-adds a duplicate pointer (#765).
q: What schedule does the operator want for wiki maintenance, and in which timezone are cron expressions read? | a: 04:00 SGT on Mondays. `/opt/data/config.yaml` sets `timezone: Asia/Singapore` and live `next_run_at` values carry `+08:00`, so the expression is `0 4 * * 1`.
q: Why is a one-time migration needed for schedule changes? | a: The seed sets schedule fields only when it creates a job, so a dashboard choice is never reverted. Existing installs therefore need the same exact-legacy-value migration `memory-triage` already uses (`LEGACY_SCHEDULE = "0 9 * * *"`): only the exact old default is rewritten.
q: Is Python's sqlite3 module available where the vacuum script runs? | a: Yes. `/usr/bin/python3` and `/opt/hermes/.venv/bin/python3` both import sqlite3 (Python 3.13.5, SQLite 3.53.4). The operator chose it over installing the apt `sqlite3` package.
q: How is Mnemosyne consolidation run across sessions, and is it safe weekly? | a: `hermes mnemosyne sleep --all-sessions` (mnemosyne_hermes 0.7.1 CLI). A `--dry-run` on prod returned `no_op` (no working memory older than the 84 h eligibility cutoff yet). It consolidates and never deletes.
q: Where is `cross_session` read from? | a: `mnemosyne.core.config.resolve_beam_runtime()` reads `cross_session` from `/opt/data/mnemosyne/config.yaml` (config beats env). Hermes' `memory.mnemosyne.*` keys do not reach it, so the seed sets the key in that file. `true` removes session scoping for recall (the filter becomes `1=1`). Operator decision: `cross_session: true`, `default_scope` unchanged.
q: How are Telegram tables enabled, and does cron delivery use them? | a: The Telegram adapter's Bot API Rich Messages are opt-in via `platforms.telegram.extra.rich_messages` (`plugins/platforms/telegram/adapter.py:566`); the token still comes from `TELEGRAM_BOT_TOKEN` (env overrides merge via `setdefault`). Cron `_deliver_result` tries the live adapter first, and the adapter sends content containing a pipe table through `sendRichMessage`; without rich support, tables degrade to bullet groups.
q: What does MALLOC_ARENA_MAX change? | a: It caps glibc's per-thread malloc arenas (default 8 per core = 32 here; the WebUI runs 37 threads and holds 1.4 GB). `2` reduces fragmentation and unreturned memory at negligible cost under the GIL.
q: Does a wiki lint script already exist? | a: Yes. The wiki carries `scripts/lint.py` (documented in `concepts/wiki-maintenance.md`): twelve structural checks (frontmatter, taxonomy tags, sources resolve, raw SHA-256, indexed once, index count, wikilinks, inbound links, 2+ outbound links, PAN/secret scan, raw frontmatter, staleness), non-zero exit on a defect. No new script is written; the cron prompt runs it.
q: Why move memory-compact and the daily reminders? | a: memory-compact (Sun 08:30) runs after Sunday's memory-triage (08:00), so triage meets the full store that compact exists to free; 07:30 puts compact first. self-wiki-reminders-daily and memory-triage both start an agent session at 08:00 on the same gateway; 08:15 staggers them so their memory peaks do not stack. Both were agreed with the operator.
q: Why do items B-L ship under #765? | a: They come from the same operator-requested audit of the memory and wiki crons and touch the same seed file; the operator asked for one plan and one PR. The PR body lists each item.

# Hermes memory and wiki maintenance fixes

Tracked by issue #765 (the pointer fix); the other items were found in the same audit.

## Change

A. `modules/hermes/50-seed-defaults` PYPTR block: skip when the core already references `/opt/data/memories/topics` (committed). Test: `tests/test-memory-pointer.sh`.

B. Wiki maintenance default schedule `0 4 * * 1` ("every monday 4am") plus one-time migration from exact `0 9 * * 1`.

C. `modules/hermes/scripts/memory_triage.py compact`: pin every replace/remove with Hermes' `_pin_matched_entries` (dry-run included) before any topic append; refuse on a pin failure. The stub in `modules/hermes/tests/test_memory_triage_compact.py` (CI step "Test memory_triage compact") enforces the same pin rule.

D. `modules/hermes/scripts/mnemosyne-vacuum.sh`: Python `sqlite3` (connect `timeout=30`, i.e. a 30 s busy wait) for integrity, counts and VACUUM; `hermes mnemosyne sleep --all-sessions` before VACUUM. A locked VACUUM is an explicit, reported skip (`VACUUM skipped (busy)`), not a failure: the database is still intact and the next week retries. Output is a short Markdown table. Delivery stays `local`; the script exits non-zero only when integrity is not `ok` or sleep fails, which raises Hermes' cron error alert. `modules/hermes/tests/test-mnemosyne-vacuum.sh` covers ok, busy and corrupt cases and is added to `.github/workflows/test.yml` (it is not run by CI today).

E. `memory-compact` default `30 7 * * 0`, migration from exact `30 8 * * 0`.

F. `self-wiki-reminders-daily` default `15 8 * * *`, migration from exact `0 8 * * *`.

G. Compact, triage, wiki and reminders seed blocks refuse an unreadable or malformed `jobs.json` and write it atomically, like the vacuum block.

H. Triage (`modules/hermes/scripts/memory_triage.py`, tests in a new `modules/hermes/tests/test_memory_triage_apply.py` with its own CI step): `apply` refuses a plan whose mtime is older than the queue listing's mtime (`/opt/data/tmp/triage-queue.json`), so yesterday's plan cannot apply after today's listing; the digest gains a "Needs you" section for records held 7+ days, showing their text. Nothing is auto-discarded.

I. Seed sets `cross_session: true` in `/opt/data/mnemosyne/config.yaml` when the file exists.

J. Wiki prompt (seed): step 0 reads only index, schema, log and pages flagged by `scripts/lint.py` or by the repo/source diffs; step 6 runs `/opt/hermes/.venv/bin/python3 scripts/lint.py` from the wiki root and fixes what it reports. The first Monday of each month keeps a full read of every page, so drift the lint cannot see is still caught.

K. `config.yaml`: `platforms.telegram.extra.rich_messages: true`; triage and compact digests rewritten as short Markdown tables.

L. `modules/docker-compose.yml`: `MALLOC_ARENA_MAX=2` on the hermes service.

Each behaviour change gets a failing test first. Seed changes (B, E, F, G, I, J prompt) go in `modules/hermes/tests/test-50-seed-defaults.sh` (CI step "Test 50-seed-defaults cron jobs"); K config in the same seed test; L in `modules/hermes/tests/test-docker-compose-env.sh` (existing CI step).

## Risks

- `cross_session: true` makes every session's memories visible to every session, including delete visibility. Accepted by the operator.
- Rich messages are harder to copy as plain text in current Telegram clients (adapter comment). Accepted for readability.
- A schedule migration only fires on the exact legacy value, so a dashboard-chosen time is left alone.
