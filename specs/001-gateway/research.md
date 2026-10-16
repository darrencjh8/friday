# Research: Hermes Agent for expense-tracker Migration

**Spec**: 021-hermes-migration
**Date**: 2026-06-17

## Source

Hermes Agent by Nous Research: https://hermes-agent.nousresearch.com/docs/
Repository: https://github.com/NousResearch/hermes-agent

## Key Findings

### 1. Hermes vs OpenClaw — Feature Comparison

| Feature | OpenClaw (current) | Hermes Agent | Notes |
|---------|-------------------|--------------|-------|
| Runtime | Node.js | Python 3 | Hermes is Python, not Node.js. All migration code (MCP adapter) stays Node.js in expense-tracker. |
| Telegram | Built-in channel | Built-in channel | Nearly identical: bot token, allowlist, DM pairing |
| Email | Not native; expense-tracker's IMAP IDLE | Native IMAP/SMTP adapter | Poll-based (15s default), not IMAP IDLE. No dependency needed. |
| Provider config | `openclaw.json` `models.providers` | `~/.hermes/config.yaml` `model:` | DeepSeek works as custom provider with OpenAI-compatible base URL |
| MCP | Not native; plugin bridge via `exec curl` | First-class MCP client | Stdio + HTTP SSE servers. Tool filtering. Utility wrappers. |
| Memory | MEMORY.md + embeddings (expense-tracker) | MEMORY.md + USER.md + session search (SQLite FTS5) | Hermes memory has char limits (2,200 / 1,375). Self-learning loop auto-curates. |
| Sub-agents | orchestrator/thinker (OpenClaw built-in) | `delegate_task` — isolated children, parallel execution | Toolset restrictions, model override, max iterations. More robust than OpenClaw. |
| Cron | Not available | Full cron system | Natural language scheduling, skill-backed jobs, `[SILENT]` suppression, `wakeAgent` gating |
| Docker | Docker Compose with custom Dockerfile | Official Docker image (`nousresearch/hermes-agent:latest`) | Pre-built image with s6-overlay, docker CLI, playwright, ffmpeg |
| Docker socket | Not mounted | docker CLI pre-installed, socket mountable | Agent can run `docker ps`, `docker logs`, `docker compose restart` |
| Security | exec-approvals.json pattern matching | Dangerous command approval (manual/smart/off), hardline blocklist, SSRF protection, tirith scanning | Significantly more comprehensive |
| Skills | SKILL.md files in workspace | SKILL.md with progressive disclosure, Skills Hub, auto-creation | Hermes skills are more sophisticated (agent can create/improve them) |
| Channels | Telegram, WhatsApp | Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Matrix, +12 more | Hermes has 20+ platforms native |
| Dashboard | None | Web dashboard on port 9119 (optional) | OAuth-gated, multi-profile |
| Thinking levels | `off/minimal/low/medium/high/xhigh/adaptive/max` | Model choice + delegation model override | Use `deepseek-flash` for routine work and for the thinker sub-agent |

### 2. Email Channel — IMAP Polling vs IDLE

Hermes uses IMAP polling (15s default interval) rather than IMAP IDLE. Impact assessment:

- **IDLE advantage**: Near-instant notification (sub-second)
- **Polling at 15s**: Maximum 15s delay before email is seen
- **Receipt processing context**: Not time-sensitive — 15s delay is acceptable
- **Resource usage**: Polling uses slightly more IMAP connections, but negligible for a single inbox
- **Verdict**: Acceptable replacement. No migration risk.

### 3. MCP Tool Adapter — Minimal Changes Required

expense-tracker currently has 15 REST endpoints at `/api/tools/*` exposed via Express. The MCP adapter:

- Creates an MCP server using `@modelcontextprotocol/sdk`
- Wraps each REST endpoint as an MCP `tool()` registration
- Uses HTTP SSE transport on the same port (different path: `/mcp`)
- Existing REST endpoints stay unchanged for backward compatibility
- ~100 lines of new code total

Tool naming: MCP prefix becomes `mcp_expense_tracker_<tool_name>` (e.g., `mcp_expense_tracker_fetch_accounts`).

### 4. Memory Migration Strategy

Current: expense-tracker's `MEMORY.md` with `## Facts` section, each fact on its own line.

Target: Hermes `~/.hermes/memories/MEMORY.md` — compact, information-dense entries.

Hermes memory constraints:
- MEMORY.md: 2,200 chars (~800 tokens) limit
- USER.md: 1,375 chars (~500 tokens) limit
- Agent auto-curates (adds/replaces/removes entries)

Migration approach:
1. Read existing `MEMORY.md` facts
2. Consolidate related facts (e.g., 3 separate "project uses X" → 1 comprehensive entry)
3. Write to Hermes format (single-line or compact multi-line entries separated by `§`)
4. Agent self-learning will refine over time

### 5. Self-Debugging via delegate_task

Hermes `delegate_task` spawns isolated child agents with:
- Fresh conversation context (no parent history)
- Restricted toolsets (`terminal` = Docker CLI access)
- Higher iteration limit (100 vs default 50)
- Model override (`deepseek-flash` for deeper analysis)

Key constraints:
- Sub-agents CANNOT auto-execute dangerous commands — approval gate applies
- Sub-agents CANNOT access memory or send messages
- Sub-agents return structured summary to parent
- Parent presents findings and asks for approval before acting

### 6. Daily Auditor via Cron

Hermes cron:
- Natural language scheduling ("every day at 3am")
- Delivery to any platform (Telegram, email, local file)
- `[SILENT]` suppression when healthy
- `wakeAgent` gate for pre-check scripts
- Headless mode (`cron_mode: deny` — blocks dangerous commands in cron context)

Cron jobs run in fresh agent sessions with no chat platform attached. The prompt must be self-contained.

### 7. Docker Image Contents

Official `nousresearch/hermes-agent:latest` ships with:
- Python 3 with all Hermes dependencies
- Node.js + npm (for browser automation and WhatsApp bridge)
- Playwright with Chromium
- ripgrep, ffmpeg, git, xz-utils
- **docker-cli** — pre-installed for Docker socket access
- openssh-client — for SSH terminal backend
- s6-overlay v3 as PID 1 (process supervision)

Container runs as non-root `hermes` user (UID 10000). Docker CLI works because user is in `docker` group.

### 8. Security Model

- Dangerous command approval: manual/smart/off modes
- Hardline blocklist: catastrophic commands blocked regardless of YOLO mode
- docker.sock mount: agent accesses Docker API; command approval still applies
- MCP credential filtering: only safe env vars + explicit config passed to MCP subprocesses
- SSRF protection: private networks, loopback, cloud metadata blocked by default

### 9. Risk Assessment for Migration

| Concern | Finding |
|---------|---------|
| Python dependency (new) | Hermes is the only Python component. All custom code stays Node.js. Docker image is pre-built — no Python knowledge needed. |
| Email polling latency | 15s default. Receipts not time-sensitive. Can reduce to 5s if needed. |
| Memory char limits | 2,200 chars may be tight for 50+ facts. Consolidation during migration is key. Agent self-curation helps. Can increase limits in config. |
| MCP tool latency | HTTP SSE on Docker network = sub-ms overhead. Negligible. |
| DeepSeek compatibility | Works as custom OpenAI-compatible provider. Verified in docs. |
| Docker socket security | Mount with read-only where possible. Hermes approval gate prevents auto-execution of dangerous Docker commands. |

## Verdict

Hermes Agent is a **drop-in replacement** for OpenClaw in the expense-tracker workflow. The migration is ~90% configuration and ~10% thin adapter code. Total new code: ~100 lines (MCP adapter). All other features (email, memory, cron, sub-agents, Docker access) are built-in and require only configuration.
