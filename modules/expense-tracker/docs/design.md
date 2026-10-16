# Expense Tracker — Design Document

**Module:** `modules/expense-tracker`  
**Last Updated:** 2026-06-10
**Runtime:** Node.js 22 (ESM) | **LLM:** `auto-thinking` on the codex-router over the Responses API (DeepSeek `deepseek-flash` over Chat Completions as the final fallback) | **Budget:** Actual Budget REST API

For workflow, tool schemas, and deployment, see `.speckit/features/expense-tracking/plan.md` and `.speckit/agent.md`.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Email Burner Inbox                       │
│                   (imap.example.com:993)                        │
└──────────────────────┬──────────────────────────────────────┘
                       │ IMAP IDLE
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  src/imap.js — ImapIdleHandler (imapflow)                   │
│  Persistent IMAP IDLE, auto-reconnect, catch-up fetch        │
└──────────────────────┬──────────────────────────────────────┘
                       │ on_new_email(msg)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  src/classify.js — classifyEmail() / dispatchEmail()        │
│  Lightweight LLM call (no tools):                            │
│    "statement" | "transaction" | "skip"                      │
└──────────────────────┬──────────────────────────────────────┘
                       │ dispatch_email()
                       ▼
        ┌──────────────┼──────────────┐
        │              │              │
     "skip"       "statement"    "transaction"
        │              │              │
        ▼              ▼              ▼
   ┌────────┐  ┌──────────────┐  ┌──────────────────┐
   │ mark   │  │ Statement-   │  │ Agent-           │
   │ read   │  │ Processor    │  │ Orchestrator     │
   │ only   │  │ (statement   │  │ (3-phase:        │
   │        │  │  reconcile)  │  │  analyze→resolve │
   │        │  │              │  │  →execute)       │
   └────────┘  └──────┬───────┘  └────────┬─────────┘
                      │                    │
                      └────────┬───────────┘
                               │ tool calls
                               ▼
                    ┌──────────────────┐
                    │  ToolRegistry    │
                    │  27 MCP / 31 REST│
                    │  tools (:8080)   │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────────────┐
        │ Actual   │  │ SQLite   │  │ Gateway Webhook  │
        │ Budget   │  │ Journals │  │ (notify-webhook  │
        │ API      │  │ (dedup + │  │  :18800)         │
        │          │  │ statement)│  │ → Telegram Bot   │
        └──────────┘  └──────────┘  └──────────────────┘
```

### Cross-Module Relationship

The **portfolio-tracker** module independently monitors the same Email inbox. Both modules share IMAP credentials but serve different purposes:

| Email Type | Expense Tracker | Portfolio Tracker |
|---|---|---|
| DBS/UOB/OCBC transaction alert | Processes via alert pipeline | Ignores |
| Bank/credit card statement | Processes via reconciliation pipeline | Ignores |
| IBKR Activity Flex | **Skips (marks read silently)** | Processes via IBKR import |
| Trade confirmation | **Skips (marks read silently)** | Processes via trade tools |

The expense-tracker's pre-classification returns `"skip"` for IBKR/trade emails, preventing double-processing.

---

## Component Map

> **Implementation note:** This module is **Node.js / JavaScript** (ESM). It was ported from an earlier Python prototype; all `.py` references in older docs are historical.

```
src/
├── index.js App entry: wiring, Express, 31 REST /tools/* routes, MCP server, IMAP
├── config.js Env-var Config class (MEMORY_PATH = data/MEMORY.md)
├── mcp-server.js MCP Streamable HTTP server — 27 server.tool() registrations (28 with learning commands off)
├── orchestrator.js 3-phase alert pipeline (LLM Analysis → Resolution → Execute) + DeepSeekClient
├── prompts.js Phase-1 prompt + category picker prompt
├── tools.js ToolRegistry: tool schemas + handlers (Actual Budget CRUD, dedup, memory, resolve_merchant)
├── memory.js MEMORY.md fact store with WASM semantic embeddings + dedup/cleanup
├── extractors.js MIME-aware email content + PDF text (pdftotext via child_process)
├── imap.js IMAP IDLE (imapflow) + inbox browsing (list/read/extract)
├── classify.js Email pre-classification + dispatch routing
├── dedup.js SHA-256 dedup journal (data/dedup.db)
├── logging.js Structured JSON-line logging
│
└── statement/
    ├── orchestrator.js Statement reconciliation pipeline
    ├── prompts.js Classification + statement prompts
    └── matcher.js fuzzy match: amount/date/merchant scoring
```

The module registers **31 REST `/tools/*` POST endpoints** (`index.js`; 32 with `confirm_learning` mounted, which happens only when learning commands are off) and **27 MCP tools** (`mcp-server.js`; 28 with learning commands off). The tool registry holds 39 tools. `fetch_accounts`, `fetch_categories`, `fetch_payees` and `check_duplicate` are REST-only; `fetch_context` is the MCP entry point for account, category and payee lookups. `check_schedule_collision`, `fetch_schedules` and `submit_decision` are on neither surface. The dedup and statement journals are SQLite (`data/dedup.db`, `data/statement.db`); statement tracking lives in `src/statement/`.

---

## Database Schemas

### Dedup Journal (`data/dedup.db`)

SHA-256 hash computed over: `(date, amount_cents, account_id, payee_name)`

```sql
CREATE TABLE IF NOT EXISTS dedup_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_hash TEXT UNIQUE NOT NULL,
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    payee_name TEXT NOT NULL,
    msg_id TEXT,
    action TEXT DEFAULT 'inserted',
    reasoning TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Statement Journal (`data/statement.db`)

```sql
CREATE TABLE statement_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    budget_id TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    matched_count INTEGER NOT NULL DEFAULT 0,
    outlier_count INTEGER NOT NULL DEFAULT 0,
    total_amount_cents INTEGER,
    due_date TEXT,
    currency TEXT DEFAULT 'SGD',
    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, period_start, period_end)
);

CREATE TABLE statement_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id INTEGER NOT NULL REFERENCES statement_journal(id),
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    ab_transaction_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('reconciled', 'outlier')),
    notes TEXT,
    FOREIGN KEY(statement_id) REFERENCES statement_journal(id)
);
```

### Learned Facts (`data/MEMORY.md`)

Learned mappings are stored as free-form + structured facts in `MEMORY.md` (config key `MEMORY_PATH`, default `data/MEMORY.md`); a lookup tries substring matching first and falls back to WASM semantic embeddings (`src/memory.js`). On first run, the legacy `data/mappings.json` (accounts/payees/categories dictionaries) is migrated into `MEMORY.md` (`index.js:52-61`); `mappings.json` is no longer read afterward.

```
# MEMORY.md (example facts)
- "toast box" maps to Food payee
- Epsilon Nova is a debit card account
- ntuc transactions are Groceries
```

Memory tools: `search_memory`, `learn_fact`, `list_facts`, `update_fact`, `delete_fact`, `compact_facts`, `cleanup_facts`. `search_facts` is an MCP-only alias of `search_memory`.

#### Merchant matching: keys, not similarity (#472)

A structured fact names an entity — `X maps to Y payee`, `X maps to Y category`, `X is a Y account`, or a canonical-suffix fact. Such a fact is authorized by key, never by similarity:

- `MemoryStore._semanticSearch()` skips structured facts before embedding them, and `_acceptSemanticHit()` refuses any that reach it another way, so no cosine score can make a mapping usable.
- `factNamesMerchant(fact, merchant)` accepts exactly two cases: the alert merchant equals the stored key (any length), or the key occurs inside it on a word boundary and is at least `MIN_ENTITY_LENGTH` (3) characters. `AMAZE` therefore does not match `AMAZE* GREATEASTERN`.
- Retrieval is not authorization: `search_memory`'s substring lookup can return structured rows for a loose query, so the code that lets a mapping decide a payee or category filters the rows through `factNamesMerchant` first — `orchestrator.js` (payee resolution, category resolution) and `tools.js` (`_validate_payee`'s insert-time lookup, and `_handle_resolve_merchant`'s raw-merchant → payee fallback). Other readers consume the same rows as raw evidence only: the phase-1 LLM context, `_detectAccountType`, and `identityMappingsFromFacts`, none of which can authorize a mapping on their own.

Consequence, accepted as risk in issue #472: a misspelled or abbreviated merchant that neither equals the stored key nor contains it as whole words can no longer reach that mapping through semantic search. A payee then falls through to web classification when `BRAVE_SEARCH_API_KEY` is configured, and to `Misc` when it is not; a category falls to the LLM picker when a payee was resolved, and otherwise stays uncategorised.

Why the restriction is accepted: measured against the live fact set (238 facts, 159 of them structured — point-in-time, recorded in issue #472; `MEMORY.md` is not tracked in this repo), ranking by embedding similarity put a *different* merchant first for 68 of those 159 keys, and a wrong merchant scored at or above 0.60 for 60 of them. `AMAZE* GREATEASTERN` scored 0.623 against the `AMAZE* ALIPAYPROGRA SINGAPORE SGP` alert, which is the wrong booking that motivated the change. No numeric floor separates those wrong hits from legitimate spelling variants, because the score does not encode "same merchant". A stricter rule would need distinctive-token presence plus a similarity floor, measured before it is trusted; `factNamesMerchant` deliberately has no spelling-variant path, so issue #472's second acceptance box is not triggered.

Pinned by `tests/memory.test.js`: key anchoring (a partial query must not select a neighbour's mapping), the structured-fact refusal (#420, #471), and the free-form similarity floor.

#### Jev classification fallback and user-confirmed learning (#720)

When memory and web search leave a payee unresolved, `src/jev.js` sends the full extracted email (scrubbed of links and long digit runs, no raw MIME headers, no credentials) to TypeSafe `jev-latest` with every eligible payee. Account-transfer payees, `Misc` and `Starting Balance` are never offered. A `choice` call returns best match, runner-up and confidence; a second `noul` call checks that the email itself supports the winner. A weak, unvalidated or failed answer leaves `Misc`. Thresholds start at confidence 0.85, margin 0.3 and evidence 0.8 and are to be calibrated on real traffic. The email is untrusted data, the model has no tools, and the answer must be an exact eligible payee name.

A Jev answer is never written to memory automatically. Phase 3 stores a pending offer (`src/learning.js`, JSON in `state/`, 7-day expiry) and the notification asks "Remember this mapping?" with the exact reference, payee and runner-up. The offer store is on a volume only the tracker mounts (`state/`, not the hermes-shared `data/`); an old `data/pending-learning.json` is moved there once on startup. `decline_learning` discards an offer and neither tool changes the booked transaction. Only `list_pending_learning`, `confirm_learning` and `decline_learning` are routed over HTTP and MCP, and `evidence` is stripped from HTTP `resolve_merchant` calls.

When `TELEGRAM_BOT_TOKEN` and `TELEGRAM_HOME_CHANNEL` are set (the same values Hermes gets, #723), the answer comes from a person, not the model. `src/learning-notify.js` sends the offer itself through Hermes's own bot, `sendMessage` only (Hermes polls that token and Telegram allows one `getUpdates` consumer), as plain text with tappable `/remember_<id>` and `/forget_<id>` commands (the offer id lower-cased). The Hermes plugin `learning-commands` handles those messages in its `pre_gateway_dispatch` hook, before the model sees them, only from the home chat and an allowed user, and calls `POST /learning/answer` with `{id, action}` and `X-Learning-Signature`, a hex HMAC-SHA256 over `<action>:<ID>` keyed by `HMAC-SHA256(TELEGRAM_BOT_TOKEN, "learning-command")` (derived, so there is no new secret; the model never holds the token). A bad or missing signature, or commands mode off, gets 403; an unknown or expired offer gets 404 `{ok:false, reason:"expired"}`. `remember` runs the same write `confirm_learning` used and `forget` discards. The route is not a tool. With commands on, `confirm_learning` is removed from the tool list, the MCP registration and the HTTP routes, and `list_pending_learning` omits offer ids. With them off, behaviour is unchanged.

---

## Test Strategy

**Note:** The figures below ("24 test files, ~4,100 lines, 282 passing") are from the historical Python prototype and are retained only as a coverage reference; the current JS test suite differs.

| Category | What's Tested |
|---|---|
| **Classification** | `_classify_email()` returns correct category; `dispatch_email()` routing logic |
| **Agent Orchestrator** | Orchestrator construction, message building, SYSTEM_PROMPT content, happy-path flow with mocked LLM |
| **Statement Pipeline** | StatementProcessor, fuzzy matcher, journal CRUD, reconcile, fetch-unreconciled, record, history |
| **Tool Registry** | 39 registry tools; 27 MCP tool schemas / 31 REST endpoints; tool dispatch, individual tool handlers |
| **Extractors** | HTML → text, PDF → OCR, MIME multipart extraction, text cleaning |
| **IMAP** | IMAP connect/fetch/mark-read, idle loop with mocks |
| **Dedup Journal** | Hash computation, insert/check cycles, duplicate detection |
| **Config** | Env-var loading, validation, defaults |
| **Integration** | Full pipeline with mocked external dependencies |
| **Setup Validation** | Config file consistency, Dockerfile validity, .env safety |

---

## LLM Transport and Outages

The router serves `auto-thinking` on `/v1/responses` only and no longer translates Chat Completions (#694), so `LLMClient` (`src/orchestrator.js`) and `classifyEmail` (`src/classify.js`) call `responses.create` for every non-DeepSeek route and map messages, tools and results through `src/llm-responses.js`. The direct DeepSeek final fallback stays on `chat.completions` because that API has no Responses endpoint. `LLM_FALLBACK_MODEL` is unset by default; the retired `gpt-5.6-terra` default is gone.

When every route fails with an outage-shaped error (an HTTP status, a connection error or the local timeout), `chat()` throws `LLMUnavailableError`. Truncated, incomplete or empty responses are deterministic for that email and stay a plain error. An `LLMUnavailableError` makes `processEmail` return `llm_unavailable`: the email stays unread, the user gets one notice per email, and `imap.js` records it with a 5 minute retry instead of the 12 hour `RETRY_COOLDOWN_MINUTES`. After 12 consecutive outage retries of one email in a process, the ordinary 12 hour cooldown applies.

## LLM Cost Estimate

| Pipeline | Model | Input Tokens | Output Tokens | Cost/Email |
|---|---|---|---|---|
| Pre-classification | deepseek-flash | ~500 | ~5 | ~$0.00007 |
| Alert (single txn) | deepseek-flash | ~2,000 | ~500 | ~$0.00035 |
| Statement (15 txns) | deepseek-flash | ~6,000 | ~2,500 | ~$0.002 |
| **Monthly (4 stmts + 100 alerts)** | | | | **~$0.11/month** |
