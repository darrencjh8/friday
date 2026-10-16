# Technical Plan: Credit Card Statement Reconciliation

**Feature:** statement-reconciliation
**Plan Version:** 3.0.0
**Status:** Implemented (Node.js, migrated spec 012)
**Constitution Hash:** v2.0.0

---

## 1. Technology Stack

Post-migration (spec 012), the expense-tracker is Node.js. No Python remains.

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 24 (ESM) | Spec 012 migration — `"type": "module"` |
| LLM (all pipelines) | DeepSeek `deepseek-flash` | Real API model name. Thinking level controls depth (`low` for statements, not used for classification) |
| DB | `better-sqlite3` | Same pattern as dedup journal (migrated from Python sqlite3) |
| HTTP | `fetch` (built-in) | Calls actual-api proxy at `http://actual-api:3000` |
| PDF extraction | `pdftotext` (poppler-utils) | CLI tool, called via `execFile`. For encrypted PDFs: `qpdf --password=... --decrypt` pipe |
| Logging | `console.log` (JSON-line) | Same JSON-line format as pre-migration |
| Container | Docker Compose (existing) | No new services |
| Test runner | `vitest` | Spec 012 migration — all tests are `.test.js` files |

---

## 2. Architecture: Parallel Pipelines, Shared Infrastructure

```
index.js: onNewEmail(msg)
    │
    ├── 1. classifyEmail() — LLM pre-classification (deepseek-flash, no tools)
    │       "Classify: 'statement', 'transaction', or 'skip'"
    │
    ├── "transaction" → AgentOrchestrator.processEmail()
    │                    (EXISTING — alert pipeline, unchanged)
    │
    ├── "skip" → mark_email_read() (trade emails, ignored)
    │
    └── "statement"  → StatementProcessor.processStatement()
                         (NEW — deepseek-flash, thinking=low, max 20 iterations)
```

### Dispatch Diagram

```
Email → classifyEmail() → dispatch()
                │
    "transaction"  "statement"      "skip"
          │            │               │
    AgentOrchestrator  StatementProcessor  markRead
    (5 iter max)      (20 iter max)
```

---

## 3. Statement Processing Sequence

```
Statement email dispatched
    │
    ▼
StatementProcessor.processStatement() — model: deepseek-flash, thinking=low
    │
    ├── Turn 1: Extract metadata + transactions
    │   tool_calls: [extract_email_content, fetch_statement_history]
    │     fetch_statement_history → NOT FOUND → proceed
    │     (if FOUND → notify duplicate → mark_read → stop)
    │     (if PDF_ENCRYPTED → search_memory for password → retry extract)
    │
    ├── Turn 2: Fetch account + uncleared AB txns for matching
    │   tool_calls: [fetch_accounts, fetch_unreconciled_transactions(account_id, date_from, date_to)]
    │     → GET /transactions?account_id=X&cleared=false&since_date=Y&until_date=Z
    │
    ├── Turns 3-N: For EACH statement line item:
    │   │
    │   │  LLM evaluates fuzzy_match() results:
    │   │
    │   │  MATCH (score ≥ 50):
    │   │    reconcile_transaction(ab_txn_id, "Statement May 2026")
    │   │    → POST /transactions/:id/clear
    │   │    → actual.updateTransaction(id, { cleared: true, notes: "... | Statement May 2026" })
    │   │
    │   │  OUTLIER (no candidate):
    │   │    check_statement_duplicate(date, amount_cents, account_id)
    │   │    insert_transaction(account_id, date, amount_cents, description,
    │   │                       notes="OUTLIER | Statement May 2026")
    │   │
    │   │  (LLM may batch: multiple tool_calls in one turn for independent items)
    │
    └── Final turn: record + notify + mark_read
        tool_calls: [record_statement(...), notify_user(...), mark_email_read()]
          → INSERT statement.db
          → Telegram notification via gateway hook: "✅ X reconciled, ⚠️ Y outliers: [list]"
          → IMAP \Seen flag

On failure (any step):
    → notify_user("Failed: [error]")
    → mark_email_read()
    → log error
```

---

## 4. Fuzzy Matching Algorithm

`src/statement/matcher.js` — `fuzzyMatch(stmtDate, stmtAmountCents, stmtDescription, unclearedTxns) → list[dict]`

| Signal | Weight | Condition |
|---|---|---|
| Amount exact | **80** | abs(ab_amount - stmt_amount) === 0 |
| Amount within ±20c | **50** | abs(ab_amount - stmt_amount) <= 20 |
| Date exact same day | **30** | dateDiff === 0 |
| Date within ±2 days | **15** | dateDiff <= 2 |
| Merchant token overlap > 0.5 | **20** | Jaccard sim of word tokens |

- Minimum threshold: 50 to be considered a candidate match
- Returns top 3 candidates sorted by score descending
- Payee/description comparison is case-insensitive, whitespace-normalized
- LLM selects which candidate (if any) is the correct match

---

## 5. New Tools (5 statement tools, 21 total)

| # | Tool | Pipeline | Schema |
|---|---|---|---|
| 12 | `fetch_unreconciled_transactions` | Statement | `account_id: str, date_from: str, date_to: str, budget_id?: str` → `list[dict]` |
| 13 | `reconcile_transaction` | Statement | `ab_transaction_id: str, statement_ref?: str, budget_id?: str` → `dict` |
| 14 | `record_statement` | Statement | `account_id: str, period_start: str, period_end: str, matched_count: int, outlier_count: int, budget_id?: str, total_amount_cents?: int, due_date?: str, currency?: str` → `dict` |
| 15 | `fetch_statement_history` | Statement | `account_id: str, period_start: str, period_end: str` → `dict | null` |
| 16 | `check_statement_duplicate` | Statement | `date: str, amount_cents: int, account_id: str` → `bool` |

Existing 16 alert tools are **unchanged** and shared by both pipelines.

> **Note**: `check_statement_duplicate` differs from `check_duplicate` — it ignores payee name
> (statements may use different merchant names than alerts). See tasks.md T4.6 for potential consolidation.

---

## 6. Statement Journal Schema

`data/statement.db` — separate from `data/dedup.db`:

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

---

## 7. actual-api Changes

Modify ONLY `gateway/actual-api/server.js` (the deployed version):

### 7.1 New endpoint: POST `/transactions/:id/clear`

```javascript
app.post("/transactions/:id/clear", async (req, res) => {
  try {
    await ensureBudget(getBudgetId(req));
    const txn = await actual.getTransaction(req.params.id);
    if (!txn) return res.status(404).json({ error: "Transaction not found" });
    const { notes } = req.body || {};
    if (notes) txn.notes = (txn.notes || '') + ' | ' + notes;
    txn.cleared = true;
    await actual.updateTransaction(req.params.id, txn);
    res.json({ status: "cleared", id: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

### 7.2 Enhanced GET `/transactions`

Add `cleared`, `since_date`, and `until_date` query param support:

```javascript
app.get("/transactions", async (req, res) => {
  try {
    await ensureBudget(getBudgetId(req));
    const { account_id, cleared, since_date, until_date } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const start = since_date || "2020-01-01";
    const end = until_date || today;
    let txns = await actual.getTransactions(account_id || undefined, start, end);
    if (cleared === "false") txns = txns.filter(t => !t.cleared);
    res.json(txns);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
```

---

## 8. System Prompts

### 8.1 Pre-Classification Prompt (deepseek-flash, no tools)

Located in `src/classify.js` as `CLASSIFICATION_PROMPT`.

Classifies emails into "statement", "transaction", or "skip":
- "statement" → Statement reconciliation pipeline
- "transaction" → Existing alert pipeline (unchanged)
- "skip" → IBKR trades, portfolio reports → silently marked read

### 8.2 Statement Reconciliation Prompt (deepseek-flash, thinking=low)

Located in `src/statement/prompts.js` as `STATEMENT_PROMPT`.

Core rules:
1. Extract ALL transactions from the statement text
2. Identify: statement period (start/end), account name, currency
3. fetch_statement_history (check duplicate period) + fetch_accounts
4. fetch_unreconciled_transactions(account_id, period_start, period_end)
5. For EACH statement line item:
   a. Call fuzzy_match to find candidate matches
   b. MATCH → reconcile_transaction(ab_txn_id, "Statement [period]")
   c. OUTLIER → check_statement_duplicate → insert_transaction with notes="OUTLIER | Statement [period]"
6. After ALL items → record_statement + notify_user + mark_email_read
7. On any failure → notify_user + mark_email_read

**Password recovery** (Phase 4):
- If extract_email_content returns `[PDF_ENCRYPTED]` → search_memory for "statement password"
- If found → retry extraction with password; if not → check email body → ask user
- After successful extraction → learn_fact to store password

Currency routing: SGD → "My Budget", MYR → "My MYR Budget" (via ACTUAL_PRIMARY_BUDGET_FILE / ACTUAL_SECONDARY_BUDGET_FILE env vars).

### 8.3 Portfolio Tracker Prompt — Missing-PDF Rule (deepseek-flash, thinking=low)

Located in `modules/portfolio-tracker/src/prompts.js` as `SYSTEM_PROMPT`.

Add one rule after existing rule 12:

```
13. If extract_email_content() returns text without trade/transaction
    data AND no PDF is attached → call notify_user() asking the
    user to forward the PDF via Telegram.
```

**Why no `mark_email_read` in the prompt:** The portfolio tracker's `dispatchEmail()`
(`modules/portfolio-tracker/src/classify.js`, lines 75-83) always calls
`imapHandler.markRead()` in a `finally` block after the orchestrator returns.
Email read-marking is guaranteed by the framework, not the LLM.

**Corresponding SKILL.md change** (`gateway/workspace/skills/portfolio-tracker/SKILL.md`):

Add a `## Trade Email with Missing PDF` section:

```markdown
## Trade Email with Missing PDF

If a trade email arrives with no PDF attachment → call notify-user asking
the user to forward the PDF via Telegram. The email is marked read
automatically by the dispatch wrapper.

User forwards PDF via Telegram → gateway activates this skill:
  1. Call extract-pdf-text(pdf_bytes_b64=<base64 from gateway>)
  2. Match securities by ISIN/ticker (as normal trade workflow)
  3. Call check-duplicate → insert-pp-transaction
  4. Call notify-user with summary
  5. Call learn-mapping for each match
```

**Corresponding .env.example change** (`modules/portfolio-tracker/.env.example`):

Relocate `IMAP_FOLDER=Trades` from the `# --- Telegram ---` section to the
`# --- IMAP Email ---` section (uncomment it). It currently exists commented
out in the wrong section.

---

## 9. File Skeleton (Node.js, post-migration)

```
modules/expense-tracker/
├── src/
│   ├── statement/                    (4 files)
│   │   ├── orchestrator.js           StatementProcessor (deepseek-flash, thinking=low, 20 iter)
│   │   ├── prompts.js                STATEMENT_PROMPT + STATEMENT_FEW_SHOT
│   │   └── matcher.js                fuzzyMatch()
│   ├── index.js                      MODIFIED (+statement pipeline wiring, +imapMailbox)
│   ├── tools.js                      MODIFIED (+StatementJournal class, +5 tool handlers/schemas)
│   ├── classify.js                   CLASSIFICATION_PROMPT + classifyEmail() + dispatchEmail()
│   ├── orchestrator.js               AgentOrchestrator (transaction pipeline)
│   ├── extractors.js                 MODIFIED (extractEmailContent, extractPdfFromBuffer)
│   ├── imap.js                       MODIFIED (+mailbox param)
│   └── config.js                     MODIFIED (+imapMailbox, +statementDbPath)
├── tests/
│   ├── statement/                    (4 test files, ~113 tests)
│   │   ├── journal.test.js           StatementJournal (17 tests)
│   │   ├── matcher.test.js           fuzzyMatch (31 tests)
│   │   ├── orchestrator.test.js      StatementProcessor (22 tests)
│   │   └── prompts.test.js           STATEMENT_PROMPT + CLASSIFICATION_PROMPT (43 tests)
│   └── ...                           (config, imap, classify, extractors, etc. — 175+ tests)
│   Total: ~292 tests (all pass)

gateway/
├── actual-api/
│   └── server.js                     MODIFIED (+clear endpoint, +GET filters)
└── workspace/skills/expense-tracker/
    └── SKILL.md                      MODIFIED (+statement reconciliation section)
```

---

## 10. Regression Isolation

| File | Changed? | Risk | Mitigation |
|---|---|---|---|
| `orchestrator.js` (transaction) | No | None | Untouched |
| `prompts.js` (transaction) | No | None | Untouched |
| `tools.js` | Yes | Low | Additive (+StatementJournal class, +5 handlers, +5 schemas) |
| `dedup.js` | No | None | Untouched |
| `imap.js` | Yes | Low | Additive (+mailbox param, default "INBOX") |
| `extractors.js` | Yes | Low | Additive (+PDF extraction branch) |
| `config.js` | Yes | Low | Additive (+imapMailbox, +statementDbPath fields) |
| `index.js` | Yes | Medium | Statement pipeline wiring + mailbox passthrough |
| `actual-api/server.js` | Yes | Low | Additive (+clear endpoint, +filter params) |
| `SKILL.md` | Yes | Low | Additive (+statement reconciliation section) |
| `docker-compose.yml` | No | None | Untouched |
| `Dockerfile` | No | None | pdftotext already installed |

**Intentional test changes:**
- `test_tools.py`: 10→15 schemas (rename test)
- `test_integration.py`: 11→15 endpoints (rename test)

---

## 11. Cost Estimate

All pipelines use `deepseek-flash` with thinking level controlling depth.

| Step | Model | Thinking | Input | Output | Cost |
|---|---|---|---|---|---|
| Pre-classification | deepseek-flash | _(not set)_ | ~500 tok | ~5 tok | ~$0.00014 |
| Statement processing (15 txns) | deepseek-flash | low | ~6000 tok | ~2500 tok | ~$0.002 |
| Per-email total | | | | | **~$0.002** |

At 4 statements/month + ~100 alerts/month: **~$0.12/month total**.
