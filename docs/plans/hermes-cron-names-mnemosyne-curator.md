QUESTIONS
q: Where do the Mnemosyne LLM flags take effect? | a: container env only. mnemosyne/core/local_llm.py reads MNEMOSYNE_LLM_ENABLED and MNEMOSYNE_HOST_LLM_ENABLED from os.environ at import, so they go in the hermes service environment in modules/docker-compose.yml
q: Where do Mnemosyne ignore_patterns take effect? | a: the provider reads memory.mnemosyne.<key> from the Hermes config.yaml first (_read_config_key), so they go in modules/hermes/config.yaml
q: Should a sleep-forcing cron be added? | a: no (user decision). Mnemosyne's own session-end and every-10th-turn sleep stay the only triggers
q: Should curator merges apply automatically? | a: no, proposals only; curator.consolidate stays false
q: What if the host LLM call fails during sleep? | a: llama_cpp and ctransformers are not installed in the image, so the fallback is aaak encoding, with no 656MB model download
q: Should the job renames carry the schedule in the name? | a: no (user decision); names describe the job, not its cadence
q: Does the "Friday is online" boot ping count as a notification to remove? | assumption: keep it. It is sent silently (disable_notification) and is the only deploy confirmation; out of scope here

# Hermes cron job renames, quiet Telegram digests, Mnemosyne summaries, skill-merge proposals

## Goal

Make the seeded Hermes cron jobs easy to read and quiet unless something needs the owner, let Mnemosyne's built-in sleep write real summaries, and surface the built-in skill curator's merge proposals.

## Facts

- Seeded jobs are matched by name in `modules/hermes/50-seed-defaults`; the existing `github-auth-refresh` to `github-app-auth-refresh` migration renames in place and keeps the id.
- Mnemosyne sleep has never run because only rows older than half `wm_ttl_hours` (84 h) are eligible and the provider went live on 2026-10-09. With `llm_enabled` and `host_llm_enabled` false it would fall back to aaak encoding.
- Webhook push alerts and cron reply echoes are stored as `[USER]` working memories.
- `hermes curator run --dry-run --consolidate --sync` writes a report-only `REPORT.md` under `/opt/data/logs/curator/<stamp>/` with `consolidations` and `prunings` lists; `curator.consolidate` defaults to false.
- `memory-compact` step 3 tells the agent to reply with a digest when nothing was needed, contradicting its own `[SILENT]` rule. The weekly wiki finance job has no `[SILENT]` path.

## Changes

1. Rename seeded jobs. One rename block runs before every cron seed block and renames old names in place (id, schedule and history kept); each seed block then uses the new name:
   - `memory-triage` to `memory-approve-queue`
   - `mnemosyne-vacuum` to `memory-mnemosyne-vacuum`
   - `self-wiki-reminders-daily` to `wiki-due-reminders`
   - `self-wiki-maintenance-and-reminders` to `wiki-finance-refresh`
   - `self-wiki-repos-weekly` to `wiki-repo-docs`
   - `log-issue-triage` to `ops-log-issues`
   - `github-app-auth-refresh` (and legacy `github-auth-refresh`) to `ops-github-token-refresh`
   - `portfolio-daily-sync` to `finance-portfolio-sync`
   - `memory-compact` and `memory-backup` keep their names.
   Script names (`memory-triage.sh`), work directories and plugin names are not renamed. Prompt cross-references and repository docs (README.md, SETUP.md, design.md, docs/architecture.md) follow the new names.
2. Quiet, rich Telegram digests:
   - `memory-compact` step 3 replies `[SILENT]` when both stores are under 80%.
   - `wiki-finance-refresh` replies `[SILENT]` when no row would go in the change table, nothing is due, and no check failed.
   - `wiki-repo-docs` sends a "🔎 *Repo docs · <date>*" heading with a `| Repo | Issue | Link |` table when it files an issue or a fetch fails.
3. Mnemosyne: add `MNEMOSYNE_LLM_ENABLED=true` and `MNEMOSYNE_HOST_LLM_ENABLED=true` to the hermes service environment, and `ignore_patterns` for `⚠️ System push alert` and `\[Replying to: "Cronjob` under `memory.mnemosyne` in config.yaml. Update `mnemosyne-pilot.md` with the 84 h cutoff, the session scope and why there is no sleep cron.
4. New no-agent job `skills-merge-proposals` (Sunday 04:15, deliver telegram) running new `scripts/curator-proposals.sh`: it runs the curator dry run with `--consolidate`, reads the newest `REPORT.md`, prints `{"wakeAgent": false}` when both lists are empty, otherwise a "🧰 *Skill merge proposals · <date>*" table of proposals, and one bold error line when the report is missing or unreadable.

## Tests

- New `modules/hermes/tests/test_cron_job_renames.py`: every old name is renamed in place with the same id and schedule, a second run changes nothing, an unrelated job survives, and no old name remains a seeded name.
- New `modules/hermes/tests/test_curator_proposals.py` with a fake `hermes` binary: empty lists stay silent, proposals produce a table, a missing report prints one error line.
- Update `test-50-seed-defaults.sh`, `test-seed-app-cron.py`, `test_log_issue_triage_cron.py` for the new names and add checks for the silent paths, the Mnemosyne config keys and the proposals job.

## Not changed

Mnemosyne TTL, `dream_active` (unread), SHMR (unscheduled), sleep triggers, `curator.consolidate`, local-only jobs' delivery.
