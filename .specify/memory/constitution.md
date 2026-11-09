# Project Constitution — friday

**Project:** friday — Hermes Agent + Skills
**Version:** 5.0.0
**Last Amended:** 2026-11-09
**Workflow:** Spec-Kit (Spec-Driven Development)

---

## 1. System Identity

### Hermes Agent
The agent runtime is **Hermes Agent** — it runs the official `nousresearch/hermes-agent` image (`modules/hermes/Dockerfile`, `FROM nousresearch/hermes-agent:stable`) with `gateway run`. It is NOT a custom-built companion service. Hermes provides channels (Telegram via Bot API, Slack via Socket Mode), agent orchestration, session management, memory, cron, skills, profiles, and an MCP client. WE provide the skills and tools.

### Expense Tracker
An **LLM-powered expense-tracking agent** that reacts to receipt/transaction emails forwarded to a dedicated burner inbox. It extracts structured transaction data and inserts it into an existing **Actual Budget** instance via its REST API.

### Portfolio Tracker
An **LLM-powered portfolio automation agent** that synchronizes investment data across multiple sources and targets: IBKR flex queries, PDF/email receipts, Actual Budget allocations, Portfolio Performance XML files, and Google Sheets taxonomies.

---

## 2. Non-Negotiable Architecture Principles

### 2.1 We Configure Hermes — We Don't Build It

Hermes provides all infrastructure: channel handlers (Telegram via Bot API, Slack via Socket Mode), webhook verification, agent orchestration, session management, memory, cron, and the MCP client. We configure it — we do not build it.

### 2.2 We Build Skills + Deterministic Tools

| What We Build | Technology | Purpose |
|---|---|---|
| `SKILL.md` | Markdown | LLM instructions |
| Node.js tool servers | Node.js 22 (`src/tools.js`, `src/mcp-server.js`, `src/index.js`) | Deterministic tools over MCP (`/mcp`) and REST (`/tools/*`) |
| Custom `AGENTS.md` | Markdown | Agent personality/behavior guidance |

There is no `openclaw` service and no `tools_api.py`: the old Python tool API is gone.

### 2.3 TDD (Test-Driven Development) — Non-Negotiable

**Every line of implementation code MUST be preceded by a failing test. No exceptions.**

| Step | Description | Requirement |
|---|---|---|
| **RED** | Write a failing test first | Test must fail for expected reason before implementation code is written. Run and confirm failure. |
| **GREEN** | Write the minimum code to pass | Only enough to make the test pass. No extra features, no speculative code. |
| **REFACTOR** | Clean up without changing behavior | Improve code structure, remove duplication. All tests must stay green. |

**Enforcement Rules:**
1. No implementation without a test.
2. Tests must fail first — confirm with `pytest tests/test_<module>.py -v`.
3. All tests must pass — 100% pass rate before marking any task complete.
4. Test isolation — no shared mutable state between tests. Use fixtures and mocks.
5. Test coverage for edge cases — every edge case in spec.md must have a corresponding test.
6. Tests are documentation — descriptive function names (e.g., `test_insert_duplicate_returns_true`).

Config files (`config.yaml`, `SKILL.md`, `docker-compose.yml`) are validated via integration tests and manual review.

### 2.4 Docker-First

```
docker-compose.yml
├── hermes (nousresearch/hermes-agent:stable)  # `gateway run`
│   └── skills/, profiles/, scripts/          # seeded at boot
├── expense-tracker (custom Dockerfile)        # Node.js 22
└── portfolio-tracker (custom Dockerfile)      # Node.js 22 + Java 21 JRE CLI
```

Everything runs in containers. The same `docker-compose.yml` works on any Ubuntu/Docker host.

### 2.5 Memory Budget

Resource limits are declared in `modules/docker-compose.yml` (`mem_limit`); read that file for the authoritative values.

| Container | mem_limit | Notes |
|---|---|---|
| hermes | 4g | Hermes Agent runtime |
| expense-tracker | no `mem_limit` | Node.js 22 + WASM embeddings |
| portfolio-tracker | 512m | Node.js 22 + Java 21 CLI |

### 2.6 Security

- **Hermes authorization:** per-profile secret scopes built from `$HERMES_HOME/.env`; channel allowlists (`TELEGRAM_ALLOWED_USERS`, `SLACK_ALLOWED_USERS`) validated by `deploy.sh` so a deploy cannot start a bot nobody can talk to.
- **Docker network isolation:** Containers only accessible within the Docker Compose internal network — not exposed to host.
- **Secrets management:** All credentials via environment variables in `.env` (excluded from git). Never committed to source control.
- **No database exposure:** SQLite dedup journals are local to each container. Actual Budget's database is never accessed directly — only via its REST API.
- **Burner email isolation:** Email burner inboxes are dedicated, isolated accounts. Compromise does not expose other services.
- **Bot token:** Injected via `${TELEGRAM_BOT_TOKEN}` env var substitution — never committed to git.

### 2.7 Data Integrity

- **Multi-currency:** SGD and MYR budgets supported. Currency detected by LLM from content. Unknown currencies rejected with notification.
- **Duplicate prevention:** SHA-256 hash over key fields checked against local SQLite dedup journal before every insert. Duplicates skipped silently.
- **Idempotency:** IMAP emails marked `\Seen` only after successful processing. Telegram messages tracked by `update_id`. Pipeline safe to re-run.
- **No silent failures:** If LLM cannot confidently parse/classify (ambiguous currency, unknown merchant, missing amount), it calls `notify_user` and skips insertion. Bad data is never pushed.
- **PP XML safety:** Java CLI always writes to backup file first, validates, then atomically replaces. No direct XML manipulation from Node.js.

### 2.8 LLM Agent Principles

- **Tools, not code.** The Node.js layer exposes deterministic tools — LLM chooses which to call and in what order.
- **No hardcoded business rules in Node.js.** All classification, matching, routing, and decision-making delegated to the LLM using live data fetched at runtime.
- **Auditability.** Every LLM decision logged as structured JSON with correlation ID.
- **Memory/learning.** Agent persistently learns mappings via `learn_mapping()` — payees, accounts, taxonomies.
- **Fallback safety:** LLM calls retry (3x for DeepSeek, 1x via the router). On failure, email left unread + notification sent.

### 2.9 Observability

- **Structured JSON-line logging** with fields: `timestamp`, `level`, `correlation_id`, `event`, `data`.
- **Correlation ID:** IMAP `msg_id`, Telegram `update_id`, or scheduled task name carried through full pipeline.
- **No third-party monitoring.** Logs consumed via `docker compose logs`.

---

## 3. Hosting Topology

| Component | Host | Network |
|---|---|---|
| **Hermes Agent** | Production server (Docker) | Internal Docker network; API server `:8642`, webhook `:8644`, Dots `:8788`, browser Webapp `:9120`, reminders `:8300`, Google Tasks OAuth callback `:8299` |
| **Expense-tracker** | Production server (Docker) | Internal Docker network, port 8080; IMAP→Email Provider |
| **Portfolio-tracker** | Production server (Docker) | Internal Docker network, port 8081 |
| **Actual Budget** | Fly.io VM (existing) | Public HTTPS |
| **Portfolio Performance** | Production server (local) | Local filesystem |
| **Email Provider** | Any IMAP provider | Public IMAP |
| **Telegram** | Telegram API | Public HTTPS |
| **Google Sheets** | Google API | Public HTTPS |
| **DeepSeek** | DeepSeek Cloud | LLM inference |

---

## 4. Development Methodology

- **Spec-Kit framework:** All features specified, planned, and tasked in `specs/<NNN-feature-name>/` before implementation.
- **TDD mandatory for all code.**
- **Hermes Agent is installed, not built.** We write skills and tools.
- **Configuration verified against https://hermes-agent.nousresearch.com/docs/user-guide/configuration** before changes.

---

## 5. Amendment Process

- This constitution can only be amended by re-running `/speckit.constitution`.
- Changes must be reflected in all downstream artifacts (spec, plan, tasks) of affected features.

**Version**: 5.0.0 | **Ratified**: 2025-06-05 | **Last Amended**: 2026-11-09
