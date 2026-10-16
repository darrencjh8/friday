# Plan: Hermes Migration (expense-tracker)

**Spec**: 021-hermes-migration
**Status**: Draft

## Summary

Replace OpenClaw Gateway with Nous Research's Hermes Agent for expense-tracker. Hermes provides native Email, Telegram, Memory, Cron, Sub-Agent Delegation, and MCP — all features currently custom-built across OpenClaw + expense-tracker. The only net-new code is a ~100-line MCP adapter in expense-tracker. Everything else is configuration.

## Architecture Target

```
┌───────────────────────────────────────────────────────┐
│                  Docker Compose                        │
│                                                       │
│  ┌───────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │    hermes     │  │expense-tracker│  │ actual-api │  │
│  │  (Python)     │  │  (Node.js)   │  │  (Node.js) │  │
│  │  :8642        │──│  :8080       │  │  :3000      │  │
│  │               │  │              │  │             │  │
│  │ • Telegram ✓  │  │ • MCP server │  │ • AB proxy  │  │
│  │ • Email ✓     │  │ • AB tools   │  │             │  │
│  │ • Memory ✓    │  │ • dedup      │  │             │  │
│  │ • Cron ✓      │  │ • PDF extract│  │             │  │
│  │ • delegate ✓  │  │              │  │             │  │
│  │ • docker.sock │  └──────────────┘  └────────────┘  │
│  └───────────────┘                                     │
│         │ MCP (HTTP SSE)                               │
│         └──────────────────► expense-tracker:8080/mcp  │
│                                                       │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐    │
│  │portfolio-    │  │  ktmb    │  │  image-gen    │    │
│  │tracker :8081 │  │  :8082   │  │  :8083         │   │
│  │ (unchanged)  │  │(unchanged│  │  (unchanged)   │   │
│  └──────────────┘  └──────────┘  └───────────────┘    │
└───────────────────────────────────────────────────────┘
```

## Implementation Phases

| Phase | Description | Tasks | Effort |
|-------|-------------|-------|--------|
| 1 | Local Hermes setup | T001-T006 | 1h |
| 2 | expense-tracker MCP adapter | T007-T014 | 3h |
| 3 | Hermes Docker configuration | T015-T022 | 2h |
| 4 | Memory migration | T023-T028 | 1h |
| 5 | Email end-to-end testing | T029-T037 | 2h |
| 6 | Self-debugging sub-agent | T038-T043 | 2h |
| 7 | Daily log audit cron | T044-T049 | 1h |
| 8 | Production deployment | T050-T058 | 2h |
| 9 | Validation & monitoring | T059-T065 | 48h (passive) |
| 10 | OpenClaw decommission | T066-T076 | 1h |

**Total active work**: ~15 hours + 48h passive validation.

## Key Decisions

1. **Email**: Use Hermes' native IMAP poll adapter (not IMAP IDLE). 15s poll interval acceptable.
2. **MCP transport**: HTTP SSE (not stdio). expense-tracker runs in separate container.
3. **Memory**: Migrate MEMORY.md facts to Hermes memory. Consolidate to fit 2,200 char limit.
4. **Docker access**: Mount `/var/run/docker.sock` for debugger and auditor. Never auto-execute dangerous commands.
5. **Parallel run**: Keep OpenClaw running during 48h validation. Decommission only after confirmed stable.
6. **DeepSeek**: Custom provider config with OpenAI-compatible base URL.

## Files Changed

### New Files
- `gateway/hermes/config.yaml` — Hermes provider, MCP, delegation, cron config
- `gateway/hermes/.env` — API keys, Telegram, Email config
- `gateway/hermes/SOUL.md` — Agent personality
- `gateway/hermes/AGENTS.md` — System prompt with debugging instructions
- `gateway/hermes/memories/MEMORY.md` — Migrated facts
- `gateway/hermes/memories/USER.md` — User profile
- `gateway/hermes/exec-approvals.json` — Docker command allowlist
- `modules/expense-tracker/src/mcp-server.ts` — MCP adapter
- `scripts/migrate-memory.sh` — Memory migration script

### Modified Files
- `gateway/docker-compose.yml` — Add Hermes service, update expense-tracker env
- `modules/expense-tracker/package.json` — Add MCP SDK, remove unused deps
- `modules/expense-tracker/src/index.js` — Start MCP server instead of IMAP loop

### Removed Files
- `gateway/Dockerfile` — OpenClaw Dockerfile
- `gateway/docker-entrypoint.sh` — OpenClaw entrypoint
- `gateway/openclaw.json` — OpenClaw config (archived)
- `gateway/openclaw.json.bk` — OpenClaw config backup (archived)
- `gateway/exec-approvals.json` — OpenClaw approvals (archived)
- `gateway/*.md.template` — OpenClaw prompt templates (archived)
- `gateway/plugins/expense-tracker-tools/` — OpenClaw plugin (replaced by MCP)
- `modules/expense-tracker/src/imap.js` — IMAP moved to Hermes
- `modules/expense-tracker/src/orchestrator.js` — LLM loop moved to Hermes
- `modules/expense-tracker/src/prompts.js` — Prompts moved to Hermes
- `modules/expense-tracker/src/memory.js` — Memory moved to Hermes
- `modules/expense-tracker/src/decision-executor.js` — Execution moved to Hermes
- `modules/expense-tracker/src/payee-resolver.js` — Replaced by Hermes memory
- `modules/expense-tracker/src/keywords.js` — Replaced by Hermes memory
- `modules/expense-tracker/src/classify.js` — Replaced by Hermes NLU

## Rollback Plan

If Hermes fails during validation (Phase 9):
1. Stop Hermes: `docker compose stop hermes`
2. Restore OpenClaw: `docker compose up -d openclaw`
3. expense-tracker MCP adapter is backward-compatible (REST endpoints still work)
4. OpenClaw plugin bridge still functional (archived, not deleted until Phase 10)
5. Memory can be re-migrated from Hermes back to expense-tracker MEMORY.md if needed
