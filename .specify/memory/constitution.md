# Project Constitution — friday

**Project:** friday — OpenClaw Gateway + Skills  
**Version:** 4.0.0  
**Last Amended:** 2026-06-09  
**Workflow:** Spec-Kit (Spec-Driven Development)

---

## 1. System Identity

### Gateway
The gateway is an **OpenClaw Gateway deployment** — it runs the official `openclaw` Node.js gateway (https://openclaw.ai) on Ubuntu/Docker, loaded with custom skills. It is NOT a custom-built companion service. The gateway provides channels (WhatsApp/Telegram/WebChat), agent orchestration, session management, and tool calling. WE provide the skills and tools.

The gateway can be joined by **OpenClaw nodes** — separate machines (Windows/macOS/iOS/Android) that connect via WebSocket and expose device capabilities (camera, screen capture, canvas, voice).

### Expense Tracker
An **LLM-powered expense-tracking agent** that reacts to receipt/transaction emails forwarded to a dedicated burner inbox. It extracts structured transaction data and inserts it into an existing **Actual Budget** instance via its REST API.

### Portfolio Tracker
An **LLM-powered portfolio automation agent** that synchronizes investment data across multiple sources and targets: IBKR flex queries, PDF/email receipts, Actual Budget allocations, Portfolio Performance XML files, and Google Sheets taxonomies.

---

## 2. Non-Negotiable Architecture Principles

### 2.1 We Configure OpenClaw — We Don't Build It

The OpenClaw Gateway provides all infrastructure: channel handlers (Telegram via Bot API), webhook verification, agent orchestration, DM pairing, session management, logging, and graceful shutdown. We configure it — we do not build it.

### 2.2 We Build Skills + Deterministic Tools

| What We Build | Technology | Purpose |
|---|---|---|
| `SKILL.md` | Markdown | LLM instructions |
| `SKILL.js` | Node.js | Async functions → HTTP calls to Python tool API |
| `tools_api.py` | Python (aiohttp) | HTTP endpoints for each deterministic tool |
| Custom `AGENTS.md` | Markdown | Agent personality/behavior guidance |

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

Config files (`openclaw.json`, `SKILL.md`, `docker-compose.yml`) are validated via integration tests and manual review.

### 2.4 Docker-First

```
docker-compose.yml
├── openclaw (openclaw:latest)         # GitHub container registry
│   └── skills/expense-tracker/        # volume-mounted
├── expense-tracker (custom Dockerfile) # Python 3.12 + tools_api.py
└── portfolio-tracker (custom Dockerfile) # Python 3.12 + Java 17 CLI
```

Everything runs in containers. The same `docker-compose.yml` works on any Ubuntu/Docker host.

### 2.5 Memory Budget

| Container | RAM | Notes |
|---|---|---|
| openclaw | ~400MB | Gateway + agent session |
| expense-tracker | ~100MB | Node.js 22-slim + WASM embeddings |
| portfolio-tracker | ~150MB | Node.js 22-slim + Java CLI |
| **Total** | **~900MB** | |

### 2.6 Security

- **Gateway security:** OpenClaw's built-in DM pairing (`dmPolicy="allowlist"`), sandboxing (`non-main` sessions), and channel allowlists.
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
- **PP XML safety:** Java CLI always writes to backup file first, validates, then atomically replaces. No direct XML manipulation from Python.

### 2.8 LLM Agent Principles

- **Tools, not code.** Python layer exposes deterministic tools — LLM chooses which to call and in what order.
- **No hardcoded business rules in Python.** All classification, matching, routing, and decision-making delegated to the LLM using live data fetched at runtime.
- **Auditability.** Every LLM decision logged as structured JSON with correlation ID.
- **Memory/learning.** Agent persistently learns mappings via `learn_mapping()` — payees, accounts, taxonomies.
- **Fallback safety:** DeepSeek API retries 3x with exponential backoff. On failure, email left unread + notification sent.

### 2.9 Observability

- **Structured JSON-line logging** with fields: `timestamp`, `level`, `correlation_id`, `event`, `data`.
- **Correlation ID:** IMAP `msg_id`, Telegram `update_id`, or scheduled task name carried through full pipeline.
- **No third-party monitoring.** Logs consumed via `docker compose logs`.

---

## 3. Hosting Topology

| Component | Host | Network |
|---|---|---|
| **OpenClaw Gateway** | Ubuntu laptop (Docker) | Internal Docker network, port 18789 |
| **Expense-tracker** | Ubuntu laptop (Docker) | Internal Docker network, port 8080; IMAP→Email Provider |
| **Portfolio-tracker** | Ubuntu laptop (Docker) | Internal Docker network, port 8081 |
| **Actual Budget** | Fly.io VM (existing) | Public HTTPS |
| **Portfolio Performance** | Ubuntu laptop (local) | Local filesystem |
| **Email Provider** | Any IMAP provider | Public IMAP |
| **Telegram** | Telegram API | Public HTTPS |
| **Google Sheets** | Google API | Public HTTPS |
| **DeepSeek** | DeepSeek Cloud | LLM inference |
| **Windows Node** (future) | Windows laptop | Canvas, camera, screen, voice |

---

## 4. Development Methodology

- **Spec-Kit framework:** All features specified, planned, and tasked in `specs/<NNN-feature-name>/` before implementation.
- **TDD mandatory for all code.**
- **OpenClaw Gateway is installed, not built.** We write skills and tools.
- **Configuration verified against https://docs.openclaw.ai/** before changes.

---

## 5. Amendment Process

- This constitution can only be amended by re-running `/speckit.constitution`.
- Changes must be reflected in all downstream artifacts (spec, plan, tasks) of affected features.

**Version**: 4.0.0 | **Ratified**: 2025-06-05 | **Last Amended**: 2026-06-09
