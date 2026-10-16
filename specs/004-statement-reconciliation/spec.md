# Feature Specification: Statement Reconciliation & Email Routing

**Feature:** statement-reconciliation
**Spec Version:** 3.0.0
**Status:** Implementing (expense-tracker wired, PT pending)
**Constitution Hash:** v2.0.0

---

## Overview

When a monthly credit card or bank statement arrives in the burner inbox (as a PDF attachment or tabular HTML email), the system extracts all transactions via OCR, reconciles each line item against previously-recorded transactions in Actual Budget, and inserts any unmatched items as uncleared transactions for manual review.

Email routing is handled via IMAP folder filters (server-side) with LLM-based pre-classification as fallback. Bank alerts go to the expense-tracker via INBOX, trade/investment emails are sorted into a Trades folder for the portfolio-tracker.

A **statement is authoritative** — it represents the bank's final record for a billing cycle. This is fundamentally different from transaction alerts:

| | Alert Pipeline (existing) | Statement Pipeline (new) |
|---|---|---|
| **Authority** | Hint (may miss txns) | Bank's official record |
| **"Match found"** | Duplicate → skip silently | **Reconciliation** → mark as cleared |
| **"No match"** | Insert new txn (cleared=false) | **Insert as outlier** (cleared=false, noted) |
| **Result** | 1 txn inserted or skipped | Reconciliation report: X cleared, Y outliers inserted |
| **Database** | dedup.db (prevent duplicates) | statement.db (prevent re-processing periods) |
| **LLM Model** | deepseek-flash (thinking=off) | deepseek-flash (thinking=low) |
| **Email disposition** | Read on insert; unread on skip/fail | Always marked read |

---

## User Stories

### US-1: Email Pre-Classification

**As a** user who receives both transaction alerts and monthly statements,
**I want** the system to classify each email as "statement" or "transaction" before dispatching,
**So that** statements enter the reconciliation pipeline and single alerts enter the insertion pipeline, regardless of format (PDF, HTML, or plain text).

**Acceptance Criteria:**
- [x] After content extraction, a lightweight LLM call (deepseek-flash, no tools) classifies the email
- [x] Classification input: Subject, From, and first 2000 characters of extracted body text
- [x] Classification prompt: "Classify this email as 'statement', 'transaction', or 'skip'."
- [x] "statement" → Statement reconciliation pipeline (US-2 through US-6)
- [x] "transaction" → Existing alert pipeline (unchanged)
- [x] "skip" → Trade confirmations, IBKR Activity Flex, portfolio reports, investment summaries → silently marked read with no processing. These are handled by the portfolio-tracker module.
- [x] PDFs of single receipts are classified as "transaction" (not "statement")
- [x] HTML tabular statement summaries are classified as "statement"
- [x] Ambiguous input defaults to "transaction" (safe — goes through existing UC-2/3 guard logic)
- [x] If classification LLM fails, defaults to "transaction"

### US-2: PDF Statement Ingestion

**As a** user who receives monthly credit card statements as PDF attachments,
**I want** the system to OCR PDF statements into text,
**So that** the LLM can extract their transactions for reconciliation.

**Acceptance Criteria:**
- [ ] `extract_email_content()` handles `application/pdf` MIME parts via `extractPdfFromBuffer()` (pdftotext)
- [ ] OCR text is cleaned and passed to the LLM as part of the statement prompt
- [ ] If `pdftotext` fails → `[PDF_EXTRACTION_ERROR]` or `[PDF_ENCRYPTED]` markers returned (not silently swallowed)
- [ ] Password-protected PDFs: `extractPdfFromBuffer` accepts optional `password` param → pipes through `qpdf --password=... --decrypt` before `pdftotext`
- [ ] LLM prompts instruct password recovery: `search-memory` → email body scan → ask user → `learn-fact` on success
- [ ] PDFs with zero extractable text → notify user, mark read, log error

### US-3: Multi-Transaction Statement Extraction

**As a** user who receives statements with 10-40 transactions,
**I want** the LLM to extract every line item as structured data,
**So that** every transaction on the statement is accounted for in reconciliation.

**Acceptance Criteria:**
- [ ] The LLM extracts: statement period (start/end dates), account name, currency, and all transaction line items
- [ ] Each line item includes: date, description, amount
- [ ] Statement metadata (period, total, due date) is extracted when present
- [ ] The LLM processes line items in a tool-calling loop (max 20 iterations)
- [ ] No bank-specific parser code exists — all parsing is LLM-driven

### US-4: Transaction Reconciliation + Outlier Insertion

**As a** user who receives monthly statements,
**I want** statement transactions matched against my Actual Budget ledger and marked as cleared, and unmatched items inserted as uncleared,
**So that** everything on the bank's official record exists in my budget, with cleared status reflecting what the bank confirmed.

**Acceptance Criteria:**
- [ ] For each statement line item, the system fuzzy-matches against uncleared Actual Budget transactions
- [ ] Matching criteria: same amount (±20 cents tolerance), same date or ±2 days, similar merchant name (token overlap)
- [ ] **Matched transactions** are marked as `cleared: true` via `reconcile_transaction()`
  - Statement reference recorded in AB transaction notes: `" | Statement May 2026"`
- [ ] **Unmatched transactions** (outliers) are inserted via `insert_transaction()` with `cleared: false`
  - Notes field: `"OUTLIER | Statement May 2026"`
- [ ] `reconcile_transaction` and `insert_transaction` are called within the same tool-calling loop
- [ ] Both outcomes are logged to the statement journal

### US-5: Statement Period Tracking

**As a** user who receives monthly statements,
**I want** the system to track which statement periods have already been processed,
**So that** forwarding the same statement twice doesn't cause duplicates.

**Acceptance Criteria:**
- [ ] A new `statement_journal` SQLite table tracks: account_id, budget_id, period_start, period_end, matched_count, outlier_count, processed_at
- [ ] Before processing, the system checks `(account_id, period_start, period_end)` against the journal
- [ ] If already processed → notify user, mark email read, stop (no re-processing)
- [ ] After successful processing, a row is inserted into the journal
- [ ] Journal is in a separate database file (`data/statement.db`)

### US-6: Statement Processing Notification

**As a** user who wants a summary of each statement processed,
**I want** a Telegram notification showing the reconciliation result,
**So that** I know what was cleared and what needs manual review.

**Acceptance Criteria:**
- [ ] After processing, a Telegram notification is sent:
  - "Epsilon Nova statement for May 2026 processed:"
  - "✅ 12 transactions reconciled and cleared"
  - "⚠️ 3 outliers inserted but not cleared: [date, amount, description for each]"
- [ ] If all items reconciled (0 outliers) → simpler message: "✅ All 12 transactions reconciled and cleared"
- [ ] If all items are outliers (new card) → "No prior alerts for this account" note included
- [ ] Email is always marked read after notification (regardless of outcome)
- [ ] On failure → notify user with error details, mark email read, log error

### US-7: IMAP Folder Routing

**As a** user who receives both bank alerts and trade emails,
**I want** emails routed by server-side IMAP filters instead of LLM classification,
**So that** bank alerts and trade emails never collide, with zero LLM token burn on routing.

**Acceptance Criteria:**
- [ ] Server-side filter: From contains `interactivebrokers` → Move to `Trades` folder
- [ ] expense-tracker monitors INBOX (bank alerts only)
- [ ] portfolio-tracker monitors Trades folder (IBKR/trade emails only)
- [ ] No `_classify_email()` calls triggered by trade emails reaching expense-tracker
- [ ] `IMAP_MAILBOX` env var per module (`INBOX` for ET, `Trades` for PT)

### US-8: Trade PDF Handling via Telegram

**As a** user,
**I want** to forward trade PDFs via Telegram and have them routed to the portfolio-tracker,
**So that** I can manually upload PDFs when email delivery fails.

**Acceptance Criteria:**
- [ ] Sending "pdf" or a PDF file in Telegram activates the portfolio-tracker skill
- [ ] When trade email has no PDF attachment, agent calls notify_user with clear ask for PDF
- [ ] After successful trade processing, email is marked SEEN

---

## Edge Cases

| Scenario | Expected Behavior |
|---|---|
| OCR returns empty/garbled text | `[PDF_EXTRACTION_ERROR]` → notify user → mark read → stop |
| PDF is a single receipt (not a statement) | Pre-classification (US-1) routes it as "transaction" → alert pipeline |
| HTML email contains tabular statement (no PDF) | Pre-classification routes as "statement" → statement pipeline |
| Same statement period processed twice | Statement journal detects duplicate → notify "already processed" → mark read → stop |
| Statement has zero transactions (unused card) | LLM detects no transactions → notify → record as processed → mark read |
| Account has zero uncleared AB transactions (new card) | All items inserted as outliers with `"no prior alerts"` note |
| Statement in MYR | `ensureBudget` switches to MYR budget — all AB operations on MYR |
| OCR extracts wrong amount (garbled) | fuzzy_match amount diffs → no match → inserted as outlier (safe) |
| PDF is password-protected | `pdftotext` fails → `qpdf --password=... --decrypt` → `pdftotext`. Password sourced from: (1) `search-memory` for stored passwords, (2) email body patterns, (3) user prompt → saved via `learn-fact`. If all fail → `[PDF_EXTRACTION_ERROR]` → notify → mark read |
| Statement text exceeds LLM context window | DeepSeek Flash has 1M context — 40-page statement fine. Text is truncated at 60K chars as safety. |
| IBKR Activity Flex or trade confirmation email arrives | Pre-classification returns `"skip"` → email silently marked read, bypassed entirely. Handled by the portfolio-tracker module |
| IMAP folder doesn't exist | Auto-create Trades folder on first connection |
| Server-side filter not yet set up | Fallback: expense-tracker sees non-bank emails and classifies as skip |
| OCR fails on valid PDF | `[PDF_EXTRACTION_ERROR]` → notify user → mark read → stop |
| Trade email in Trades folder has no PDF | Agent calls notify_user asking user to forward PDF, then marks read |

---

## Non-Goals (Explicitly Out of Scope)

- Auto-clearing of outlier transactions (user must manually clear in AB)
- Support for non-PDF/non-HTML statement formats (CSV, XLSX, OFX)
- Statement payment tracking (recording "amount due" as a bill)
- Historical statement backfill (only new emails processed)
- Direct bank API integration (email-based only)
- Visual PDF table extraction (pure text OCR, no layout parsing)
- Investor/loan statement processing (credit card and bank accounts only)
