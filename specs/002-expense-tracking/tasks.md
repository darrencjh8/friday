# Implementation Tasks: Automated Expense Tracking

**Feature:** expense-tracking  
**Tasks Version:** 1.0.0  
**Status:** Done (HISTORICAL — Python prototype)  
**Constitution Hash:** v1.0.0  

> **Historical.** Python prototype task ledger (all completed). The module is now **Node.js** — file names and libraries below are outdated. For the current baseline see `spec.md` and `plan.md`; for the code layout see `modules/expense-tracker/docs/design.md`.

---

## Task Dependency Graph

```
Phase 0: Foundation
  T0.1 (Project scaffold)
    │
    ├── T0.2 (Environment config)
    ├── T0.3 (Structured logging)
    └── T0.4 (Dedup journal)
          │
Phase 1: Deterministic Tools (independent, can be parallel)
  ├── T1.1 (Actual Budget client)
  ├── T1.2 (Email extractors)
  ├── T1.3 (IMAP IDLE handler)
  ├── T1.4 (Email notifier)
  └── T1.5 (Tool registry + stubs)
          │
Phase 2: Agent Intelligence
  T2.1 (System prompt + few-shot examples)
  T2.2 (Agent orchestrator)
  T2.3 (DeepSeek integration)
          │
Phase 3: Integration & Deploy
  T3.1 (main.py entry point)
  T3.2 (Dockerfile + fly.toml)
  T3.3 (Integration tests)
  T3.4 (README + .env.example)
```

---

## Phase 0: Foundation

### T0.1 — Project Scaffold

**Priority:** P0 (blocker)  
**Estimate:** 15 minutes  
**Depends On:** None

- [x] Create `pyproject.toml` or `requirements.txt` with pinned dependencies:
  - `openai>=1.0` (DeepSeek-compatible client)
  - `aioimaplib>=1.0`
  - `aiohttp>=3.9`
  - `beautifulsoup4>=4.12`
  - `lxml>=5.0`
  - `python-dotenv>=1.0`
  - `pytesseract>=0.3` (optional; PDF support)
  - `pdf2image>=1.16` (optional; PDF support)
  - `pytest>=8.0`, `pytest-asyncio>=0.23`, `pytest-mock>=3.12` (dev)
- [x] Create `src/__init__.py`, `src/agent/__init__.py`, `src/imap/__init__.py`, `src/extractors/__init__.py`, `src/client/__init__.py`, `src/notifier/__init__.py`, `src/utils/__init__.py`
- [x] Create `tests/__init__.py`
- [x] Create `.gitignore` (Python template + `.env` + `data/` + `__pycache__` + `*.pyc`)
- [x] Create `config/` directory with placeholder `.gitkeep`

**Validation:** `python -c "import src"` succeeds. `pip install -r requirements.txt` completes without errors.

---

### T0.2 — Environment Configuration

**Priority:** P0 (blocker)  
**Estimate:** 20 minutes  
**Depends On:** T0.1

- [x] Create `.env.example` with ALL variables from plan.md Section 9 (commented with descriptions)
- [x] Implement `src/config.py`:
  - Load `.env` via `python-dotenv`
  - Validate required variables on startup; raise clear error messages for missing vars
  - Expose typed config object: `Config` dataclass with fields for all env vars
- [x] Write `config/email_config.json` (minimal: `{"imap_host": "imap.example.com", "imap_port": 993}`)
- [x] Config loads from `.env` (no JSON configs needed; all settings are env vars)

**Validation:** `python -c "from src.config import Config; Config.from_env()"` raises clear error for missing variables. `.env.example` has a line for every variable.

---

### T0.3 — Structured Logging

**Priority:** P0 (blocker)  
**Estimate:** 15 minutes  
**Depends On:** T0.1

- [x] Implement `src/utils/logging.py`:
  - `setup_logging(level: str)` function: configures root logger with JSON-line format to stdout
  - `get_logger(name: str)` function: returns logger with `correlation_id` in extra
  - Log format: `{"timestamp": "...", "level": "INFO", "logger": "src.agent", "correlation_id": "<msg_id>", "event": "email_processed", "data": {...}}`
- [x] No third-party logging libraries; use stdlib `logging` + `json`

**Validation:** `python -c "from src.utils.logging import setup_logging; setup_logging('DEBUG')"` prints a JSON-line log message.

---

### T0.4 — Dedup Journal

**Priority:** P0 (blocker)  
**Estimate:** 30 minutes  
**Depends On:** T0.1, T0.2

- [x] Implement `src/utils/dedup.py`:
  - `DedupJournal` class with SQLite backend
  - `__init__(db_path: str)`: creates table + index on first run (schema from plan.md Section 8)
  - `check(date, amount_cents, account_id, merchant) -> bool`: returns True if duplicate exists
  - `record(date, amount_cents, account_id, merchant, msg_id)`: inserts hash + metadata
  - `compute_hash(date, amount_cents, account_id, merchant) -> str`: SHA-256 helper
  - Thread-safe (use `sqlite3.connect` with `check_same_thread=False` and a lock)
- [x] Write `tests/test_dedup.py`:
  - Test: insert → check returns True
  - Test: different amount → check returns False
  - Test: same logical transaction, different whitespace in merchant → check returns True (normalized)
  - Test: hash computation is deterministic

**Validation:** `pytest tests/test_dedup.py -v` passes all 4 tests.

---

## Phase 1: Deterministic Tools

### T1.1 — Actual Budget REST Client

**Priority:** P0 (blocker)  
**Estimate:** 1 hour  
**Depends On:** T0.2, T0.3

- [x] Implement `src/client/actual_client.py`:
  - Thin HTTP wrapper that delegates to the official `actual-api` Node.js service
  - Uses `@actual-app/api` (JavaScript) with WebSocket-based sync — no HTTP proxy timeout
  - Service runs as a separate Docker container at `actual-api:3000`
  - Python client calls REST endpoints on actual-api, which handles Actual Budget protocol natively
- [x] Write `tests/test_actual_client.py`:
  - Test: mock aiohttp responses, verify correct URL construction
  - Test: retry on 503, 3rd attempt succeeds
  - Test: 404 raises ActualBudgetError
  - Test: network timeout triggers retry

**Validation:** `pytest tests/test_actual_client.py -v` passes all 4 tests.

---

### T1.2 — Email Content Extractors

**Priority:** P1 (high)  
**Estimate:** 45 minutes  
**Depends On:** T0.1

- [x] Implement `src/extractors/html_extractor.py`:
  - `extract_html(html_content: str) -> str`: BeautifulSoup, strip tags, get text, preserve line breaks
- [x] Implement `src/extractors/pdf_extractor.py`:
  - `extract_pdf(pdf_bytes: bytes) -> str`: pdf2image → pytesseract → text
  - Graceful degradation: if tesseract not installed, return `[PDF_OCR_UNAVAILABLE]`
- [x] Implement `src/extractors/text_cleaner.py`:
  - `clean_text(text: str) -> str`: normalize whitespace, strip email signatures (regex for `--\n` and common signature patterns), trim length to 4000 chars max
- [x] Implement `src/extractors/__init__.py` with `extract_email_content(msg: email.message.Message) -> str`:
  - Inspect MIME structure: multipart/alternative → prefer text/plain, fallback to text/html
  - Handle multipart/mixed with attachments
  - Return cleaned text content
- [x] Write `tests/test_extractors.py`:
  - Test: HTML email → clean text, no tags
  - Test: Plain text email → passes through
  - Test: Multipart with HTML only → extracts text
  - Test: Text cleaner strips `--` signature blocks

**Validation:** `pytest tests/test_extractors.py -v` passes all 4 tests.

---

### T1.3 — IMAP IDLE Handler

**Priority:** P1 (high)  
**Estimate:** 1.5 hours  
**Depends On:** T0.2, T0.3

- [x] Implement `src/imap/idle_handler.py`:
  - `ImapIdleHandler` class:
    - `__init__(host, port, username, password)`
    - `async connect()`: establish SSL connection, login, select INBOX
    - `async fetch_unread() -> list[dict]`: fetch all unseen emails, return `[{msg_id, from, subject, date, raw_email}]`
    - `async mark_read(msg_id)`: set `\Seen` flag
    - `async idle_loop(callback: Callable)`: enter IDLE, invoke callback for each new email, auto-reconnect on disconnect
  - IDLE timeout: 5 minutes (re-issue IDLE to keep connection alive)
  - On reconnect: fetch unread emails before entering IDLE (catch-up)
  - Structured logging with IMAP lifecycle events
- [x] Write `tests/test_imap_handler.py`:
  - Test: fetch_unread returns properly structured list (mock aioimaplib)
  - Test: mark_read calls store with `+FLAGS (\Seen)`
  - Test: idle_loop invokes callback when server sends EXISTS
  - Test: disconnect triggers reconnect + catch-up fetch

**Validation:** `pytest tests/test_imap_handler.py -v` passes all 4 tests.

---

### T1.4 — Email Notifier

**Priority:** P1 (high)  
**Estimate:** 30 minutes  
**Depends On:** T0.2

- [x] Implement `src/notifier/email_notifier.py`:
  - `EmailNotifier` class:
    - `__init__(smtp_host, smtp_port, username, password, recipient_email)`
    - `async send(subject, body)`: connect SMTP (STARTTLS), send email, disconnect
    - Format: HTML email with clear "OpenClaw Notification" branding
  - Non-blocking: run in executor thread to avoid blocking async loop
- [x] Write `tests/test_notifier.py`:
  - Test: send constructs correct MIME message (mock smtplib)
  - Test: STARTTLS is called before login
  - Test: subject and recipient match config

**Validation:** `pytest tests/test_notifier.py -v` passes all 3 tests.

---

### T1.5 — Tool Registry & Stubs

**Priority:** P1 (high)  
**Estimate:** 45 minutes  
**Depends On:** T1.1, T1.2, T1.3, T1.4

- [x] Implement `src/agent/tools.py`:
  - `ToolRegistry` class that holds tool function definitions and their JSON schemas
  - Each tool is an `async def` function with typed parameters
  - `execute_tool(name, arguments) -> dict` dispatcher
  - `get_tool_schemas() -> list[dict]` returns OpenAI-compatible function definitions
  - All 10 tools implemented:
    1. `extract_email_content(include_headers: bool = True) -> str`
    2. `fetch_accounts(budget_id: str) -> list[dict]`
    3. `fetch_categories(budget_id: str) -> list[dict]`
    4. `fetch_payees(budget_id: str) -> list[dict]`
    5. `fetch_recent_transactions(budget_id: str, account_id: str, days: int = 7) -> list[dict]`
    6. `insert_transaction(budget_id, account_id, date, amount_cents, imported_description, category_id=None, notes="") -> dict`
    7. `check_duplicate(date, amount_cents, account_id, merchant) -> bool`
    8. `mark_email_read() -> bool`
    9. `notify_user(subject, body) -> bool`
    10. `log_decision(action, reasoning, transaction_id=None) -> bool`
- [x] Tools that need the current email context receive it via a closure or context object
- [x] Write `tests/test_tools.py`:
  - Test: tool registry returns exactly 10 schemas
  - Test: execute_tool dispatches correctly by name
  - Test: insert_transaction calls ActualBudgetClient.create_transaction with correct args
  - Test: notify_user calls EmailNotifier.send with passed subject/body

**Validation:** `pytest tests/test_tools.py -v` passes all 4 tests.

---

## Phase 2: Agent Intelligence

### T2.1 — System Prompt & Few-Shot Examples

**Priority:** P0 (blocker)  
**Estimate:** 30 minutes  
**Depends On:** None (content only)

- [x] Implement `src/agent/prompts.py`:
  - `SYSTEM_PROMPT` constant: the full system prompt from plan.md Section 5
  - `FEW_SHOT_EXAMPLES` list: 2-3 example conversations showing:
    1. **Happy path:** DBS SGD alert → fetch accounts/categories → match → insert → mark read
    2. **MYR path:** TNG eWallet MYR alert → detect MYR → fetch MYR budget → match → insert
    3. **Uncertain path:** Unknown currency → notify_user
  - Each example is a list of `{"role": "user"|"assistant"|"tool", "content": ...}` messages
  - Developer note: update budget IDs in examples to match your actual MYR budget ID
- [x] No unit tests (content validation is manual review)

**Validation:** `python -c "from src.agent.prompts import SYSTEM_PROMPT; assert 'SGD' in SYSTEM_PROMPT; assert 'MYR' in SYSTEM_PROMPT"`

---

### T2.2 — Agent Orchestrator

**Priority:** P0 (blocker)  
**Estimate:** 1.5 hours  
**Depends On:** T1.5, T2.1

- [x] Implement `src/agent/orchestrator.py`:
  - `AgentOrchestrator` class:
    - `__init__(deepseek_client, tool_registry, dedup_journal)`
    - `async process_email(msg_id, raw_email) -> dict`:
      1. Extract email content via tool
      2. Build conversation: system prompt + few-shot examples + current email
      3. Call DeepSeek with tool definitions
      4. Loop: if LLM returns tool_calls → execute tools → feed results back → repeat (max 5 iterations)
      5. LLM makes final decision → return `{"action": "inserted"|"skipped"|"notified", "details": ...}`
    - `_build_messages(email_content) -> list[dict]`: assembles full message list
    - `_execute_tool_calls(tool_calls) -> list[dict]`: executes all requested tools, returns results
    - Guardrail: max 5 tool-call iterations per email (prevents infinite loops)
    - Guardrail: if LLM calls insert_transaction without calling check_duplicate first → inject warning
    - Correlation ID passed through all log calls
- [x] Write `tests/test_agent_orchestrator.py`:
  - Test: happy path — mock DeepSeek returns tool_calls for fetch → check → insert → mark_read
  - Test: skipped — mock DeepSeek identifies promotional email → calls mark_read only
  - Test: notified — mock DeepSeek detects unknown currency → calls notify_user
  - Test: max iterations exceeded → returns error, logs warning
  - Test: dedup journal check returns True → LLM is told duplicate exists → skips insert

**Validation:** `pytest tests/test_agent_orchestrator.py -v` passes all 5 tests.

---

### T2.3 — DeepSeek Integration

**Priority:** P0 (blocker)  
**Estimate:** 30 minutes  
**Depends On:** T0.2, T2.2

- [x] Implement in `src/agent/orchestrator.py` (or separate `deepseek.py`):
  - `DeepSeekClient` wrapper around `openai.AsyncOpenAI`:
    - `__init__(api_key)`: base URL = `https://api.deepseek.com/v1`
    - `async chat(messages, tools) -> response`: thin wrapper with timeout (30s)
  - Retry logic: 3 retries (1s, 2s, 4s) on API errors
  - Log token usage from response
- [x] No separate test file; tested via orchestrator integration tests

**Validation:** `pytest tests/test_agent_orchestrator.py -v` — DeepSeek client is mocked, verified it's called with correct base URL.

---

## Phase 3: Integration & Deploy

### T3.1 — Entry Point (main.py)

**Priority:** P0 (blocker)  
**Estimate:** 45 minutes  
**Depends On:** T1.5, T2.2

- [x] Implement `src/main.py`:
  - `async def main()`:
    1. Load config
    2. Set up structured logging
    3. Initialize DedupJournal
    4. Initialize ActualBudgetClient (with shared aiohttp session)
    5. Initialize EmailNotifier
    6. Initialize DeepSeekClient
    7. Initialize ToolRegistry (inject all dependencies)
    8. Initialize AgentOrchestrator
    9. Initialize ImapIdleHandler
    10. Start IDLE loop with `agent.process_email` as callback
  - Graceful shutdown: catch SIGINT/SIGTERM, close IMAP connection, close aiohttp session
  - Health check: optional HTTP server on port 8080 (just returns 200 OK for Fly.io health checks)
- [x] `if __name__ == "__main__": asyncio.run(main())`
- [x] `src/__main__.py`: `from src.main import main; asyncio.run(main())`

**Validation:** Manual integration test (requires actual credentials). Stub test verifies import chain works.

---

### T3.2 — Docker Configuration

**Priority:** P0 (blocker)  
**Estimate:** 30 minutes  
**Depends On:** T3.1

- [x] Write `docker/Dockerfile`:
  - Based on `python:3.12-slim`
  - Install system deps: `tesseract-ocr`, `poppler-utils` (for pdf2image)
  - Copy + install `requirements.txt`
  - Copy `src/` and `config/`
  - Create `/app/data` directory
  - Set `CMD ["python", "-m", "src.main"]`
  - Non-root user for security (`user: appuser`)
- [x] Write `../../gateway/docker-compose.yml` with expense-tracker service:
  - Maps port 8080, mounts `.env` and `data/` volume
  - Uses the Dockerfile from docker/
- [x] Ensure `.dockerignore` excludes `.env`, `data/`, `.git/`, `__pycache__/`, `.speckit/`, `tests/`

**Validation:** `docker build -f docker/Dockerfile .` succeeds.

---

### T3.3 — Integration Tests

**Priority:** P1 (high)  
**Estimate:** 1 hour  
**Depends On:** T3.1

- [x] Write `tests/conftest.py`:
  - Fixtures: `mock_actual_budget`, `mock_imap`, `mock_deepseek`, `mock_smtp`
  - Fixture: `sample_sgd_email` (DBS alert), `sample_myr_email` (TNG alert), `sample_promo_email`, `sample_ambiguous_email`
  - Fixture: `test_dedup_db` (temp SQLite file, auto-cleaned)
- [x] Write `tests/test_integration.py`:
  - Test: full pipeline — idle callback → process_email → insert → mark_read (all mocks)
  - Test: promo email → process_email → mark_read, no insert
  - Test: ambiguous currency → process_email → notify_user, email left unread
  - Test: duplicate detection — same email processed twice → second call skips insert
  - Test: API failure → retry → eventual success

**Validation:** `pytest tests/test_integration.py -v` passes all 5 tests.

---

### T3.4 — README & Documentation

**Priority:** P2 (medium)  
**Estimate:** 20 minutes  
**Depends On:** T3.1

- [x] Write `README.md`:
  - Project overview (what OpenClaw does)
  - Architecture diagram (ASCII)
   - Prerequisites: Docker + Docker Compose, DeepSeek API key, IMAP burner account with IMAP enabled, running Actual Budget instance
   - Setup instructions:
     1. Clone repo
     2. Copy `.env.example` to `.env`, fill in all values
     3. Generate a app-specific password (IMAP → Settings → Mail Accounts → IMAP Access)
      4. `./modules/deploy.sh` (from repo root)
     5. Or: `pip install -r requirements.txt && python -m src.main` (local dev)
   - How to set up the burner inbox (step-by-step)
   - How to configure email forwarding from bank/payment apps → burner email
   - How to view logs (`docker compose logs -f expense-tracker`)
  - Known limitations (PDF OCR needs Tesseract, no SMS support)
- [x] Verify `.env.example` includes ALL required variables from plan.md Section 9

**Validation:** Another developer can follow the README and set up the project without asking questions.

---

## Execution Sequence (Ordered)

| Order | Task | Phase | Can Parallelize With |
|---|---|---|---|
| 1 | T0.1 — Project Scaffold | Foundation | — |
| 2 | T0.2 — Environment Config | Foundation | T0.1 |
| 3 | T0.3 — Structured Logging | Foundation | T0.2 |
| 4 | T0.4 — Dedup Journal | Foundation | T0.3 |
| 5 | T1.1 — Actual Budget Client | Tools | T1.2, T1.3 |
| 6 | T1.2 — Email Extractors | Tools | T1.1, T1.3 |
| 7 | T1.3 — IMAP IDLE Handler | Tools | T1.1, T1.2 |
| 8 | T1.4 — Email Notifier | Tools | — |
| 9 | T1.5 — Tool Registry | Tools | After T1.1-T1.4 |
| 10 | T2.1 — System Prompt | Agent | Independent |
| 11 | T2.2 — Agent Orchestrator | Agent | After T1.5, T2.1 |
| 12 | T2.3 — DeepSeek Integration | Agent | After T2.2 |
| 13 | T3.1 — Entry Point | Integration | After T1.5, T2.2 |
| 14 | T3.2 — Docker Config | Integration | After T3.1 |
| 15 | T3.3 — Integration Tests | Integration | After T3.1 |
| 16 | T3.4 — README | Integration | After T3.2 |

---

## Validation Checkpoints

### Checkpoint Alpha: Foundation Complete
Run after T0.1–T0.4:
- [x] `python -c "import src; from src.config import Config; from src.utils.logging import setup_logging; from src.utils.dedup import DedupJournal"`
- [x] `pytest tests/test_dedup.py -v` — all tests pass

### Checkpoint Bravo: Tools Complete
Run after T1.1–T1.5:
- [x] `pytest tests/test_actual_client.py tests/test_extractors.py tests/test_imap_handler.py tests/test_notifier.py tests/test_tools.py -v` — all tests pass
- [x] `python -c "from src.agent.tools import ToolRegistry; r = ToolRegistry(...); assert len(r.get_tool_schemas()) == 10"`

### Checkpoint Charlie: Agent Complete
Run after T2.1–T2.3:
- [x] `pytest tests/test_agent_orchestrator.py -v` — all tests pass
- [x] `python -c "from src.agent.prompts import SYSTEM_PROMPT; print(len(SYSTEM_PROMPT))"` — prompt is non-empty

### Checkpoint Delta: Integration Complete
Run after T3.1–T3.4:
- [x] `pytest tests/ -v` — ALL tests pass (15+ tests)
- [x] `docker build -f docker/Dockerfile .` — builds successfully
- [x] Manual review: README.md is complete and accurate
- [x] Manual review: `.env.example` has all variables from plan.md Section 9

---

## Total Estimated Effort

| Phase | Tasks | Estimate |
|---|---|---|
| Foundation | 4 | 1h 20m |
| Tools | 5 | 5h 45m |
| Agent | 3 | 2h 30m |
| Integration | 4 | 2h 35m |
| **Total** | **16** | **~12 hours** |

---

## Future / Tech Debt

### T4.1 — Consolidate into Node.js (optional)

**Status:** Not planned
**Estimate:** 3–4 hours
**Depends On:** All Phase 3 tasks

Replace the Python expense-tracker with a single Node.js service:
- Use `@actual-app/api` directly (eliminate `tools.py` → HTTP → `actual-api:3000` bridge)
- Replace `aioimaplib` with `node-imap` for IMAP IDLE
- Replace `beautifulsoup4` with `cheerio` for HTML extraction
- Replace `smtplib` with `nodemailer` for notifications
- Port 167 unit tests from pytest to Node.js test framework

Trade-off: single-language stack vs rewriting mature test suite.

### T4.2 — OpenClaw Node Expansion (optional)

**Status:** Not planned
**Estimate:** 1–2 hours
**Depends On:** None (pure OpenClaw config)

Connect a Windows laptop as an OpenClaw node for device capabilities:
- `openclaw node connect --gateway <ubuntu-ip>` from Windows machine
- Node appears in gateway status
- Agent can call `nodes.*` tools (e.g., `nodes.canvas`, `nodes.screen`)
- No code changes required in friday — pure OpenClaw configuration