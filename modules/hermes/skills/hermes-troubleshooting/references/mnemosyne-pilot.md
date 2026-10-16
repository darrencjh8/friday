# Mnemosyne activation (seed-owned)

Mnemosyne is a memory provider plugin, not a context engine and not a
replacement for the `memory-approve-queue` cron. Built-in `MEMORY.md`/`USER.md`
stay ON (additive). The seed owns the provider flip plus the version pin,
so reboots keep the working state instead of drifting.

## What Hermes reads

Only `MEMORY.md`/`USER.md` auto-inject every turn. `topics/*.md` load via
the core pointer plus keyword search. `state.db` loads via `session_search`.
`DREAMS.md` never loads. Mnemosyne loads via pre-turn prefetch plus its own
system-prompt header once `memory.provider: mnemosyne` is set.

## Install (seed-owned, verified live 2026-10-09)

The seed flips `memory.provider: mnemosyne` (only when the provider loads)
and pins the working pair into `/opt/data/lazy-packages`. Operator install
is a one-time bootstrap only:

```bash
hermes plugins install mnemosyne
```

Restart ships via the deploy pipeline, never by hand on prod.

Version pins: `mnemosyne-hermes==0.7.1` + `mnemosyne-memory[embeddings]
==3.15.1` is the working stable pair. Do NOT take 0.7.3/0.7.4: the P1b
home-binding guard makes `MnemosyneMemoryProvider.__init__` raise under any
turn scope (`self._beam = None` hits `_write_slot()` before `_bindings`
exists), so discovery logs "loaded but no provider instance found" and no
session ever gets tools. Avoid `0.7.2` (imports APIs its floor lacks).
Needs Hermes `>=0.21.4` (prod runs v0.21.5). Catalog versus wrapper share one path
`$HERMES_HOME/plugins/mnemosyne`; catalog install onto a wrapper refuses
with "already exists", uninstall first to switch.

RAM: core `~50MB` needs a remote embedding endpoint, `[embeddings]` `~800MB`
needs 2GB free, `[all]` `~1.5GB` wants 8GB. First use downloads
`BAAI/bge-small-en-v1.5` from Hugging Face; first uncached sleep downloads
`MiniCPM5-1B-Q4_K_M.gguf` `~656MB`. `MNEMOSYNE_LLM_ENABLED=false` skips it.

## Verify

```bash
hermes memory status
hermes tools list | grep mnemosyne_
hermes mnemosyne stats
hermes mnemosyne sleep
hermes doctor | grep -i memory
```

`memory status` shows registration only, not connectivity. Do not disable
built-in with `hermes tools disable memory`; that hides provider tools too
(`agent_init.py`). Disable via `memory_enabled: false` plus
`user_profile_enabled: false` only at cutover, never during pilot.

## Known limits

- Cron hardcodes `skip_memory=True`, so `mnemosyne_*` tools are unavailable
  in cron sessions. `memory-approve-queue` keeps using
  `scripts/memory_triage.py apply` through `apply_memory_pending`.
- Hermes plugin defaults `auto_sleep` to `false`; set it `true` or
  cross-session consolidation never runs on fresh installs.
- `hermes journey` manages built-in nodes only. Mnemosyne rows use
  `forget`/`update`/`invalidate`/`get`, `doctor` plus gated `repair`.
- Backup is split: git markdown under `memories/` every 6h plus a single
  `mnemosyne/mnemosyne.db` file replaced in place at most once per 24h
  (`MNEMOSYNE_BACKUP_MAX_AGE_HOURS`, same filename, never dated copies).
  `memory-backup.sh` no-ops when the DB is absent.

## Sleep (consolidation)

Sleep folds old working memory into episodic summaries. It runs only on
Mnemosyne's own triggers: at session end, and on every 10th turn once working
memory exceeds `sleep_threshold`. Both are scoped to one session (upstream
#771), and only rows older than half `wm_ttl_hours` (168 h, so 84 h) are
eligible, so a fresh install shows `episodic_memory = 0` for its first 3.5
days. That is expected, not a failure. Check with
`hermes mnemosyne sleep --all-sessions --dry-run` (read-only).

There is deliberately no cron forcing `--all-sessions`: one-shot webhook
sessions never reach the trigger, and their rows expire at the TTL instead,
which is what alert noise should do.

Summaries use the Hermes auxiliary model registered in-process, enabled by
`MNEMOSYNE_LLM_ENABLED=true` and `MNEMOSYNE_HOST_LLM_ENABLED=true` in the
hermes service environment (`local_llm` reads them at import, so
`config.yaml` cannot set them). No local GGUF backend is installed, so a
failed host call falls back to `aaak` encoding, never a model download.
`memory.mnemosyne.ignore_patterns` keeps push alerts and cron reply echoes
out of working memory. `dream_active` is not read by 3.15.1.

## Vacuum (weekly, never deletes)

`memory-mnemosyne-vacuum` cron runs Sundays `0 3 * * 0`, `no_agent`, `deliver: local`:
`scripts/mnemosyne-vacuum.sh` prints integrity, working/episodic counts,
size before/after plus `VACUUM`, then per `state.db` (main plus profiles)
counts sessions older than 30 days (`SESSION_MAX_AGE_DAYS`) plus `VACUUM`.
Report only. Session deletion stays owned by
`sessions.auto_prune`/`retention_days` (currently 60); tighten to 30 only by
explicit config change once the 30-day counts show a need.

## Cutover rule

Retire `memory-approve-queue` only when recall is verified across sessions,
`mnemosyne stats` plus sleep are healthy, the SQLite backup restores, and
the approval path is tested. Keep `session_search` and `journey` either way.
