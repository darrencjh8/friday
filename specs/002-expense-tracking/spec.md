# Feature Specification: Automated Expense Tracking

**Feature:** expense-tracking  
**Spec Version:** 2.0.0  
**Status:** Done (canonical baseline)  
**Constitution Hash:** v1.0.0  
**Runtime:** Node.js 22 (ESM) — `modules/expense-tracker`

> **Canonical baseline.** Single source-of-truth spec for the expense-tracker, matching the current **Node.js** code.
> - Pipeline: 3-phase (Spec 021 rationale in `specs/021-three-phase-refactor/`).
> - Module design: `modules/expense-tracker/docs/design.md`.
> - Agent runtime guide: `modules/hermes/skills/expense-tracker/SKILL.md`.
> - Audit trail: `specs/030-spec-drift/`.

---

## Overview

An LLM-powered agent (Hermes) that monitors a dedicated Email burner inbox via IMAP IDLE. When a receipt or transaction alert email is forwarded to this inbox, the agent extracts structured transaction data and inserts it into the user's existing **Actual Budget** instance.

The intelligence layer is a **DeepSeek LLM** (`deepseek-flash`). The Node.js host (`modules/expense-tracker`) provides deterministic tools — **28 REST `/tools/*` endpoints** and **24 MCP tools** — that the LLM/orchestrator calls to fetch live context and execute actions. No business rules (category mapping, account matching, currency detection) are hardcoded in the tool layer.

Incoming emails are pre-classified by a lightweight LLM call into one of three categories before dispatch: `"transaction"` (alert pipeline, 3-phase orchestrator), `"statement"` (reconciliation pipeline), or `"skip"` (silently ignored — for trade/portfolio emails handled by a separate module).

---

## User Stories

### US-1: Real-Time Email Monitoring

**As a** user who receives transaction alerts by email,  
**I want** OpenClaw to detect new emails in the burner inbox in near-real-time,  
**So that** transactions appear in Actual Budget within seconds of the email arriving.

**Acceptance Criteria:**
- [ ] OpenClaw maintains a persistent IMAP IDLE connection to Email Provider (`imap.example.com:993`)
- [ ] New emails are detected within 5 seconds of arrival
- [ ] If the IMAP connection drops, OpenClaw reconnects automatically and performs a catch-up fetch of any emails missed during the disconnection
- [ ] Each email is processed exactly once (idempotent via UID-based `processed_uids` table with 60-min cooldown + SHA-256 dedup journal)

---

### US-2: Intelligent Email Parsing via LLM

**As a** user who receives emails from multiple banks, payment apps, and merchants,  
**I want** OpenClaw to use an LLM to understand any email format without per-bank parser code,  
**So that** new senders and format changes don't require code changes.

**Acceptance Criteria:**
- [ ] Raw email content (HTML stripped to text; PDF attachments processed via OCR) is sent to DeepSeek
- [ ] The LLM extracts: amount, currency (SGD/MYR/other), merchant name, transaction date, and source account hints
- [ ] The LLM handles all common Singapore/Malaysia formats: DBS alerts, OCBC alerts, UOB alerts, Grab receipts, Shopee receipts, TNG eWallet alerts, Maybank alerts, generic forwarded receipts
- [ ] No bank-specific parser code exists in the tool layer (all parsing is LLM-driven)
- [ ] If the LLM cannot confidently extract required fields, it calls `notify_user` instead of guessing

---

### US-3: Dual-Currency Budget Routing

**As a** user with SGD and MYR budgets in Actual Budget,  
**I want** OpenClaw to automatically route transactions to the correct budget based on currency,  
**So that** MYR expenses don't pollute the SGD budget and vice versa.

**Acceptance Criteria:**
- [ ] The LLM detects currency from the email content (explicit: "RM", "MYR", "SGD", "S$"; contextual: Malaysian merchants, Singaporean merchants)
- [ ] SGD transactions are routed to the `Test-SGD-Budget` budget
- [ ] MYR transactions are routed to the corresponding MYR budget
- [ ] If currency is ambiguous or neither SGD nor MYR, the LLM calls `notify_user` and skips insertion
- [ ] The `notes` field on the Actual Budget transaction records the detected currency for audit

---

### US-4: Live Account Matching

**As a** user who may open, close, or rename accounts in Actual Budget,  
**I want** OpenClaw to always match transactions against the current list of accounts,  
**So that** renamed or new accounts work immediately without config changes.

**Acceptance Criteria:**
- [ ] The LLM calls `fetch_accounts` before matching any transaction
- [ ] Account matching is by name similarity (e.g., "Epsilon Nova" in email → "Epsilon Nova" in Actual Budget)
- [ ] If no clear account match exists, the LLM calls `notify_user` with available accounts listed
- [ ] No hardcoded account UUIDs or names exist in config or code

---

### US-5: Live Category Assignment

**As a** user who may restructure categories in Actual Budget,  
**I want** OpenClaw to assign categories based on the current category list and merchant context,  
**So that** category changes in Actual Budget are reflected immediately.

**Acceptance Criteria:**
- [ ] The LLM calls `fetch_categories` before assigning any category
- [ ] Category assignment is based on merchant context (e.g., "Toast Box" → "Food", "Grab" → "Transportation", "NTUC FairPrice" → "Household"/"Groceries")
- [ ] The LLM may leave `category` as `null` if uncertain — the user manually categorizes in Actual Budget
- [ ] No hardcoded category rules exist in config or code

---

### US-6: Duplicate Prevention

**As a** user who may accidentally forward the same email twice,  
**I want** OpenClaw to detect and skip duplicate transactions,  
**So that** my Actual Budget ledger stays clean.

**Acceptance Criteria:**
- [x] Before insertion, a SHA-256 hash of `(date, amount_cents, account_id, payee_name)` is checked against a local SQLite journal (`dedup` table)
- [x] If a duplicate is detected in the dedup journal or Actual Budget, the LLM skips insertion and marks the email as read
- [x] The dedup entry is recorded only AFTER successful insertion (not before the check)
- [x] A UID-based `processed_uids` table with 60-minute cooldown pre-checks at the IMAP layer — recently processed emails skip all LLM dispatch
- [x] The journal is persisted across restarts (SQLite file on Docker persistent volume)

---

### US-7: Notification for Ambiguous Emails

**As a** user who wants a clean Actual Budget ledger,  
**I want** OpenClaw to notify me when it cannot confidently process an email,  
**So that** I can manually review rather than having bad data silently inserted.

**Acceptance Criteria:**
- [ ] If the LLM detects unknown currency (not SGD, not MYR) → notification, no insert
- [ ] If the LLM cannot extract an amount → notification, no insert
- [ ] If the LLM cannot match an account → notification with available accounts listed, no insert
- [ ] If the LLM detects an actual error (API failure, network issue) → notification with error details
- [ ] Notifications are sent to the user's main email via SMTP
- [ ] The original email is left unread so the user can manually review it

---

### US-8: Idempotent Processing

**As a** user who wants the system to be robust,  
**I want** OpenClaw to be safe to restart at any time,  
**So that** crashes or redeploys don't cause duplicate or lost transactions.

**Acceptance Criteria:**
- [x] Emails are marked as read after successful processing (insertion, skip, or intentional non-action)
- [x] Failed or uncertain emails remain unread — re-processed on next IMAP cycle
- [x] On startup, the IMAP handler fetches any unread emails and processes them
- [x] A UID-based `processed_uids` SQLite table with 60-minute cooldown prevents recently processed emails from being re-dispatched to the LLM
- [x] The dedup journal prevents re-insertion of already-processed transactions
- [x] If the process crashes mid-processing, the email remains unread and is re-processed on restart (UID is only recorded after successful completion)
- [x] Memory facts are deduplicated via exact-match `Set` gate in `MemoryStore.add()` — repeated `learn_fact` calls for the same mapping produce `{ skipped: true }` instead of appending duplicates to MEMORY.md
- [x] MEMORY.md is written atomically (temp file + rename) to prevent corruption on crash mid-write
- [x] Structured memory facts (`X maps to Y payee`, `X is a Y account`, canonical-suffix facts) are matched by key, never by similarity: `_semanticSearch()` skips them before embedding and `factNamesMerchant()` accepts only an exact key or whole-word key containment with the key at least 3 characters. A misspelled or abbreviated merchant that satisfies neither does not reach the mapping through semantic search — accepted risk, rationale and measurements in `modules/expense-tracker/docs/design.md` (#420, #471, #472)

---

### US-9: Email Pre-Classification with Portfolio/Trade Skip

**As a** user who receives IBKR Activity Flex, trade confirmations, and portfolio reports in the same burner inbox,
**I want** the expense-tracker to classify every email before dispatching to the appropriate LLM pipeline,
**So that** portfolio/trade emails are silently skipped (not processed by the expense-tracker) and expense-related emails reach the correct pipeline.

**Acceptance Criteria:**
- [x] Every inbound email is classified by a lightweight LLM call (deepseek-flash, no tools) as one of: `"statement"`, `"transaction"`, or `"skip"`
- [x] `"statement"` → routed to the Statement Reconciliation pipeline (`src/statement/orchestrator.js`, deepseek-flash)
- [x] `"transaction"` → routed to the Alert pipeline (`src/orchestrator.js`, 3-phase: LLM Analysis → code-driven Resolution → Execute)
- [x] `"skip"` → email is silently marked as read with NO LLM processing and NO user notification. This covers: IBKR Activity Flex statements, trade confirmations, portfolio reports, investment summaries, securities transaction notices
- [x] If the classification LLM fails (API error, timeout), the email defaults to `"transaction"` as a safe fallback
- [x] Portfolio/trade emails are handled by the separate portfolio-tracker module which independently monitors the same inbox

---

## Merchant Resolution (`resolve_merchant`)

> Folded from Spec 015 (merchant-resolver). The keyword heuristic step (FR-005) was removed by Spec 021; resolution is memory → web → fallback.

**API:** `POST /tools/resolve-merchant` — `{ merchant: string, budget_id: string }` → `{ payee: string, source: "memory"|"web"|"fallback" }`.
Exposed as MCP tool `resolve_merchant` (`src/mcp-server.js`). `budget_id` is required for payee-list validation.

**Resolution chain** (`src/tools.js:_handle_resolve_merchant`), short-circuits on first match:
1. `MemoryStore.search()` lookup in MEMORY.md → `source: "memory"`
2. Web search (Brave, if `BRAVE_SEARCH_API_KEY` configured) + DeepSeek LLM classification (`temperature: 0.1`, reasoning `low`) → `source: "web"`
3. `"Misc"` fallback → `source: "fallback"`

**Behaviors:**
- After `"web"` resolution, `MemoryStore.add()` persists the mapping for future memory hits. `"memory"` and `"fallback"` resolutions do NOT trigger learning.
- Resolved payee is validated against the live payee list (via actual-api). If the payee doesn't match any live payee, falls back to `"Misc"`.
- Timeout: ≤500ms (memory path) or ≤20s (web search path). Timeout at any step falls through to the next step — no crash.
- Concurrent calls for the same merchant run independently; the second `learn_fact` is a no-op (dedup in MemoryStore).

## Transaction Update (`update_transaction`)

> Also folded from Spec 015.

**API:** `POST /tools/update-transaction` — `{ id: string, budget_id?: string, payee_name?, payee_id?, notes?, amount?, date?, category_id?, account_id? }`. At least one optional field required.

- `payee_name` is validated against live payee list → unknown payees rejected (not defaulted to Misc).
- `payee_name` and `payee_id` are mutually exclusive; supplying both is rejected before any lookup. A blank `payee_name` counts as absent on this HTTP route; the MCP schema instead rejects a blank `payee_name`, as it does a blank `payee_id`.
- When several payees share a name, the sole transfer payee (the one with `transfer_acct`) is selected. If the name matches several plain payees, or more than one transfer payee, the update is refused with the candidate IDs and `payee_id` must disambiguate. `insert_transaction` applies the same duplicate-name rule.
- `category_id` is validated against live category list → unknown categories rejected.
- `insert_transaction` validation differs: an unknown payee becomes `"Misc"` and an unknown category becomes `"Fun Money"`, but an ambiguous payee name is refused with the candidate IDs rather than resolved by list order.

---

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| Email with PDF receipt attachment | PDF → text via `pdftotext` (poppler), with `qpdf` decryption for encrypted PDFs (`src/extractors.js`) → text sent to LLM. If extraction fails, notify user |
| Email with both SGD and MYR amounts | LLM detects ambiguity → notify user |
| Email from unknown sender | LLM attempts generic extraction. If confident, proceeds. If not, notifies user |
| Actual Budget API is down | Retry 3x with exponential backoff (1s, 2s, 4s). If all fail, leave email unread, notify user |
| DeepSeek API is down | Same retry strategy as above |
| Email body is base64-encoded | Extractors handle MIME decoding before LLM receives content |
| Email is a bank promo/ad (not a transaction) | LLM identifies it as non-transactional → skip, mark read, no insert |
| Two emails for the same transaction (e.g., SMS + email alert) | Dedup journal catches the duplicate → second one skipped |
| Amount in email includes thousands separator (e.g., "1,280.50") | LLM normalizes to numeric value |
| Email date is ambiguous (e.g., "03/04/2026" — is it March 4 or April 3?) | LLM uses the date format from Actual Budget's config (`dd/MM/yyyy`) as hint |
| IBKR Activity Flex email arrives | Pre-classification returns `"skip"` → email silently marked read, no LLM processing, no notification. Portfolio-tracker module handles it independently |
| Trade confirmation or portfolio report email arrives | Pre-classification returns `"skip"` → treated same as IBKR: mark read silently |

---

## Non-Goals (Explicitly Out of Scope)

- Multi-tenancy (only one user's Actual Budget instance)
- Direct bank API integration (only email-based ingestion)
- Mobile push notifications (email notification only)
- Web UI or dashboard
- Budget creation or account management (Actual Budget handles this)
- Historical email backfill beyond unread emails on startup
- Non-email sources (SMS, WhatsApp, bank APIs)