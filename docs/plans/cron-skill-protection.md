QUESTIONS
q: Does Hermes let config re-allow GTASKS_* into the execute_code sandbox? | a: Yes. tools/env_passthrough.py `_load_config_passthrough` reads `terminal.env_passthrough` and refuses only names on `_HERMES_PROVIDER_ENV_BLOCKLIST`; GTASKS_* are not on it. tools/code_execution_env.py `_scrub_child_env` keeps passthrough names before its secret-substring block.
q: Why config rather than the skill's `required_environment_variables`? | a: Skill passthrough is registered only when `skill_view` runs in the session; config passthrough is process-wide, so it holds no matter how the cron session loaded the skill.
q: Does the baked config.yaml reach the live config? | a: Yes. 50-seed-defaults copies the baked file and only carries live top-level keys the baked file lacks; `terminal` is baked, so the new key lands.
q: Does `hermes curator pin` keep the curator away from a skill? | a: Yes. agent/curator.py skips pinned skills in auto-transitions, and its consolidation prompt says "DO NOT touch skills shown as pinned=yes. Skip them entirely."
q: Which umbrella replaces each absorbed skill? | a: From the live curator reports: cron-job-inspection -> hermes-operations, docs-accuracy-verification -> knowledge-base-maintenance. hermes-troubleshooting was also absorbed into hermes-operations at runtime, but it is a baked repo skill, so the next boot restores it and its references stay.
q: Should the 2026-10-26 runtime edits to gtasks-cli be kept? | assumption: Yes. The seed copies repo skills over the runtime copy on every boot, so deploying this change would silently revert them; the repo copy takes the live text plus nothing else.

# Cron skill protection and GTASKS passthrough (issue #57)

## Problem

The 2026-10-27 `wiki-due-reminders` run failed for two reasons:

1. The agent ran `wiki-reminder-tasks.py` from `execute_code`. That sandbox drops `GTASKS_CLIENT_SECRET` (secret substring) and `GTASKS_CLIENT_ID` (no safe prefix) unless they are registered for passthrough, so `gtasks` exits 2 with `GTASKS_CLIENT_ID/GTASKS_CLIENT_SECRET must be set.` Runs succeed only when the model picks `terminal`.
2. Telegram-approved curator merges (applied by the agent through `skill-merge-approval`) absorbed skills that cron jobs still list. Nothing rewrites job references on that path, and the seed re-applies the old names on every boot. Today `cron-job-inspection` (two jobs), `docs-accuracy-verification` (one job) and `hermes-troubleshooting` (two jobs) are missing.

## Change

1. `modules/hermes/config.yaml`: add `env_passthrough: [GTASKS_CLIENT_ID, GTASKS_CLIENT_SECRET]` under `terminal`.
2. `modules/hermes/50-seed-defaults`: replace `cron-job-inspection` with `hermes-operations` in `wiki-finance-refresh` and `wiki-due-reminders`, and `docs-accuracy-verification` with `knowledge-base-maintenance` in `wiki-repo-docs`. Update the matching assertions in `modules/hermes/tests/test-50-seed-defaults.sh`.
3. `modules/hermes/50-seed-defaults`: after all job seeding, a `# Pin every skill a cron job loads` block reads `jobs.json` and runs `su -s /bin/sh hermes -c "hermes curator pin <name>"` for each unique name in any job's `skills` list or `skill` field. Failures are ignored, like the other best-effort seed blocks.
4. `modules/hermes/scripts/curator-proposal-approval.py`: after selection, read `$HERMES_HOME/cron/jobs.json`; if any selected merge's `from` is used by a job, refuse (exit 1) naming the skill and the jobs. An absent jobs file means no job uses anything.
5. `modules/hermes/skills/gtasks-cli/SKILL.md`: take the live 2026-10-26 text.

## Tests

`modules/tests/test_cron_skill_protection.py` (new, RED at base):

- `ExecuteCodePassthroughTest.test_gtasks_credentials_reach_execute_code` (the reproduction)
- `SeedPinsCronSkillsTest.test_every_cron_skill_is_pinned`: runs the real seed block with a fake `su` and checks one pin call per unique cron skill.
- `ApprovalRefusesCronSkillMergeTest`: a merge of a cron-used skill is refused; a merge of an unused skill still passes.

Plus the existing `modules/tests` suite, `test_curator_proposals.py`, and `test-50-seed-defaults.sh`.

## Out of scope

Rewriting live `jobs.json` by hand (the next boot's seed does it), and runtime skill edits being overwritten by the seed in general.
