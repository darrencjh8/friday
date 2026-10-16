# Feature Specification: Gateway (Hermes Agent)

**Feature:** gateway
**Spec Version:** 2.0.0
**Status:** Done
**Created:** 2026-06-17
**Constitution Hash:** v4.0.0

---

## Overview

All modules migrated from OpenClaw Gateway to Hermes Agent. Hermes provides Telegram, Email (IMAP), Memory, Cron, MCP — replacing the entire custom OpenClaw stack. The OpenClaw gateway container, `gateway/` directory, and all `openclaw.json` config have been removed.

**Completed**: expense-tracker, portfolio-tracker, ktmb-booking, image-gen.

## Architecture Change

```
BEFORE (OpenClaw)                    AFTER (Hermes)
┌──────────────────────┐      ┌──────────────────────┐
│  openclaw (Node.js)  │      │  hermes (Python)     │
│  • Telegram          │      │  • Telegram ✓ native  │
│  • orchestrator      │      │  • email ✓ native     │
│  • thinker           │      │  • memory ✓ native    │
│  • plugin bridge     │      │  • cron ✓ native      │
│  • SKILL.md files    │      │  • MCP client ✓       │
└──────┬───────────────┘      └──────┬───────────────┘
       │ curl (all tools)             │ MCP (all modules)
       ▼                               ▼
┌──────────────────────┐      ┌──────────────────────┐
│  All modules         │      │  All modules         │
│  • expense-tracker   │      │  • expense-tracker   │
│  • portfolio-tracker │      │  • portfolio-tracker │
│  • ktmb-booking      │      │  • ktmb-booking      │
│  • image-gen         │      │  • image-gen         │
│  HTTP REST + curl    │      │  MCP (Streamable HTTP)│
└──────────────────────┘      └──────────────────────┘
```

All modules expose an MCP server. Hermes connects to each via `mcp_servers` config. No module has its own IMAP, LLM loop, or memory — Hermes owns those concerns.

---

## User Stories

### US-1: Hermes Replaces OpenClaw as the Agent Runtime (Priority: P1) 🎯 MVP

**As the** system operator,
**I want** Hermes Agent to replace the OpenClaw Gateway container,
**So that** I get native email, memory, cron, sub-agent delegation, and MCP support in a single maintained framework.

**Why this priority**: This is the foundation — everything else depends on Hermes being up and routing messages.

**Independent Test**: `docker compose up -d` brings up Hermes. Telegram bot responds to messages. Email channel polls inbox.

**Acceptance Scenarios**:

1. **Given** Hermes is configured with DeepSeek and Telegram, **When** a user sends "hello" via Telegram, **Then** Hermes responds within 10 seconds.
2. **Given** Hermes Email channel is configured, **When** a new email arrives in the monitored inbox, **Then** Hermes processes it within 15 seconds (poll interval).
3. **Given** the OpenClaw container is stopped, **When** `docker compose ps`, **Then** the `hermes` service shows `running` and `openclaw` is absent.

---

### US-2: expense-tracker Exposes Tools via MCP (Priority: P1) 🎯 MVP

**As** Hermes Agent processing an expense-tracking request,
**I want** to call expense-tracker tools via MCP (typed function calls),
**So that** Actual Budget operations (fetch accounts, insert transactions, etc.) are deterministic and reliable.

**Why this priority**: Without MCP tools, Hermes can't interact with Actual Budget. This is the bridge between the agent and the budget.

**Independent Test**: Hermes calls `mcp_expense_tracker_fetch_accounts` and receives a JSON array of AB accounts.

**Acceptance Scenarios**:

1. **Given** the expense-tracker MCP server is running, **When** Hermes connects at startup, **Then** all expense-tracker tools are discovered and registered with `mcp_expense_tracker_*` prefix.
2. **Given** Hermes needs to insert a transaction, **When** it calls `mcp_expense_tracker_insert_transaction`, **Then** the transaction appears in Actual Budget.
3. **Given** a duplicate transaction is attempted, **When** Hermes calls `mcp_expense_tracker_check_duplicate` first, **Then** the duplicate is detected and the insert is skipped.

---

### US-3: Memory Migrated from MEMORY.md to Hermes (Priority: P1)

**As the** system operator,
**I want** existing learned facts from expense-tracker's MEMORY.md migrated to Hermes' memory system,
**So that** the agent retains knowledge of merchants, accounts, categories, and user preferences.

**Why this priority**: Memory is critical for correct transaction classification. Without migration, the agent loses all learned facts and makes bad categorization decisions.

**Independent Test**: Hermes memory contains entries like "Card ending 1888 belongs to Delta Extra credit card" and "TOASTBOX is Dining Out".

**Acceptance Scenarios**:

1. **Given** MEMORY.md contains 50+ learned facts, **When** the migration script runs, **Then** all facts appear in Hermes' `~/.hermes/memories/MEMORY.md` with proper formatting.
2. **Given** a new email from TOASTBOX arrives, **When** Hermes processes it, **Then** the merchant is recognized as "Dining Out" via memory search.
3. **Given** Hermes learns a new fact during processing, **When** the next session starts, **Then** the fact is persisted and injected into the system prompt.

---

### US-4: Email Processing Works End-to-End (Priority: P1)

**As** a user receiving a receipt email,
**I want** Hermes to detect the email, extract the transaction, and insert it into Actual Budget,
**So that** expenses are tracked automatically without manual entry.

**Why this priority**: This is the core workflow. Email → extraction → AB insertion must work before cutover.

**Independent Test**: Send a test receipt email to the burner inbox. Within 30 seconds, the transaction appears in Actual Budget with correct merchant, amount, and category.

**Acceptance Scenarios**:

1. **Given** a receipt email arrives from a known merchant, **When** Hermes processes it, **Then** the transaction is inserted into Actual Budget with the correct account, category, and amount.
2. **Given** a duplicate receipt email arrives, **When** Hermes processes it, **Then** the SHA-256 dedup check prevents duplicate insertion.
3. **Given** an ambiguous email (unknown merchant, missing amount), **When** Hermes processes it, **Then** the user is notified via Telegram (not silently skipped or incorrectly inserted).

---

### US-5: Self-Debugging via Sub-Agent (Priority: P2)

**As** a user experiencing issues,
**I want** to ask Hermes to debug itself by spawning a Thinker sub-agent with Docker access,
**So that** common issues (service down, API errors, memory problems) are diagnosed and resolved without SSH.

**Why this priority**: Self-debugging is a key migration motivator. It reduces operational burden.

**Independent Test**: User says "debug expense-tracker" on Telegram. Hermes spawns a Thinker sub-agent that checks Docker logs, health endpoints, and reports findings.

**Acceptance Scenarios**:

1. **Given** `actual-api` is unhealthy, **When** user says "debug expense-tracker", **Then** Thinker identifies `actual-api` as the root cause and recommends restart.
2. **Given** Thinker recommends restarting `actual-api`, **When** user approves, **Then** Hermes runs `docker compose restart actual-api` and confirms health.
3. **Given** all services are healthy, **When** debugger runs, **Then** Thinker reports "all systems operational" with health check summaries.

---

### US-6: Daily Log Audit via Cron (Priority: P2)

**As** the system operator,
**I want** a daily 3 AM cron job that inspects logs for errors and anomalies,
**So that** I'm proactively notified of issues before they become incidents.

**Why this priority**: Automated oversight reduces the need for manual log checking. Prevents silent failures.

**Independent Test**: After 24 hours of operation, the cron job produces a report in `reports/YYYY-MM-DD.md` and sends a Telegram notification if anomalies found.

**Acceptance Scenarios**:

1. **Given** no errors in the last 24 hours, **When** the auditor runs, **Then** it responds with `[SILENT]` and saves a "no issues" report locally.
2. **Given** expense-tracker returned 5xx errors in the last 24 hours, **When** the auditor runs, **Then** it sends a Telegram notification with error count, affected tools, and timestamps.
3. **Given** memory usage exceeded 80%, **When** the auditor runs, **Then** it flags the memory warning with current usage stats.

---

### US-7: Clean Shutdown of OpenClaw (Priority: P3)

**As** the system operator,
**I want** OpenClaw decommissioned cleanly after Hermes is validated,
**So that** there are no orphan containers, configs, or stale code.

**Why this priority**: Cleanup is important but non-blocking. Can happen after migration is stable.

**Independent Test**: `docker compose ps` shows `hermes`, `expense-tracker`, `actual-api` only. No `openclaw` service. Stale OpenClaw configs archived.

**Acceptance Scenarios**:

1. **Given** Hermes has been stable for 48 hours, **When** OpenClaw service is removed from docker-compose.yml, **Then** `docker compose up -d` starts only Hermes + expense-tracker + actual-api.
2. **Given** OpenClaw configs are no longer needed, **When** cleanup runs, **Then** `openclaw.json`, `exec-approvals.json`, template files are archived to `archive/openclaw/`.
3. **Given** `gateway/plugins/expense-tracker-tools/` is no longer needed, **When** cleanup runs, **Then** the plugin directory is removed (replaced by MCP adapter in expense-tracker).

---

## Success Criteria

| # | Criterion | How Measured |
|---|-----------|-------------|
| SC-001 | Receipt email → transaction in AB within 30s | End-to-end timing test |
| SC-002 | Zero `exec curl` calls for expense-tracker operations | Hermes tool-call logs |
| SC-003 | All 13 AB tools callable via MCP | `hermes mcp test expense-tracker` |
| SC-004 | 100% of MEMORY.md facts migrated | `wc -l` comparison pre/post |
| SC-005 | Daily auditor runs without error for 7 consecutive days | Cron job history |
| SC-006 | Self-debugger correctly diagnoses a simulated failure | Manual test: stop actual-api, trigger debug |
| SC-007 | No duplicated transactions during cutover | Dedup journal audit |
| SC-008 | Telegram response time < 5s for simple queries | Latency measurement |
| SC-009 | Zero regression in portfolio-tracker, ktmb, image-gen | docker compose ps shows all healthy |
| SC-010 | OpenClaw container fully decommissioned | docker compose ps shows no `openclaw` service |

---

## Out of Scope

- Browser CDP/web browsing (removed with OpenClaw)
- Voice mode
- Multi-profile setup
- Dashboard

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Email polling misses IMAP IDLE real-time behavior | Low | Low | 15s poll interval; receipts aren't time-sensitive beyond 30s |
| Memory migration loses semantic relationships | Medium | Medium | Manual review of migrated facts; test with known merchants |
| MCP SSE transport adds latency | Low | Low | Docker network = sub-ms overhead per tool call |
| Hermes Python runtime unfamiliar | Low | Medium | Extensive docs; no custom Python code needed beyond config |
| DeepSeek provider config mismatch | Low | High | Verify with `hermes chat` before production; DeepSeek is OpenAI-compatible |
| Docker socket security | Low | Medium | Mount read-only where possible; Hermes security model + approval gate |

---

## References

- Hermes Agent Docs: https://hermes-agent.nousresearch.com/docs/
- Hermes Docker: https://hermes-agent.nousresearch.com/docs/user-guide/docker
- Hermes Email: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/email
- Hermes MCP: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- Hermes Memory: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
- Hermes Cron: https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
- Hermes Delegation: https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- Hermes Security: https://hermes-agent.nousresearch.com/docs/user-guide/security
- Hermes MCP Guide: https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes
- GitHub: https://github.com/NousResearch/hermes-agent
