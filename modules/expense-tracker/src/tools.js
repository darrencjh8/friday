/**
 * Tool Registry — deterministic LLM tools with OpenAI-compatible schemas.
 * Ported 1:1 from src/agent/tools.py
 */

import { AsyncLocalStorage } from "async_hooks";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import Database from "better-sqlite3";
import { simpleParser } from "mailparser";
import { DedupJournal } from "./dedup.js";
import { isBookableAmountCents } from "./amounts.js";
import { extractPdfFromBuffer, extractEmailContent } from "./extractors.js";
import { factNamesMerchant } from "./memory.js";
import {
  JEV_PROMPT_VARIANTS,
  alertContext,
  classifyCategory,
  classifyPayee,
  eligibleCategories,
  eligiblePayees,
  payeeHistory,
} from "./jev.js";
import { merchantKey, searchMerchant } from "./merchant-search.js";
import { PendingLearning, incomingKey } from "./learning.js";
import { composeNotes } from "./transaction-notes.js";
import { logger, getLogger, redactSensitive } from "./logging.js";

const RETRYABLE_NOTIFY_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
]);

export class NotificationCooldown {
  COOLDOWN_SECONDS = 3600;

  constructor() {
    this._entries = new Map();
  }

  shouldSuppress(msgId) {
    const last = this._entries.get(msgId);
    if (!last) return false;
    if (Date.now() - last < this.COOLDOWN_SECONDS * 1000) return true;
    this._entries.delete(msgId);
    return false;
  }

  record(msgId) {
    this._entries.set(msgId, Date.now());
  }

  clear() {
    this._entries.clear();
  }
}

// ── StatementJournal ────────────────────────────────────────────

export class StatementJournal {
  /**
   * SQLite-backed tracker for processed credit card statements.
   * Prevents double-processing of (account_id, period_start, period_end).
   */
  constructor(dbPath = "data/statement.db") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this._db = new Database(dbPath);
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS statement_journal (
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
      )
    `);
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS statement_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        statement_id INTEGER NOT NULL REFERENCES statement_journal(id),
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        ab_transaction_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('reconciled', 'outlier')),
        notes TEXT,
        FOREIGN KEY(statement_id) REFERENCES statement_journal(id)
      )
    `);
    this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_stmt_journal_account
      ON statement_journal(account_id, period_start)
    `);
    this._stmtRecord = this._db.prepare(`
      INSERT INTO statement_journal
        (account_id, budget_id, period_start, period_end,
         matched_count, outlier_count, total_amount_cents,
         due_date, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmtCheck = this._db.prepare(`
      SELECT id, account_id, budget_id, period_start, period_end,
             matched_count, outlier_count, total_amount_cents,
             due_date, currency, processed_at
      FROM statement_journal
      WHERE account_id = ? AND period_start = ? AND period_end = ?
    `);
    this._stmtAddTxn = this._db.prepare(`
      INSERT INTO statement_transactions
        (statement_id, date, description, amount_cents,
         ab_transaction_id, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmtHistory = this._db.prepare(`
      SELECT id, account_id, budget_id, period_start, period_end,
             matched_count, outlier_count, processed_at
      FROM statement_journal
      WHERE account_id = ?
      ORDER BY period_start DESC
    `);
  }

  recordStatement(
    accountId,
    budgetId,
    periodStart,
    periodEnd,
    matchedCount,
    outlierCount,
    totalAmountCents,
    dueDate,
    currency,
  ) {
    const result = this._stmtRecord.run(
      accountId,
      budgetId,
      periodStart,
      periodEnd,
      matchedCount,
      outlierCount,
      totalAmountCents ?? null,
      dueDate ?? null,
      currency || "SGD",
    );
    return Number(result.lastInsertRowid);
  }

  checkProcessed(accountId, periodStart, periodEnd) {
    const row = this._stmtCheck.get(accountId, periodStart, periodEnd);
    if (!row) return null;
    return {
      id: row.id,
      account_id: row.account_id,
      budget_id: row.budget_id,
      period_start: row.period_start,
      period_end: row.period_end,
      matched_count: row.matched_count,
      outlier_count: row.outlier_count,
      total_amount_cents: row.total_amount_cents,
      due_date: row.due_date,
      currency: row.currency,
      processed_at: row.processed_at,
    };
  }

  addTransaction(
    statementId,
    date,
    description,
    amountCents,
    status,
    abTransactionId,
    notes,
  ) {
    const result = this._stmtAddTxn.run(
      statementId,
      date,
      description,
      amountCents,
      abTransactionId ?? null,
      status,
      notes ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getHistory(accountId) {
    const rows = this._stmtHistory.all(accountId);
    return rows.map((r) => ({
      id: r.id,
      account_id: r.account_id,
      budget_id: r.budget_id,
      period_start: r.period_start,
      period_end: r.period_end,
      matched_count: r.matched_count,
      outlier_count: r.outlier_count,
      processed_at: r.processed_at,
    }));
  }

  close() {
    this._db.close();
  }
}

// ── Tool Definitions ────────────────────────────────────────────

/**
 * Tag for the duplicate-name refusal. Callers key off this rather than the
 * message text, so the wording stays free to change. Issue #551.
 */
const AMBIGUOUS_PAYEE = "AMBIGUOUS_PAYEE";

/**
 * Resolve one payee from a live payee list by exact name.
 *
 * Duplicate names are never resolved by list order, so this is the one policy
 * every name-based lookup uses (insert_transaction, update_transaction and
 * _validate_payee). A bare name means the transfer payee — it is the only
 * match that creates a transfer — and that preference only holds when exactly
 * one match is a transfer payee. Otherwise the pick would come from array
 * order, so return an ambiguity error listing the candidate IDs; each one is a
 * valid payee_id. Issue #421, #483, #487.
 *
 * @param {Array<object>} payees live payee list
 * @param {string} name payee name to match, case-insensitively
 * @returns {object|null|{error: string}} the payee, null when the name is
 *   unknown, or an `{error}` result when several payees share the name
 */
export function resolvePayeeMatch(payees, name) {
  if (!Array.isArray(payees) || !name) return null;
  const matches = payees.filter(
    (p) => p.name && p.name.toLowerCase() === name.toLowerCase(),
  );
  if (!matches.length) return null;
  const transferMatches = matches.filter((p) => p.transfer_acct);
  if (matches.length > 1 && transferMatches.length !== 1) {
    const candidates = matches
      .map((p) => p.id)
      .filter(Boolean)
      .join(", ");
    return {
      error: `Payee "${name}" is ambiguous; pass payee_id (candidates: ${candidates}).`,
      // Tagged so a caller that only relays the text (the insert path returns
      // it, the orchestrator rethrows it) can still tell a refusal from an
      // upstream failure and tell the human what to do about it. Issue #551.
      code: AMBIGUOUS_PAYEE,
    };
  }
  return transferMatches[0] || matches[0];
}

/** Tag an ambiguity refusal so callers can tell it from a fetch failure. */
function ambiguousPayeeError(message) {
  const error = new Error(message);
  error.code = AMBIGUOUS_PAYEE;
  return error;
}

/**
 * Build the error for a failed actual-api response, including the response
 * body when it can be read. A bare status hid the cause of the 2026-09-13
 * incident, where every budget-scoped route answered 500 with
 * `{"error":"No budget file is open"}` and the logs showed only
 * `actual-api 500` (issue #549).
 */
async function actualApiError(response) {
  let body = "";
  try {
    body = String(await response.text()).trim();
  } catch {
    // An unreadable body leaves the bare status.
  }
  return new Error(`actual-api ${response.status}${body ? ` ${body}` : ""}`);
}

/**
 * Normalise a quoted integer amount to a number (#508), leaving all else as-is
 * so the route rejects it rather than it being reinterpreted here.
 */
function normalizeAmountCents(value) {
  return typeof value === "string" && isBookableAmountCents(value)
    ? Number(value)
    : value;
}

const TOOLS = [
  {
    name: "search_wiki",
    description:
      "Search the finance wiki (merchant, payee, category, people, account and suffix facts). Read-only.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_memory",
    description:
      "Deprecated alias of search_wiki, kept for compatibility. Searches the same facts.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "learn_fact",
    description: "Record a learned fact in MEMORY.md with semantic dedup.",
    schema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "Complete natural-language sentence",
        },
        budget_id: { type: "string", description: "Budget containing accounts" },
      },
      required: ["fact"],
    },
  },
  {
    name: "list_facts",
    description: "Return all learned facts from MEMORY.md.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "update_fact",
    description: "Replace a learned fact in MEMORY.md.",
    schema: {
      type: "object",
      properties: {
        old_text: { type: "string" },
        new_text: { type: "string" },
        budget_id: { type: "string", description: "Budget containing accounts" },
      },
      required: ["old_text", "new_text"],
    },
  },
  {
    name: "delete_fact",
    description: "Remove learned facts from MEMORY.md by substring match.",
    schema: {
      type: "object",
      properties: { match_text: { type: "string" } },
      required: ["match_text"],
    },
  },
  {
    name: "cleanup_facts",
    description:
      "Clean MEMORY.md: rewrite card/account suffix facts to canonical form, drop duplicate spellings of one mapping, resolve same-entity different-value conflicts (newest wins) and deduplicate free-form facts by semantic similarity. Returns {before, after, removed, normalised, contradictions} for review. A non-zero normalised count means suffix facts were rewritten, so the file changed.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "fetch_budgets",
    description:
      "List all available budgets from Actual Budget. Returns name, groupId, and cloudFileId for each. Use the name as budget_id in subsequent calls.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "fetch_accounts",
    description: "Fetch all active accounts from Actual Budget with current balances.",
    schema: {
      type: "object",
      properties: { budget_id: { type: "string" } },
      required: ["budget_id"],
    },
  },
  {
    name: "fetch_categories",
    description: "Fetch all active categories from Actual Budget.",
    schema: {
      type: "object",
      properties: { budget_id: { type: "string" } },
      required: ["budget_id"],
    },
  },
  {
    name: "fetch_payees",
    description: "Fetch all payees from Actual Budget.",
    schema: {
      type: "object",
      properties: { budget_id: { type: "string" } },
      required: ["budget_id"],
    },
  },
  {
    name: "fetch_context",
    description:
      "Get accounts, categories, and payees in one call. Accounts include current balances. Use this instead of calling fetch_accounts + fetch_categories + fetch_payees separately.",
    schema: {
      type: "object",
      properties: { budget_id: { type: "string" } },
      required: ["budget_id"],
    },
  },
  {
    name: "fetch_budget_month",
    description:
      "Get one month of the budget: every category group and category with its assigned (budgeted), spent, and balance amounts. Defaults to the current month. Use this for questions about how much is assigned or left to spend in a budget month.",
    schema: {
      type: "object",
      properties: {
        budget_id: {
          type: "string",
          description: "Budget file name (required)",
        },
        month: {
          type: "string",
          pattern: "^\\d{4}-(0[1-9]|1[0-2])$",
          description: "Month as YYYY-MM; defaults to the current month",
        },
      },
      required: ["budget_id"],
    },
  },
  {
    name: "fetch_recent_transactions",
    description:
      "Fetch transactions from Actual Budget. Pass id to fetch a single transaction, or account_id + days to fetch recent ones.",
    schema: {
      type: "object",
      properties: {
        budget_id: {
          type: "string",
          description: "Budget file name (required)",
        },
        id: {
          type: "string",
          description: "Fetch a single transaction by its ID",
        },
        account_id: {
          type: "string",
          description:
            "Account ID for recent-transactions query (ignored if id is set)",
        },
        days: {
          type: "integer",
          description: "Days to look back (default 7)",
          default: 7,
        },
      },
      required: ["budget_id"],
    },
  },
  {
    name: "insert_transaction",
    description:
      "Insert a new transaction into Actual Budget. Returns the created transaction with id; the id is null when the inserted row cannot be attributed (a concurrent insert on the same account in the same window, or a failed read-back). An imported_description that matches several payees is refused and lists the candidate IDs; pass payee_id to select one.",
    schema: {
      type: "object",
      properties: {
        budget_id: { type: "string" },
        account_id: { type: "string" },
        date: {
          type: "string",
          description: "YYYY-MM-DD",
        },
        amount_cents: {
          type: "integer",
          description: "Negative for spending",
        },
        imported_description: {
          type: "string",
          description: "Merchant name",
        },
        payee_id: {
          type: "string",
          description:
            "Explicit payee ID. Selects a specific payee when names collide; overrides name-based resolution.",
        },
        category_id: { type: "string" },
        notes: { type: "string" },
      },
      required: ["budget_id", "account_id", "date", "amount_cents"],
    },
  },
  {
    name: "fetch_schedules",
    description:
      "Fetch Actual Budget schedules (including ones not yet posted). Use to tell whether a pending scheduled transaction will post a row that looks like a transaction you are about to insert.",
    schema: {
      type: "object",
      properties: { budget_id: { type: "string" } },
      required: ["budget_id"],
    },
  },
  {
    name: "check_schedule_collision",
    description:
      "Check whether a not-yet-posted scheduled transaction will create a row matching this amount near this date. Use before inserting a transfer-like row so a due schedule cannot post a duplicate.",
    schema: {
      type: "object",
      properties: {
        budget_id: { type: "string" },
        amount_cents: { type: "integer" },
        date: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["budget_id", "amount_cents", "date"],
    },
  },
  {
    name: "check_duplicate",
    description: "Check if a transaction already exists.",
    schema: {
      type: "object",
      properties: {
        date: { type: "string" },
        amount_cents: { type: "integer" },
        account_id: { type: "string" },
        payee_name: { type: "string" },
        budget_id: { type: "string" },
      },
      required: [
        "date",
        "amount_cents",
        "account_id",
        "payee_name",
        "budget_id",
      ],
    },
  },
  {
    name: "extract_pdf_text",
    description:
      "Extract text from a PDF document provided as base64-encoded bytes using pdftotext. For encrypted PDFs, provide the password.",
    schema: {
      type: "object",
      properties: {
        pdf_bytes_b64: {
          type: "string",
          description: "Base64-encoded PDF bytes",
        },
        password: {
          type: "string",
          description: "Optional password for encrypted PDFs",
        },
      },
      required: ["pdf_bytes_b64"],
    },
  },
  {
    name: "reconcile_transaction",
    description:
      "Clear one or more Actual Budget transactions (mark as reconciled). Pass ab_transaction_ids as an array. Each is set cleared=true with an optional statement reference appended to notes.",
    schema: {
      type: "object",
      properties: {
        ab_transaction_ids: {
          type: "array",
          items: { type: "string" },
          description: "One or more AB transaction IDs to clear",
        },
        statement_ref: {
          type: "string",
          description: "Statement period reference (e.g. 'Jun 2026')",
          default: "",
        },
        budget_id: {
          type: "string",
          description: "Budget file name (required)",
        },
      },
      required: ["ab_transaction_ids", "budget_id"],
    },
  },
  {
    name: "unclear_transaction",
    description:
      "Unclear one or more Actual Budget transactions (mark as not reconciled). Pass ab_transaction_ids as an array. Each is set cleared=false.",
    schema: {
      type: "object",
      properties: {
        ab_transaction_ids: {
          type: "array",
          items: { type: "string" },
          description: "One or more AB transaction IDs to unclear",
        },
        budget_id: {
          type: "string",
          description: "Budget file name (required)",
        },
      },
      required: ["ab_transaction_ids", "budget_id"],
    },
  },
  {
    name: "fetch_unreconciled_transactions",
    description:
      "Fetch uncleared transactions from Actual Budget for an account within a date range.",
    schema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description: "Actual Budget account ID",
        },
        date_from: {
          type: "string",
          description: "Start date (YYYY-MM-DD)",
        },
        date_to: {
          type: "string",
          description: "End date (YYYY-MM-DD)",
        },
        budget_id: {
          type: "string",
          description: "Budget file name (required)",
        },
      },
      required: ["account_id", "date_from", "date_to", "budget_id"],
    },
  },
  {
    name: "record_statement",
    description:
      "Record a processed statement to prevent double-processing of the same period.",
    schema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "AB account ID" },
        period_start: {
          type: "string",
          description: "Statement period start (YYYY-MM-DD)",
        },
        period_end: {
          type: "string",
          description: "Statement period end (YYYY-MM-DD)",
        },
        matched_count: {
          type: "integer",
          description: "Transactions reconciled (cleared)",
        },
        outlier_count: {
          type: "integer",
          description: "Transactions flagged as outliers",
        },
        budget_id: {
          type: "string",
          description: "Budget file name (required)",
        },
        total_amount_cents: {
          type: "integer",
          description: "Total statement amount in cents (optional)",
        },
        due_date: {
          type: "string",
          description: "Payment due date (optional)",
        },
        currency: {
          type: "string",
          description: "Currency (default SGD)",
          default: "SGD",
        },
      },
      required: [
        "account_id",
        "period_start",
        "period_end",
        "matched_count",
        "outlier_count",
        "budget_id",
      ],
    },
  },
  {
    name: "fetch_statement_history",
    description:
      "Check if a statement period has already been processed for an account.",
    schema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "AB account ID" },
        period_start: {
          type: "string",
          description: "Statement period start (YYYY-MM-DD)",
        },
        period_end: {
          type: "string",
          description: "Statement period end (YYYY-MM-DD)",
        },
      },
      required: ["account_id", "period_start", "period_end"],
    },
  },
  {
    name: "mark_email_read",
    description: "Mark an email as read in the IMAP inbox by UID. If uid is omitted, marks the email most recently read via read_inbox_email.",
    schema: {
      type: "object",
      properties: {
        uid: { type: "number", description: "Optional IMAP UID of the email to mark as read." },
      },
    },
  },
  {
    name: "notify_user",
    description: "Send a notification to the user via the gateway.",
    schema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  {
    name: "submit_decision",
    description:
      "Submit the final structured decision for this email. ALL required fields MUST be filled. Call this after you have gathered all necessary information.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["insert", "skip", "unsure"],
          description: "Decision action",
        },
        merchant: {
          type: "string",
          description: "Raw merchant name from email",
        },
        amount_cents: {
          type: "integer",
          description: "Amount in integer cents, negative for spending",
        },
        date: {
          type: "string",
          description: "Transaction date YYYY-MM-DD",
        },
        currency: {
          type: "string",
          description: "SGD or MYR",
        },
        account_id: {
          type: "string",
          description: "Account UUID from fetch_accounts",
        },
        account_name: {
          type: "string",
          description: "Human-readable account name",
        },
        budget_id: { type: "string", description: "Budget file name" },
        raw_description: {
          type: "string",
          description: "Full transaction description",
        },
        notes: { type: "string", description: "Extra context" },
        reasoning: {
          type: "string",
          description: "Why you made this decision",
        },
        notify_message: {
          type: "string",
          description:
            "Used only when no account could be matched (account_id left blank). Leave empty otherwise — the system builds the insert confirmation itself from the resolved payee and category.",
        },
      },
      required: [
        "action",
        "merchant",
        "amount_cents",
        "date",
        "currency",
        "account_id",
        "budget_id",
      ],
    },
  },
  {
    name: "log_decision",
    description: "Log the final decision for this email.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["inserted", "skipped", "notified", "error"],
        },
        reasoning: { type: "string" },
        transaction_id: { type: "string", default: "" },
      },
      required: ["action", "reasoning"],
    },
  },
  {
    name: "extract_email_content",
    description:
      "Extract and clean the text content of the current email, including PDF attachment decryption when password is provided.",
    schema: {
      type: "object",
      properties: {
        include_headers: { type: "boolean", default: false },
        password: {
          type: "string",
          description:
            "Password for encrypted PDF attachments. Omit for unencrypted emails.",
        },
      },
    },
  },
  {
    name: "check_statement_duplicate",
    description:
      "Check if a transaction with the same date, amount, and account already exists (ignoring payee).",
    schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        amount_cents: { type: "integer" },
        account_id: { type: "string" },
        budget_id: {
          type: "string",
          description: "Optional budget ID for AB API fallback",
        },
      },
      required: ["date", "amount_cents", "account_id"],
    },
  },
  {
    name: "resolve_merchant",
    description:
      "Resolve a raw merchant name to a canonical payee using memory, web search, and AI classification.",
    schema: {
      type: "object",
      properties: {
        merchant: {
          type: "string",
          description: "Raw merchant name from transaction",
        },
        budget_id: { type: "string" },
      },
      required: ["merchant", "budget_id"],
    },
  },
  {
    name: "list_pending_learning",
    description:
      "List the payee mappings the tracker has offered to remember and the user has not answered yet. Nothing is learned until confirm_learning is called.",
    schema: { type: "object", properties: {} },
  },
  {
    name: "confirm_learning",
    description:
      "Persist one offered payee mapping. Call only after the user has explicitly said yes to that exact offer. Returns {confirmed}.",
    schema: {
      type: "object",
      properties: { id: { type: "string", description: "Offer id from list_pending_learning" } },
      required: ["id"],
    },
  },
  {
    name: "decline_learning",
    description:
      "Discard one offered payee mapping the user does not want remembered. The booked transaction is not changed.",
    schema: {
      type: "object",
      properties: { id: { type: "string", description: "Offer id from list_pending_learning" } },
      required: ["id"],
    },
  },
  {
    name: "update_transaction",
    description:
      "Update an existing transaction's fields. Payee and category are validated against live lists. When a transfer payee and a plain payee share a name, a bare payee_name selects the transfer payee; pass payee_id to select a specific one. When several payees share the name and no single transfer payee disambiguates it, the call is refused and lists the candidate IDs. category_id null clears the category only when the resulting payee is Misc.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        budget_id: { type: "string" },
        payee_name: { type: "string" },
        payee_id: { type: "string" },
        notes: { type: "string" },
        amount: { type: "number" },
        date: { type: "string" },
        category_id: { type: ["string", "null"] },
        account_id: { type: "string" },
      },
      required: ["id", "budget_id"],
    },
  },
  {
    name: "process_transaction",
    description:
      "Process a raw bank transaction alert (text forwarded from phone/Telegram) through the full 4-phase pipeline: extract merchant/amount/date, classify, and insert into Actual Budget. Returns {action, details}.",
    schema: {
      type: "object",
      properties: {
        raw_text: {
          type: "string",
          description:
            "Raw text of the transaction alert (e.g., 'S$12.80 Toast Box on Epsilon Nova').",
        },
      },
      required: ["raw_text"],
    },
  },
  {
    name: "list_inbox_emails",
    description:
      "List recent emails from the connected IMAP inbox. Returns metadata only (uid, from, fromName, subject, date) — does NOT mark emails as read. Use read_inbox_email to fetch full content. Opens a separate temporary IMAP connection and does not interfere with the background email processing pipeline.",
    schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum number of recent emails to return (1-500, default 50).",
          default: 50,
        },
      },
    },
  },
  {
    name: "read_inbox_email",
    description:
      "Read a single email from the inbox by UID. Returns full parsed content (from, fromName, subject, date, text, html). Does NOT mark the email as read. Use list_inbox_emails first to find UIDs. Opens a separate temporary IMAP connection.",
    schema: {
      type: "object",
      properties: {
        uid: {
          type: "integer",
          description: "The UID of the email to fetch (from list_inbox_emails).",
        },
      },
    },
  },
  {
    name: "extract_inbox_pdf",
    description:
      "Fetch an email by UID, extract the first PDF attachment, decrypt it (if password provided), and return the text. All server-side — avoids large base64 payloads. Use this instead of read_inbox_email when you need PDF content from an email attachment.",
    schema: {
      type: "object",
      properties: {
        uid: {
          type: "integer",
          description: "The UID of the email to fetch (from list_inbox_emails).",
        },
        password: {
          type: "string",
          description:
            "Password for encrypted PDFs (e.g., SC eStatement password). Omit for unencrypted PDFs.",
          default: "",
        },
      },
      required: ["uid"],
    },
  },
];

const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// A dry run (#796 parity replay) executes only these tools: they read. Every
// other tool is recorded with its arguments and answered with a stub, so a new
// tool is held back from a dry run until it is listed here.
/** Text a fact reader would parse as a mapping of its own. */
const FACT_GRAMMAR_RE = /maps to|payee|category|belongs to|[|`\r\n]/i;

const DRY_RUN_READ_TOOLS = new Set([
  "search_memory",
  "search_wiki",
  "list_facts",
  "fetch_budgets",
  "fetch_accounts",
  "fetch_categories",
  "fetch_payees",
  "fetch_schedules",
  "check_schedule_collision",
  "fetch_budget_month",
  "fetch_context",
  "fetch_recent_transactions",
  "find_link_candidate",
  "extract_pdf_text",
  "extract_email_content",
  "fetch_unreconciled_transactions",
  "fetch_statement_history",
  "check_statement_duplicate",
  "search_web",
  "resolve_merchant",
  "classify_category",
  "list_pending_learning",
  "log_decision",
]);

/** Stub answers that keep the pipeline on its ordinary booking path. */
const DRY_RUN_STUBS = {
  insert_transaction: () => ({ id: "dry-run-transaction" }),
  reserve_transfer: () => ({ status: "reserved", entry: { id: "dry-run-transfer" } }),
  propose_learning: () => ({ offered: false, reason: "dry_run" }),
  learn_fact: () => ({ added: false, skipped: true, reason: "dry_run" }),
  notify_user: () => true,
};

// ── ToolRegistry ─────────────────────────────────────────────────

function shiftIsoDay(iso, days) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class ToolRegistry {
  constructor(config, memory) {
    this._config = config;
    this._memory = memory;
    this._cooldown = new NotificationCooldown();
    this._dedup = new DedupJournal(config.dedupDbPath);
    this._emailMsgId = null;
    this._emailRaw = null;
    this._imapHandler = null;
    this._markHandler = null;
    this._statementJournal = null;
    this._orchestrator = null;
    this._dryRunScope = new AsyncLocalStorage();
    this._calibrationScope = new AsyncLocalStorage();
    this._jevRowsCache = new Map();
  }

  setStatementJournal(journal) {
    this._statementJournal = journal;
  }

  setOrchestrator(orchestrator) {
    this._orchestrator = orchestrator;
  }

  setEmailContext(msgId, rawEmail, imapHandler) {
    this._emailMsgId = msgId;
    this._emailRaw = rawEmail;
    if (!imapHandler) {
      this._imapHandler = null;
      this._markHandler = null;
      return;
    }
    // The /process intake passes a read-only stub without inbox browsing.
    // It must not clobber the persistent IMAP handler, or list_inbox_emails
    // breaks with "listInbox is not a function" for every later call.
    if (typeof imapHandler.listInbox === "function") {
      this._imapHandler = imapHandler;
    } else if (!this._imapHandler) {
      this._imapHandler = imapHandler;
    }
    this._markHandler = imapHandler;
  }

  getToolSchemas() {
    return TOOLS.filter((t) => !(this.learningCommandsEnabled && t.name === "confirm_learning")).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
      },
    }));
  }

  /**
   * Get only the read-only tool schemas for Phase 1 LLM (3-phase design):
   * fetch_context (live accounts) + search_memory (account evidence lookup).
   * No mutation tools reach Phase 1.
   */
  getPhase1ToolSchemas() {
    const names = ["fetch_context", "search_memory"];
    return names.map((name) => {
      const t = TOOL_MAP[name];
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.schema,
        },
      };
    });
  }

  /**
   * Run `fn` with every write recorded instead of executed (#796). Returns
   * fn's result and the recorded calls, in order.
   */
  async dryRun(fn, { calibrate = false } = {}) {
    const calls = [];
    // Scoped to fn's own async context: the IMAP watcher shares this registry,
    // and a booking it makes meanwhile must never be stubbed out.
    const scoped = () => this._dryRunScope.run(calls, fn);
    const result = calibrate
      ? await this._calibrationScope.run({ searches: new Map() }, scoped)
      : await scoped();
    return { result, calls };
  }

  /** True inside a dry run that asked for Jev calibration scores. */
  calibrating() {
    return Boolean(this._calibrationScope.getStore() && this._dryRunScope.getStore());
  }

  async _dryRunTool(name, handler, args, calls) {
    if (name === "check_duplicate") {
      // Replayed mail is usually already booked: report the match, then carry
      // on so the run still shows what it would book.
      const duplicate = await handler.call(this, args);
      calls.push({ tool: name, args, would_be_duplicate: !!duplicate });
      return false;
    }
    if (name === "find_inserted_transfer") {
      // The unclaimed lookup is read-only; a claim would write.
      return handler.call(this, { ...args, alert_id: null });
    }
    if (DRY_RUN_READ_TOOLS.has(name)) return handler.call(this, args);
    if (name === "calibrate_jev") {
      // Read-only, but its answer is the point of the run: record it. The
      // email stays out of the record.
      const result = await handler.call(this, args);
      calls.push({ tool: name, args: { merchant: args?.merchant, as_of: args?.as_of }, result });
      return result;
    }
    calls.push({ tool: name, args });
    return DRY_RUN_STUBS[name] ? DRY_RUN_STUBS[name]() : { dry_run: true };
  }

  async executeTool(name, args) {
    const handler = this[`_handle_${name.replace(/-/g, "_")}`];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    const dryRunCalls = this._dryRunScope.getStore();
    if (dryRunCalls) return this._dryRunTool(name, handler, args, dryRunCalls);
    const result = await handler.call(this, args);
    logger.info({
      event: "tool_exec",
      tool: name,
      args: JSON.stringify(redactSensitive(args)).slice(0, 200),
      result:
        typeof result === "string"
          ? result.slice(0, 200)
          : JSON.stringify(redactSensitive(result)).slice(0, 200),
    });
    return result;
  }

  // ── IMAP inbox browsing handlers (on-demand, read-only) ────────

  async _handle_list_inbox_emails({ limit = 50 } = {}) {
    if (!this._imapHandler) {
      return { error: "IMAP not connected — no email inbox available" };
    }
    try {
      return await this._imapHandler.listInbox({ limit });
    } catch (e) {
      return { error: "Failed to list inbox: " + e.message };
    }
  }

  async _handle_read_inbox_email({ uid }) {
    if (!this._imapHandler) {
      return { error: "IMAP not connected — no email inbox available" };
    }
    try {
      const email = await this._imapHandler.readInboxEmail(uid);
      if (!email) {
        return { error: "Email with UID " + uid + " not found" };
      }
      return email;
    } catch (e) {
      return { error: "Failed to read email: " + e.message };
    }
  }

  async _handle_extract_inbox_pdf({ uid, password = "" } = {}) {
    if (!this._imapHandler) {
      return { error: "IMAP not connected — no email inbox available" };
    }
    try {
      return await this._imapHandler.extractInboxPdf(uid, password);
    } catch (e) {
      return { error: "Failed to extract PDF: " + e.message };
    }
  }

  // ── Memory tools ──────────────────────────────────────────────

  async _handle_search_memory({ query }) {
    if (!this._memory) return { results: [] };
    return { results: await this._memory.search(query) };
  }

  /** The wiki is the knowledge authority (#783); search_memory is its alias. */
  async _handle_search_wiki(args) {
    return this._handle_search_memory(args);
  }

  /**
   * Live accounts for write-time identity validation. Refuses instead of
   * returning an empty list when the accounts could not be read, so a failed
   * fetch cannot silently disable the check that keeps own-account facts out of
   * memory. Review round 2 on #561.
   */
  async _identityAccounts(budget_id) {
    const accounts = await this._handle_fetch_accounts({
      budget_id: budget_id || this._config.primaryBudgetFile,
    });
    if (!Array.isArray(accounts)) {
      throw new Error("account list unavailable for fact validation");
    }
    return accounts;
  }

  async _handle_learn_fact({ fact, budget_id }) {
    if (!this._memory)
      return { added: false, skipped: false, reason: "no memory store" };
    let accounts;
    try {
      accounts = await this._identityAccounts(budget_id);
    } catch (error) {
      return { added: false, skipped: true, reason: error.message };
    }
    return await this._memory.add(fact, accounts);
  }

  async _handle_list_facts() {
    if (!this._memory)
      return {
        facts: [],
        stats: { count: 0, maxFacts: 0, compactTo: 0 },
      };
    return { facts: this._memory.listFacts(), stats: this._memory.stats };
  }

  async _handle_compact_facts() {
    if (!this._memory) return { before: 0, after: 0, removed: 0 };
    return this._memory.compact();
  }

  async _handle_cleanup_facts() {
    if (!this._memory)
      return {
        before: 0,
        after: 0,
        removed: 0,
        normalised: 0,
        contradictions: [],
      };
    return this._memory.cleanup();
  }

  async _handle_update_fact({ old_text, new_text, budget_id }) {
    if (!this._memory) return { updated: false, found: false };
    let accounts;
    try {
      accounts = await this._identityAccounts(budget_id);
    } catch (error) {
      return { updated: false, found: false, reason: error.message };
    }
    const result = this._memory.update(old_text, new_text, accounts);
    if (result.updated) this._cooldown.clear();
    return result;
  }

  async _handle_delete_fact({ match_text }) {
    if (!this._memory) return { deleted: false, count: 0 };
    const result = this._memory.remove(match_text);
    if (result.deleted) this._cooldown.clear();
    return result;
  }

  // ── AB API tools ──────────────────────────────────────────────

  async _handle_fetch_budgets() {
    return this._get("/budgets", "");
  }

  async _handle_fetch_accounts({ budget_id }) {
    if (!budget_id) return { error: "budget_id is required" };
    const accounts = await this._get("/accounts", budget_id);
    if (!Array.isArray(accounts)) return accounts;
    // Filter out closed accounts — LLM should only see active ones
    const active = accounts.filter((a) => !a.closed);
    return this._enrichWithBalances(active, budget_id);
  }

  async _handle_fetch_categories({ budget_id }) {
    if (!budget_id) return { error: "budget_id is required" };
    return this._get("/categories", budget_id);
  }

  async _handle_fetch_payees({ budget_id }) {
    if (!budget_id) return { error: "budget_id is required" };
    return this._get("/payees", budget_id);
  }

  async _handle_fetch_schedules({ budget_id }) {
    if (!budget_id) return { error: "budget_id is required" };
    return this._get("/schedules", budget_id);
  }

  /**
   * True when an un-posted `posts_transaction` schedule will materialise a row
   * matching this alert's magnitude on (or within a day of) the date.
   *
   * Matching is deliberately blind to the schedule's own account id: the
   * production incident (#586) had the alert land on OCBC 360 while the due
   * `Prepare: Rent` schedule was owned by the other leg's account, because the
   * schedule's rule creates the paired row. `check_duplicate` cannot see any of
   * this — it only reads posted rows.
   *
   * Throws when the schedule list cannot be read: an unreadable list is not
   * proof of absence, and the caller must hold rather than risk a second row.
   */
  async _handle_check_schedule_collision({ budget_id, amount_cents, date }) {
    if (!budget_id || !date) return false;
    const amount = normalizeAmountCents(amount_cents);
    if (amount === null || amount === undefined) return false;
    const schedules = await this._get("/schedules", budget_id);
    if (!Array.isArray(schedules)) {
      throw new Error("schedule list unavailable");
    }
    const target = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(target)) return false;
    const DAY = 24 * 60 * 60 * 1000;
    return schedules.some((s) => {
      if (!s || s.posts_transaction === false || s.completed) return false;
      const scheduled = normalizeAmountCents(s.amount);
      if (scheduled === null || Math.abs(scheduled) !== Math.abs(amount))
        return false;
      const next = Date.parse(`${s.next_date}T00:00:00Z`);
      return Number.isFinite(next) && Math.abs(next - target) <= DAY;
    });
  }

  async _handle_fetch_budget_month({ budget_id, month }) {
    if (!budget_id) return { error: "budget_id is required" };
    // The actual-api route only accepts YYYY-MM; validate here so REST and
    // orchestrator callers get a validation error instead of an opaque 500.
    // The month range is checked too, so "2026-13" cannot reach Actual.
    if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return { error: "month must be YYYY-MM" };
    }
    // Omitting the month lets actual-api default to the current month (in
    // UTC), so a caller near a local month boundary should pass it.
    return this._get("/budget-month", budget_id, month ? { month } : {});
  }

  async _handle_fetch_context({ budget_id }) {
    if (!budget_id) return { error: "budget_id is required" };
    const [accounts, categories, payees] = await Promise.all([
      this._get("/accounts", budget_id),
      this._get("/categories", budget_id),
      this._get("/payees", budget_id),
    ]);
    if (!Array.isArray(accounts))
      return { accounts, categories, payees };

    const activeAccounts = accounts.filter((a) => !a.closed);
    const enriched = await this._enrichWithBalances(
      activeAccounts,
      budget_id,
    );
    return { accounts: enriched, categories, payees };
  }

  async _handle_fetch_recent_transactions({
    budget_id,
    id,
    account_id,
    days = 7,
  }) {
    if (!budget_id) return { error: "budget_id is required" };
    // Fetch single transaction by ID
    if (id) {
      const txn = await this._get(
        `/transactions/${encodeURIComponent(id)}`,
        budget_id,
      );
      if (txn && !txn.error) {
        txn.budget_id = budget_id;
      }
      return txn;
    }
    // Fetch recent transactions
    const params = {};
    if (account_id) params.account_id = account_id;
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      params.since_date = since.toISOString().slice(0, 10);
    }
    const txns = await this._get("/transactions", budget_id, params);
    if (Array.isArray(txns)) {
      return txns.map((t) => ({ ...t, budget_id }));
    }
    return txns;
  }

  /**
   * Canonicalise a name for insert_transaction.
   *
   * Duplicate names follow resolvePayeeMatch, which also supplies the payee ID
   * so the caller never re-resolves the name against a second, possibly
   * different, payee list. Unlike update_transaction, an UNKNOWN name is not an
   * error here — it falls back to "Misc" — because insert receives a raw
   * imported description rather than a deliberate payee choice. An AMBIGUOUS
   * name throws: silently booking whichever payee came first is the defect #483
   * tracks, and "Misc" would hide the collision. Issue #483.
   *
   * @returns {Promise<{name: string, payeeId: string|null, payee?: object}>} the canonical name
   *   and, when the live list matched it, the matching payee's ID and object
   */
  async _validate_payee(payee_name, budget_id = "") {
    if (!payee_name) return { name: "Misc", payeeId: null };
    let payees = null;
    try {
      payees = await this._get("/payees", budget_id);
    } catch {
      // A payee list that cannot be read falls through to memory search.
    }
    if (Array.isArray(payees)) {
      const match = resolvePayeeMatch(payees, payee_name);
      if (match?.error) throw ambiguousPayeeError(match.error);
      if (match) return { name: match.name, payeeId: match.id || null, payee: match };
    }
    // Fall back to semantic memory search if available
    if (this._memory) {
      const results = await this._memory.search(payee_name);
      if (results && results.length > 0) {
        // Only a hit that names this payee may supply its canonical name.
        // Issue #471.
        const hit = results.find((r) => factNamesMerchant(r.text, payee_name));
        const payeeMatch = hit && (hit.text || "").match(/maps to (.+?) payee/i);
        if (payeeMatch) return { name: payeeMatch[1], payeeId: null };
      }
    }
    return { name: "Misc", payeeId: null };
  }

  async _handle_insert_transaction(args) {
    const budget_id = args.budget_id;
    if (!budget_id) return { error: "budget_id is required" };
    if (!args.account_id) return { error: "account_id is required" };
    if (!args.date) return { error: "date is required" };
    if (!args.amount_cents && args.amount_cents !== 0)
      return { error: "amount_cents is required" };
    // A quoted integer is an accepted shape: the route trims and coerces it, so
    // normalise it here too, or the POST body and the dedup journal would carry
    // a string that hashes differently from the same row's number.
    const amountCents = normalizeAmountCents(args.amount_cents);

    // The payee is either one explicit ID or one resolved name. A caller-supplied
    // ID is sent alone, because its name is validated from that same ID while the
    // caller's name may resolve to a different payee of the same name. A name is
    // sent with the ID it resolved to, so the pair always agrees. Issue #483.
    // Unlike update_transaction, an unknown name is not an error — it becomes
    // "Misc" (see _validate_payee) — while an ambiguous name is refused.
    const explicitId = args.payee_id || null;
    // The far-side-found insert must carry NO transfer payee at all (#598).
    // Clearing `payee_id` is not enough: with it falsy this handler falls into
    // the name branch, resolves `imported_description` (the destination account
    // name) against the live payee list, and sends that transfer payee anyway —
    // which makes Actual's `runTransfers` create a duplicate counterpart and
    // link the row before the pair can be joined (review round 2, R2-H1). So the
    // suppression is explicit and applies to the derived payee too.
    const suppressTransferPayee = args.suppress_transfer_payee === true;
    let payeeId = explicitId;
    let payee_name = null;
    // The insert path's row always sits on `args.account_id`, so the source
    // defaults to it when the caller does not pass one explicitly.
    const validateTransferTarget = (payee, sourceAccountId = args.account_id) =>
      this._validateTransferTarget(payee, budget_id, sourceAccountId);
    if (suppressTransferPayee) {
      // Both legs are already present: the row goes in plain, unclassified, and
      // the link route sets both legs' payees to each other afterwards.
      payeeId = null;
      payee_name = "Misc";
    } else if (explicitId) {
      // An explicit ID comes from the caller or from Phase 2 transfer detection,
      // so it is validated here and never second-guessed by a name lookup.
      let payees = null;
      try {
        payees = await this._get("/payees", budget_id);
      } catch {
        // Fail closed: an unvalidatable ID must not reach the API.
        return {
          error: `Could not validate payee_id "${explicitId}": payee list unavailable.`,
        };
      }
      if (!Array.isArray(payees))
        return { error: `Could not validate payee_id "${explicitId}".` };
      const explicit = payees.find((p) => p.id === explicitId);
      if (!explicit)
        return { error: `Payee ID "${explicitId}" not found in payee list.` };
      const transferError = await validateTransferTarget(explicit);
      if (transferError) return { error: transferError };
      // The journal keys duplicates by payee name, so an explicit ID must still
      // record a non-empty name; fall back to the imported description when the
      // payee itself has no name.
      payee_name = explicit.name || args.imported_description || null;
    } else {
      let validated = null;
      try {
        validated = await this._validate_payee(
          args.imported_description || "",
          budget_id,
        );
      } catch (e) {
        // An ambiguous name is refused with the candidate payee IDs. Only that
        // refusal is tagged; a transport code stays out of the tool result.
        return e.code === AMBIGUOUS_PAYEE
          ? { error: e.message, code: e.code }
          : { error: e.message };
      }
      payee_name = validated.name;
      payeeId = validated.payeeId;
      if (payeeId) {
        // _validate_payee returns an ID for a bare matching name, so it needs
        // the same transfer-target check as a caller-supplied ID.
        const transferError = await validateTransferTarget(validated.payee);
        if (transferError) return { error: transferError };
      } else if (payee_name && payee_name !== "Misc") {
        // Only a memory-resolved name needs a second lookup: the live list did
        // not supply an ID above.
        try {
          const payees = await this._get("/payees", budget_id);
          if (!Array.isArray(payees))
            return { error: "Could not validate transfer destination." };
          const match = resolvePayeeMatch(payees, payee_name);
          if (match?.error) return { error: match.error, code: match.code };
          if (match) {
            const transferError = await validateTransferTarget(match);
            if (transferError) return { error: transferError };
            payeeId = match.id;
            payee_name = match.name;
          }
        } catch {
          return { error: "Could not validate transfer destination." };
        }
      }
    }
    let categoryId = args.category_id || null;
    if (categoryId) {
      try {
        const categories = await this._get("/categories", budget_id);
        const match = Array.isArray(categories)
          ? categories.find((c) => c.id === categoryId)
          : null;
        if (!match) {
          // Fall back to "Fun Money"
          const funMoney = Array.isArray(categories)
            ? categories.find((c) => c.name === "Fun Money")
            : null;
          categoryId = funMoney ? funMoney.id : categoryId;
        }
      } catch {
        // Keep original category_id if validation fails
      }
    }

    // A payee ID wins over a name, so an explicit ID is sent alone. Suppression
    // overrides that: it nulls payeeId, so the name must go out (#621).
    const sendPayeeName = suppressTransferPayee || !explicitId;
    const result = await this._post(
      "/transactions",
      {
        account: args.account_id,
        date: args.date,
        amount: amountCents,
        ...(sendPayeeName ? { payee_name: payee_name || "Misc" } : {}),
        notes: args.notes || "",
        cleared: false,
        ...(payeeId ? { payee: payeeId } : {}),
        ...(categoryId ? { category: categoryId } : {}),
      },
      budget_id,
    );
    // Record in dedup journal AFTER successful insert (not before)
    this._dedup.record(
      args.date,
      amountCents,
      args.account_id,
      payee_name || "",
    );
    // Inject budget_id into result for LLM context
    if (result && !result.error) {
      result.budget_id = budget_id;
    }
    return result;
  }

  /**
   * Internal gate for issue #574: is this credit a transfer already booked
   * INTO the credited account? Kept out of TOOLS so it is never advertised to
   * the model (`executeTool` still dispatches any `_handle_*` name a
   * hallucinated tool call supplies, as it already does for reserve_transfer).
   */
  async _handle_find_inserted_transfer(args) {
    // Only the email being processed may claim a leg (issue #578). The
    // orchestrator names it; pasted text names none and so never claims, even
    // though the last email's uid is still in context. Any other id (a
    // hallucinated call) falls back to the read-only match.
    const current = this._emailMsgId == null ? "" : String(this._emailMsgId);
    const claim =
      current && args?.alert_id != null && String(args.alert_id) === current
        ? current
        : null;
    return this._dedup.findInsertedTransferInto({ ...args, alert_id: claim });
  }

  /**
   * Reserve the far side of a bare movement, and link the pair once both
   * halves are known (#598).
   *
   * Reserved review decision: this is deliberately NOT an automatic
   * reconciler. An earlier draft matched rows on (account, amount, window)
   * and wrote the link itself, but that match cannot tell a real sibling
   * apart from an unrelated movement of the same size on the same day — the
   * trade-off already tracked in #578 — so a wrong match would silently
   * rewrite the user's books. The candidate step above is read-only and
   * refuses an ambiguous match; this step takes the ids explicitly, so the
   * write is always attributable to a decision someone made.
   */
  async _handle_link_transfer_pair({ budget_id, outgoing_id, incoming_id } = {}) {
      if (!budget_id || !outgoing_id || !incoming_id) {
          return { error: "budget_id, outgoing_id and incoming_id are required" };
      }
      try {
          return await this._post("/transactions/link-transfer", {
              budget_id,
              outgoing_id,
              incoming_id,
          });
      } catch (error) {
          logger.warn({ event: "link_transfer_pair_failed", error: error.message });
          return { error: error.message };
      }
  }

  async _handle_reserve_transfer(args) {
    let reservation = this._dedup.reserveTransfer(args);
    // The far side may already be booked, because an alert can name the deposit
    // and not the transfer (issue #557). Report it; never touch it. No field the
    // route returns can prove a row is ours: every row this pipeline inserts is
    // uncleared, `Misc` is also the unknown-merchant fallback, and Actual
    // exposes no created-at, so deleting on this match would risk a real
    // deposit. The caller warns the user instead.
    if (reservation.status === "reserved") {
        try {
            const date = new Date(args.occurred_at).toISOString().slice(0, 10);
            const [rows, payees] = await Promise.all([
                this._get("/transactions", args.budget_id, {
                    since_date: date,
                    until_date: date,
                    account_id: args.destination_account_id,
                }),
                this._get("/payees", args.budget_id),
            ]);
            const misc = Array.isArray(payees)
                ? payees.find((p) => p.name === "Misc" && !p.transfer_acct)
                : null;
            const candidate = (Array.isArray(rows) ? rows : []).find(
                (tx) =>
                    misc &&
                    tx.amount === Math.abs(args.amount_cents) &&
                    !tx.transfer_id &&
                    tx.cleared === false &&
                    tx.payee === misc.id,
            );
            if (candidate)
                reservation = {
                    ...reservation,
                    far_side_candidate: candidate.id,
                };
        } catch {
            // Cannot read the destination account: book normally.
        }
    }
    // A transfer booked outside the journal (linked by hand, or by a path that
    // never reserved) leaves the journal empty, so "reserved" would book it a
    // second time. Exactly one already-linked transfer row of this amount to this
    // payee on the source account that day is the same transfer. Two genuine
    // identical same-day transfers would be booked once; that is the accepted
    // trade-off against a duplicate pair.
    if (reservation.status === "reserved") {
        try {
            const date = new Date(args.occurred_at).toISOString().slice(0, 10);
            const rows = await this._get("/transactions", args.budget_id, {
                since_date: date,
                until_date: date,
                account_id: args.source_account_id,
            });
            const existing = (Array.isArray(rows) ? rows : []).filter(
                (tx) =>
                    tx.amount === -Math.abs(args.amount_cents) &&
                    tx.transfer_id &&
                    (tx.payee === args.payee_id || tx.payee_id === args.payee_id),
            );
            if (existing.length === 1) {
                this._dedup.markTransferInserted(reservation.entry.id, existing[0].id || null);
                return { status: "inserted", entry: this._dedup.getTransfer(reservation.entry.id) };
            }
        } catch {
            // Cannot read the source account: book normally.
        }
    }
    if (reservation.status !== "pending") return reservation;

    // A timeout may occur after Actual committed. Reconcile the exact source
    // account, amount, date, and transfer payee before allowing another insert.
    try {
      const date = new Date(args.occurred_at).toISOString().slice(0, 10);
      const transactions = await this._get("/transactions", args.budget_id, {
        since_date: date,
        until_date: date,
        account_id: args.source_account_id,
      });
      const matches = Array.isArray(transactions)
        ? transactions.filter((tx) =>
            tx.amount === -Math.abs(args.amount_cents) &&
            (tx.payee === args.payee_id || tx.payee_id === args.payee_id),
          )
        : [];
      if (matches.length === 1) {
        this._dedup.markTransferInserted(reservation.entry.id, matches[0].id || null);
        return { status: "inserted", entry: this._dedup.getTransfer(reservation.entry.id) };
      }
      // Only release a reservation after an exact Actual lookup proves absent.
      const created = Date.parse(`${reservation.entry.created_at}Z`);
      if (matches.length === 0 && Number.isFinite(created) && Date.now() - created > 5 * 60 * 1000) {
        this._dedup.markTransferFailed(reservation.entry.id);
        reservation = this._dedup.reserveTransfer(args);
      }
    } catch {
      // Cannot prove Actual absence: retain pending reservation.
    }
    return reservation;
  }

  /**
   * Rebook the one Misc debit a broker deposit accounts for as the transfer
   * to that broker. A bank alert that only says "Withdrawal" names no
   * destination, so it books as Misc; the broker's own record of the deposit
   * (the portfolio sync's IBKR flex CashTransactions row) carries the exact
   * amount. The bank leg may precede the deposit by a few days.
   *
   * Exactly one unlinked, uncleared Misc debit of that amount, off the broker's
   * own account, inside the window: patch it to the broker's transfer payee and
   * the named category, and tell the user. Anything else changes nothing. A
   * rebooked row is no longer Misc, so a flex window that repeats the deposit
   * is a no-op.
   */
  async _handle_match_broker_deposit({
    budget_id,
    amount_cents,
    on_date,
    payee_name,
    category_name,
    window_days = 3,
  } = {}) {
    const amount = Number(amount_cents);
    if (!budget_id || !on_date || !payee_name || !Number.isInteger(amount) || amount <= 0) {
      return { matched: 0, reason: "invalid_input" };
    }
    const since = shiftIsoDay(on_date, -Math.max(0, Number(window_days) || 0));
    const until = shiftIsoDay(on_date, 1);
    const [rows, payees] = await Promise.all([
      this._get("/transactions", budget_id, { since_date: since, until_date: until }),
      this._get("/payees", budget_id),
    ]);
    const list = Array.isArray(payees) ? payees : [];
    const misc = list.find((p) => p.name === "Misc" && !p.transfer_acct);
    const broker = list.find((p) => p.name === payee_name && p.transfer_acct);
    if (!misc || !broker) return { matched: 0, reason: "payee_missing" };
    const candidates = (Array.isArray(rows) ? rows : []).filter(
      (tx) =>
        tx.amount === -amount &&
        tx.payee === misc.id &&
        !tx.transfer_id &&
        tx.cleared === false &&
        tx.account !== broker.transfer_acct &&
        (!tx.date || (tx.date >= since && tx.date <= until)),
    );
    if (candidates.length !== 1) return { matched: 0, candidates: candidates.length };
    const row = candidates[0];

    let categoryId;
    if (category_name) {
      const categories = await this._get("/categories", budget_id);
      categoryId = (Array.isArray(categories) ? categories : []).find(
        (c) => c.name === category_name,
      )?.id;
    }
    const updated = await this._handle_update_transaction({
      id: row.id,
      budget_id,
      payee_id: broker.id,
      ...(categoryId ? { category_id: categoryId } : {}),
    });
    if (!updated || updated.error) {
      return { matched: 0, reason: "update_failed", error: updated?.error || "no response" };
    }
    const category = categoryId ? ` / ${category_name}` : "";
    await this._handle_notify_user({
      message: `Matched the ${(amount / 100).toFixed(2)} withdrawal on ${row.date || on_date} to a ${payee_name} deposit, rebooked as ${payee_name}${category}`,
    });
    return { matched: 1, id: row.id, account_id: row.account };
  }

  async _handle_find_link_candidate({ budget_id, account_id, amount_cents, on_date, notes_contains } = {}) {
    if (!budget_id || !account_id || !on_date || amount_cents == null) {
      return { candidate: null, matches: 0 };
    }
    // Read-only, and deliberately conservative — this decides whether an
    // already-booked row gets rewritten, so an ambiguous or absent match must
    // leave the books alone (issues #557, #578, #598). The row must be the
    // OTHER leg of this transfer: the opposite sign of the leg being booked, on
    // the other account, uncleared, unlinked, and still parked on the
    // unclassified `Misc` payee — the shape this pipeline writes when it cannot
    // classify a movement. Exactly one such row may exist; two is a data
    // question for the user, not a guess.
    //
    // `matches` is reported as well as the candidate because the caller must
    // tell "no far side exists" (book the pair the normal way) apart from
    // "several rows could be the far side" (book nothing and tell the user).
    // Collapsing both to `candidate: null` made the caller unable to avoid
    // creating a second counterpart row (issue #598 review round 1).
    try {
      const [rows, payees] = await Promise.all([
        this._get("/transactions", budget_id, {
          // ±1 day: the far row's date may come from the UTC (LLM) or SGT
          // (deterministic) basis, which differ by a day for 00:00-08:00 SGT
          // alerts (#619). The wider window only feeds the fail-closed check;
          // linking still requires the exact day.
          since_date: shiftIsoDay(on_date, -1),
          until_date: shiftIsoDay(on_date, 1),
          account_id,
        }),
        this._get("/payees", budget_id),
      ]);
      const misc = Array.isArray(payees)
        ? payees.find((p) => p.name === "Misc" && !p.transfer_acct)
        : null;
      const wanted = -Math.sign(amount_cents) * Math.abs(amount_cents);
      const plausible = (Array.isArray(rows) ? rows : []).filter(
        (tx) => tx.account === account_id && tx.amount === wanted && !tx.transfer_id,
      );
      const matches = plausible.filter(
        (tx) =>
          (!tx.date || tx.date === on_date) &&
          tx.cleared === false &&
          misc &&
          tx.payee === misc.id &&
          (!notes_contains || String(tx.notes || "").includes(notes_contains)),
      );
      if (matches.length === 0 && plausible.length > 0) {
        // A far row plausibly exists (same account, opposite amount, unlinked)
        // but is not the exact shape: not "no far side". Caller must hold
        // rather than book a duplicate counterpart (#619).
        return { candidate: null, matches: 0, unmatched: plausible.length };
      }
      if (matches.length !== 1) return { candidate: null, matches: matches.length };
      return { candidate: { id: matches[0].id, account_id }, matches: 1 };
    } catch (error) {
      logger.warn({
        event: "find_link_candidate_failed",
        error: error.message,
      });
      // Unreadable is not "none": the caller must not insert on a failed read.
      return { candidate: null, matches: null };
    }
  }

  async _handle_complete_transfer({ id, actual_transaction_id }) {
    this._dedup.markTransferInserted(id, actual_transaction_id || null);
    return true;
  }

  async _handle_check_duplicate({
    date,
    amount_cents,
    account_id,
    payee_name,
    budget_id,
  }) {
    // A quoted integer is an accepted extraction shape, but Actual rows carry
    // numbers: compare numerically so strict equality can match, and hash the
    // journal on the same value it would record either way.
    const amount = normalizeAmountCents(amount_cents);
    // Check local dedup first, then AB API
    if (
      this._dedup.checkDuplicate(date, amount, account_id, payee_name || "")
    ) {
      return true;
    }
    return this._check_ab_duplicate(date, amount, account_id, budget_id);
  }

  async _check_ab_duplicate(date, amount_cents, account_id, budget_id = "") {
    try {
      // Expand to ±1 day to handle bank posting lag;
      // query all transactions regardless of cleared status
      const d = new Date(date + "T00:00:00Z");
      const before = new Date(d);
      before.setUTCDate(before.getUTCDate() - 1);
      const after = new Date(d);
      after.setUTCDate(after.getUTCDate() + 1);
      const since = before.toISOString().slice(0, 10);
      const until = after.toISOString().slice(0, 10);

      const transactions = await this._get("/transactions", budget_id, {
        since_date: since,
        until_date: until,
        account_id: account_id,
      });
      if (!Array.isArray(transactions)) return false;
      return transactions.some(
        (tx) => tx.amount === amount_cents && tx.date >= since && tx.date <= until,
      );
    } catch {
      return false;
    }
  }

  // ── PDF extraction ────────────────────────────────────────────

  async _handle_extract_pdf_text({ pdf_bytes_b64, password }) {
    const pdfBytes = Buffer.from(pdf_bytes_b64, "base64");
    return extractPdfFromBuffer(pdfBytes, password || null);
  }

  // ── Reconciliation tools ──────────────────────────────────────

  async _handle_reconcile_transaction({
    ab_transaction_ids,
    statement_ref = "",
    budget_id,
  }) {
    if (!budget_id) return { error: "budget_id is required" };
    if (!Array.isArray(ab_transaction_ids) || ab_transaction_ids.length === 0)
      return { error: "ab_transaction_ids must be a non-empty array" };

    const results = [];
    for (const id of ab_transaction_ids) {
      try {
        // 1. Fetch current notes by immutable ID (fresh GET on every retry).
        const txn = await this._get(
          `/transactions/${encodeURIComponent(id)}`,
          budget_id,
        );
        const currentNotes =
          txn && !txn.error && txn.notes ? String(txn.notes) : "";
        // 2. Compose canonical notes, preserving any existing Merchant line
        //    and user notes (a GET/compose failure below does not clear).
        const composed = composeNotes({
          notes: currentNotes,
          statementRef: statement_ref,
        });
        // 3. Clear with the complete composed notes.
        const body = composed ? { notes: composed } : {};
        const r = await this._post(
          `/transactions/${encodeURIComponent(id)}/clear`,
          body,
          budget_id,
        );
        results.push({ id, status: r.status || "cleared" });
      } catch (e) {
        results.push({ id, status: "error", error: e.message });
      }
    }
    return {
      cleared: results.filter((r) => r.status === "cleared").length,
      failed: results.filter((r) => r.status === "error").length,
      results,
    };
  }

  async _handle_unclear_transaction({
    ab_transaction_ids,
    budget_id,
  }) {
    if (!budget_id) return { error: "budget_id is required" };
    if (!Array.isArray(ab_transaction_ids) || ab_transaction_ids.length === 0)
      return { error: "ab_transaction_ids must be a non-empty array" };

    const results = [];
    for (const id of ab_transaction_ids) {
      try {
        const r = await this._post(
          `/transactions/${id}/unclear`,
          {},
          budget_id,
        );
        results.push({ id, status: r.status || "uncleared" });
      } catch (e) {
        results.push({ id, status: "error", error: e.message });
      }
    }
    return {
      uncleared: results.filter((r) => r.status === "uncleared").length,
      failed: results.filter((r) => r.status === "error").length,
      results,
    };
  }

  async _handle_fetch_unreconciled_transactions({
    account_id,
    date_from,
    date_to,
    budget_id,
  }) {
    if (!budget_id) return { error: "budget_id is required" };
    return this._get("/transactions", budget_id, {
      account_id,
      cleared: "false",
      since_date: date_from,
      until_date: date_to,
    });
  }

  // ── Statement journal tools ───────────────────────────────────

  async _handle_record_statement({
    account_id,
    period_start,
    period_end,
    matched_count,
    outlier_count,
    budget_id,
    total_amount_cents,
    due_date,
    currency = "SGD",
  }) {
    if (!this._statementJournal) {
      throw new Error("Statement journal not configured");
    }
    const bid = budget_id || this._config.primaryBudgetFile;
    const sid = this._statementJournal.recordStatement(
      account_id,
      bid,
      period_start,
      period_end,
      matched_count,
      outlier_count,
      total_amount_cents ?? null,
      due_date ?? null,
      currency,
    );
    return { id: sid, status: "recorded" };
  }

  async _handle_fetch_statement_history({
    account_id,
    period_start,
    period_end,
  }) {
    if (!this._statementJournal) {
      throw new Error("Statement journal not configured");
    }
    return this._statementJournal.checkProcessed(
      account_id,
      period_start,
      period_end,
    );
  }

  // ── Email / notify tools ──────────────────────────────────────

  async _handle_mark_email_read({ uid } = {}) {
    const marker = this._markHandler ?? this._imapHandler;
    if (!marker) {
      return { error: "IMAP not connected — no email inbox available" };
    }
    if (uid != null && !(Number.isInteger(uid) && uid > 0)) {
      return { error: "Invalid uid — must be a positive integer" };
    }
    const targetUid = uid != null ? uid : this._emailMsgId;
    if (targetUid == null) {
      return { error: "No email to mark as read — provide a uid or read an email first" };
    }
    try {
      await marker.markRead(targetUid);
      return true;
    } catch (e) {
      return { error: "Failed to mark email read: " + e.message };
    }
  }

  /**
   * While Hermes's processing request runs (#783), notifications go to the
   * request so Hermes delivers them once; null restores normal delivery.
   */
  setNotificationSink(sink) {
    this._notificationSink = sink || null;
  }

  /** Same for learning offers: returned as the request's mapping candidate. */
  setOfferSink(sink) {
    this._offerSink = sink || null;
  }

  async _handle_notify_user({ message }) {
    if (this._notificationSink) return this._notificationSink(message);
    if (this._emailMsgId && this._cooldown.shouldSuppress(this._emailMsgId)) {
      logger.info({ event: "notify_user_cooldown", message });
      return true;
    }
    const url = `${this._config.notifyUrl}`;
    const body = JSON.stringify({ message });
    const headers = { "Content-Type": "application/json" };
    // Replay note (#665): this signature covers the body alone, with no
    // timestamp and no nonce, so a captured request stays valid forever. The
    // verifier is the upstream Hermes gateway, which recomputes the HMAC over
    // the raw body and enforces no freshness window, so signing anything else
    // here silently breaks notify. Replay defence has to start at the gateway.
    if (this._config.notifySecret) {
      const crypto = await import("crypto");
      const sig = crypto
        .createHmac("sha256", this._config.notifySecret)
        .update(body)
        .digest("hex");
      headers["X-Webhook-Signature"] = sig;
    }
    let r;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        r = await fetch(url, {
          method: "POST",
          headers,
          body,
        });
        break;
      } catch (e) {
        const errorCode = e?.cause?.code ?? e?.code;
        if (
          attempt === 0 &&
          RETRYABLE_NOTIFY_ERROR_CODES.has(errorCode)
        ) {
          continue;
        }
        logger.error({
          event: "notify_user_failed",
          error: e.message,
          message,
        });
        return false;
      }
    }
    if (!r.ok) {
      logger.error({
        event: "notify_user_failed",
        status: r.status,
        message,
      });
      return false;
    }
    if (this._emailMsgId) this._cooldown.record(this._emailMsgId);
    logger.info({ event: "notify_user_sent", message });
    return true;
  }

  async _handle_log_decision({ action, reasoning }) {
    const entry = {
      action,
      reasoning,
      timestamp: new Date().toISOString(),
    };
    if (this._config.logLevel !== "ERROR") {
      logger.info(entry);
    }
    return true;
  }

  async _handle_submit_decision(args) {
    // No-op handler — the decision is extracted from the tool call
    // arguments by the orchestrator in _runPhase1.
    return { accepted: true };
  }

  async _handle_extract_email_content({
    include_headers = false,
    password = "",
  } = {}) {
    if (!this._emailRaw) return "";
    // When password is provided, delegate to full extractEmailContent
    // which handles PDF attachments and decryption via qpdf
    if (password) {
      const raw = Buffer.isBuffer(this._emailRaw)
        ? this._emailRaw
        : Buffer.from(String(this._emailRaw), "utf8");
      return extractEmailContent(raw, password);
    }
    const raw = Buffer.isBuffer(this._emailRaw)
      ? this._emailRaw
      : Buffer.from(String(this._emailRaw), "utf8");
    try {
      const parsed = await simpleParser(raw);
      if (include_headers) {
        const headers = [];
        if (parsed.subject) headers.push(`Subject: ${parsed.subject}`);
        if (parsed.from) headers.push(`From: ${parsed.from.text}`);
        if (parsed.to) headers.push(`To: ${parsed.to.text}`);
        if (parsed.date) headers.push(`Date: ${parsed.date}`);
        const headerBlock = headers.join("\n");
        const body = parsed.text || "";
        return headerBlock ? `${headerBlock}\n\n${body}` : body;
      }
      return parsed.text || "";
    } catch {
      // Fall back to raw text if parsing fails
      return Buffer.isBuffer(this._emailRaw)
        ? this._emailRaw.toString("utf8")
        : String(this._emailRaw);
    }
  }

  async _handle_check_statement_duplicate({
    date,
    amount_cents,
    account_id,
    budget_id = "",
  }) {
    // Check local dedup first, then AB API
    if (this._dedup.checkExact(date, amount_cents, account_id)) {
      return true;
    }
    return this._check_ab_duplicate(date, amount_cents, account_id, budget_id);
  }

  // ── Merchant resolution tools ─────────────────────────────────

  async _handle_search_web({ merchant }) {
    const apiKey = this._config.braveSearchApiKey;
    if (!apiKey) return { results: [] };
    try {
      // Sanitize: trim, strip special characters, truncate to 100 chars
      const sanitized = (merchant || "")
        .trim()
        .replace(/[^\w\s-]/g, "")
        .slice(0, 100);
      const q = encodeURIComponent(sanitized);
      const r = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${q}&count=5&search_lang=en`,
        { headers: { "X-Subscription-Token": apiKey } },
      );
      if (!r.ok) return { results: [] };
      const data = await r.json();
      const results = (data.web?.results || []).slice(0, 5).map((item) => ({
        title: item.title || "",
        url: item.url || "",
        description: item.description || "",
      }));
      return { results };
    } catch {
      return { results: [] };
    }
  }

  async _handle_resolve_merchant({
    merchant,
    budget_id,
    evidence,
    direction,
    amount_cents,
    currency,
    no_search,
    no_memory,
  }) {
    if (!budget_id) return { error: "budget_id is required" };
    const budgetId = budget_id;
    // `no_memory`: the caller already decided memory for this counterparty
    // (an incoming person credit, whose amount rules outrank a plain name).
    if (this._memory && !no_memory) {
      try {
        const memResults = await this._memory.search(merchant);
        if (memResults && memResults.length > 0) {
          for (const r of memResults) {
            // A hit for a different merchant must never supply this one's payee.
            // Issue #471: a weakly similar neighbour booked an AliPay charge to
            // the neighbour's payee and then to that payee's category.
            if (!factNamesMerchant(r.text, merchant)) continue;
            const match = (r.text || "").match(/maps to (.+?) payee/i);
            if (match) return { payee: match[1], source: "memory" };
          }
        }
      } catch {
        // Memory search failed — fall through
      }
    }

    // An unverified web/LLM classification is not durable merchant evidence.
    // Returning or learning it caused a clinic payment to become a permanent
    // Petrol mapping (#587). The Jev tier below is different in kind: it is
    // validated against the real payee list and thresholds, it only runs when the
    // orchestrator supplies the email as evidence, and its answer is never
    // learned here (a user must confirm it, #720).
    // An offer for this merchant is still waiting for the user's answer: reuse
    // it, so a repeat alert costs no search and no Jev call.
    if (evidence?.text) {
      const pending = await this._pendingAnswer(merchant, budgetId);
      if (pending) return pending;
    }
    if (evidence?.text && this._config.jevApiKey) {
      // Memory missed, so this merchant is new: one web search gives Jev more
      // than the descriptor to go on. The results are evidence, never learned.
      // A person's name is never searched (`no_search`): the web knows nothing
      // useful about a private transfer, so Jev reads the email alone.
      // A calibration run already searched this merchant: reuse it.
      const searched = this.calibrating() ? this._calibrationScope.getStore().searches.get(merchant) : undefined;
      const search = searched !== undefined
        ? searched
        : this._config.firecrawlApiKey && !no_search
          ? await searchMerchant({ config: this._config, descriptor: merchant, currency })
          : null;
      const withSearch = search ? { search } : {};
      try {
        const payees = await this._get("/payees", budgetId);
        const variant = this._config.jevPromptVariant || "v1";
        const history =
          variant === "v2" ? await this._jevHistory({ budgetId, payees, merchant }) : null;
        const result = await classifyPayee({
          config: this._config,
          merchant,
          direction,
          amountCents: amount_cents,
          currency,
          evidence,
          payees,
          variant,
          history,
          context: this._jevContext(merchant),
          ...withSearch,
        });
        if (result.payee) {
          return {
            payee: result.payee,
            source: "jev",
            runner_up: result.runnerUp?.payee || null,
            confidence: result.confidence,
            evidence_score: result.evidenceScore,
            ...withSearch,
          };
        }
      } catch (error) {
        logger.warn({ event: "jev_tier_failed", error: error.message });
      }
      return { payee: "Misc", source: "fallback", ...withSearch };
    }
    return { payee: "Misc", source: "fallback" };
  }

  /** Jev's lines about this alert: an Amaze location, the owner's home (jev.js alertContext). */
  _jevContext(merchant) {
    let facts = [];
    try {
      facts = this._memory?.listFacts?.() || [];
    } catch {
      // No facts read: Jev still gets the Amaze line.
    }
    return alertContext({ merchant, facts });
  }

  /**
   * The owner's bookings as Jev `v2` context (jev.js payeeHistory). A year of
   * rows is read once per budget every ten minutes; a failed read gives no
   * history, which `v2` treats as nothing known.
   */
  async _jevHistory({ budgetId, payees, merchant, asOf }) {
    try {
      const cached = this._jevRowsCache.get(budgetId);
      let rows = cached && Date.now() - cached.at < 10 * 60 * 1000 ? cached.rows : null;
      let categories = cached?.categories;
      if (!rows) {
        const since = new Date();
        since.setDate(since.getDate() - 365);
        [rows, categories] = await Promise.all([
          this._get("/transactions", budgetId, { since_date: since.toISOString().slice(0, 10) }),
          this._get("/categories", budgetId),
        ]);
        if (!Array.isArray(rows)) return null;
        this._jevRowsCache.set(budgetId, { at: Date.now(), rows, categories });
      }
      return payeeHistory(rows, {
        payees,
        categories: Array.isArray(categories) ? categories : [],
        merchant,
        asOf,
      });
    } catch (error) {
      logger.warn({ event: "jev_history_failed", error: error.message });
      return null;
    }
  }

  /**
   * Calibration dry runs only: what every Jev prompt variant answers for this
   * merchant, with every score, ignoring memory. `as_of` (the alert's date)
   * hides the owner's bookings from that day on, so a replay cannot see the
   * row it is being scored against. One search serves every variant.
   */
  async _handle_calibrate_jev({ merchant, budget_id, evidence, direction, amount_cents, currency, no_search, as_of }) {
    if (!this.calibrating()) return { error: "calibration_only" };
    if (!budget_id || !merchant || !evidence?.text) return { error: "missing_input" };
    if (!this._config.jevApiKey) return { error: "jev_disabled" };
    const search = this._config.firecrawlApiKey && !no_search
      ? await searchMerchant({ config: this._config, descriptor: merchant, currency })
      : null;
    this._calibrationScope.getStore().searches.set(merchant, search);
    const payees = await this._get("/payees", budget_id);
    const history = await this._jevHistory({ budgetId: budget_id, payees, merchant, asOf: as_of });
    const out = { searched: Boolean(search?.results?.length), earlier: Object.fromEntries(history?.sameMerchant || []) };
    for (const variant of JEV_PROMPT_VARIANTS) {
      const result = await classifyPayee({
        config: this._config,
        merchant,
        direction,
        amountCents: amount_cents,
        currency,
        evidence,
        payees,
        variant,
        history,
        context: this._jevContext(merchant),
        fullScores: true,
        ...(search ? { search } : {}),
      });
      out[variant] = { payee: result.payee, reason: result.reason || "accepted", scores: result.scores || {} };
    }
    return out;
  }

  /**
   * The live offer whose key names this merchant in this budget, as a
   * resolve_merchant answer, while its payee is still an eligible one.
   */
  async _pendingAnswer(merchant, budgetId) {
    const offer = this._pendingLearning
      .list()
      .find(
        (o) => o.budgetId === (budgetId || "") && factNamesMerchant(`${o.descriptor} maps to ${o.payee} payee`, merchant),
      );
    if (!offer) return null;
    try {
      if (!eligiblePayees(await this._get("/payees", budgetId)).includes(offer.payee)) return null;
    } catch {
      return null;
    }
    return {
      payee: offer.payee,
      source: "jev",
      pending: true,
      category: offer.category || null,
      runner_up: offer.runnerUp || null,
      confidence: null,
    };
  }

  /**
   * Internal: not on the HTTP or MCP routes. Jev picks one live spending
   * category for a row memory had none for. Writes nothing.
   */
  async _handle_classify_category({
    merchant,
    payee,
    budget_id,
    evidence,
    search,
    direction,
    amount_cents,
    currency,
  }) {
    if (!this._config.jevApiKey) return { category_id: null, reason: "disabled" };
    try {
      const categories = await this._get("/categories", budget_id);
      const result = await classifyCategory({
        config: this._config,
        merchant,
        payee,
        direction,
        amountCents: amount_cents,
        currency,
        evidence,
        categories,
        search,
        context: this._jevContext(merchant),
      });
      return result.category_id ? { ...result, source: "jev" } : result;
    } catch (error) {
      logger.warn({ event: "jev_category_tier_failed", error: error.message });
      return { category_id: null, reason: "error" };
    }
  }

  // ── Learning that waits for the user (#720) ─────────────────

  get _pendingLearning() {
    this._pending ||= new PendingLearning(
      this._config.pendingLearningPath || "state/pending-learning.json",
    );
    return this._pending;
  }

  setLearningNotifier(notifier) {
    this._learningNotifier = notifier;
  }

  /** True when /remember and /forget answer offers, so the model gets no confirm path (#723). */
  get learningCommandsEnabled() {
    return Boolean(this._config.telegramBotToken && this._config.telegramHomeChannel);
  }

  /**
   * Internal: not on the HTTP or MCP routes. Stores an offer to remember a
   * mapping. Writes no fact.
   */
  async _handle_propose_learning({ descriptor, payee, category, runner_up, budget_id, incoming }) {
    // Money received from a person is remembered by sender AND amount, the
    // shape `incomingRule` reads; the same person sending another amount is
    // not covered by it.
    const key = incoming ? incomingKey(descriptor, incoming) : merchantKey(descriptor);
    if (!key) return { offered: false, reason: "unusable_descriptor" };
    let eligible;
    try {
      eligible = eligiblePayees(await this._get("/payees", budget_id));
    } catch {
      return { offered: false, reason: "payees_unavailable" };
    }
    // Misc is never eligible, so it is never remembered.
    if (!eligible.includes(payee)) return { offered: false, reason: "ineligible_payee" };
    if (category) {
      // Exactly a live spending category, and nothing a fact reader could
      // parse as another mapping.
      let names = [];
      try {
        names = eligibleCategories(await this._get("/categories", budget_id)).map((c) => c.name);
      } catch {
        return { offered: false, reason: "categories_unavailable" };
      }
      if (!names.includes(category) || FACT_GRAMMAR_RE.test(category)) {
        return { offered: false, reason: "ineligible_category" };
      }
    }
    // One offer per key: a repeat alert sends nothing new.
    if (this._pendingLearning.find(key, budget_id || "")) {
      return { offered: false, reason: "already_offered", key };
    }
    const id = this._pendingLearning.offer({
      descriptor: key,
      example: String(descriptor || "").trim(),
      payee,
      category: category || null,
      runnerUp: runner_up || null,
      budgetId: budget_id || "",
    });
    const stored = this._pendingLearning.get(id);
    if (this._offerSink && stored) {
      await this._offerSink(stored);
    } else if (this._learningNotifier && stored) {
      try {
        await this._learningNotifier.sendOffer({ offer: stored });
      } catch (error) {
        logger.warn({ event: "learning_offer_send_failed", error: error.message });
      }
    }
    return { offered: true, id, key };
  }

  /** Internal: drop an offer whose notification never reached the user. */
  async _handle_withdraw_learning({ id }) {
    return { withdrawn: this._pendingLearning.discard(id) };
  }

  async _handle_list_pending_learning() {
    return {
      offers: this._pendingLearning.list().map((offer) => ({
        ...(this.learningCommandsEnabled ? {} : { id: offer.id }),
        descriptor: offer.descriptor,
        payee: offer.payee,
        runner_up: offer.runnerUp,
        expires_at: new Date(offer.expiresAt).toISOString(),
      })),
    };
  }

  async _handle_confirm_learning({ id }) {
    // The user's command is the only confirm path when commands are on (#723).
    if (this.learningCommandsEnabled) return { confirmed: false, reason: "use_commands" };
    return this._confirmLearning(id);
  }

  /** Writes the fact for a live offer. Called by confirm_learning and the answer route. */
  async _confirmLearning(id) {
    const offer = this._pendingLearning.get(id);
    if (!offer) return { confirmed: false, reason: "unknown_or_expired" };
    const fact = `${offer.descriptor} maps to ${offer.payee} payee`;
    const learned = await this._handle_learn_fact({
      fact,
      budget_id: offer.budgetId,
    });
    // An existing identical fact is the outcome the user asked for.
    // With the wiki as authority (#783) the store queues the fact as a
    // proposal and Hermes writes the wiki row from the /remember answer.
    const known = ["duplicate", "structured duplicate", "semantic duplicate", "proposal_queued"];
    if (!learned?.added && !known.includes(learned?.reason)) {
      return { confirmed: false, reason: learned?.reason || "not_saved", kept: true };
    }
    this._pendingLearning.discard(offer.id);
    if (!offer.category) return { confirmed: true, fact };
    // The payee is what was asked for; a category that is not saved is
    // reported, not a failed confirm.
    const categoryFact = `${offer.descriptor} maps to ${offer.category} category`;
    const saved = await this._handle_learn_fact({ fact: categoryFact, budget_id: offer.budgetId });
    const categorySaved = Boolean(saved?.added) || known.includes(saved?.reason);
    if (!categorySaved) logger.warn({ event: "learning_category_not_saved", reason: saved?.reason || "unknown" });
    return { confirmed: true, fact, category: offer.category, category_saved: categorySaved };
  }

  async _handle_decline_learning({ id }) {
    return { declined: this._pendingLearning.discard(id) };
  }

  // ── HTTP helpers ────────────────────────────────────────────

  get _apiUrl() {
    return this._config.actualBudgetUrl || "http://localhost:3000";
  }

  async _enrichWithBalances(accounts, budgetId) {
    const balanceResults = await Promise.allSettled(
      accounts.map((a) =>
        this._get(`/accounts/balance/${a.id}`, budgetId),
      ),
    );
    return accounts.map((a, i) => {
      const result = balanceResults[i];
      if (result.status === "fulfilled") {
        return { ...a, balance: result.value.balance ?? null };
      }
      logger.warn({
        event: "account_balance_fetch_failed",
        accountId: a.id,
        accountName: a.name,
        reason: result.reason?.message || "unknown",
      });
      return { ...a, balance: null };
    });
  }

  async _get(path, budgetId, extraParams = {}) {
    const params = new URLSearchParams(extraParams);
    if (budgetId) params.set("budget_id", budgetId);
    const qs = params.toString();
    const url = `${this._apiUrl}${path}${qs ? "?" + qs : ""}`;
    const r = await fetch(url);
    if (!r.ok) throw await actualApiError(r);
    return r.json();
  }

  async _post(path, body, budgetId) {
    const payload = { ...body };
    if (budgetId) payload.budget_id = budgetId;
    const r = await fetch(`${this._apiUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw await actualApiError(r);
    return r.json();
  }

  /**
   * The single transfer-destination guard, shared by the insert and update
   * paths. Returns an error string, or null when the payee is not a transfer
   * payee or its target is a usable own account. Issue #563, #570.
   *
   * `sourceAccountId` is the account the row sits on: a transfer to that same
   * account is a self-cancelling no-op and is refused.
   */
  async _validateTransferTarget(payee, budgetId, sourceAccountId) {
    if (!payee?.transfer_acct) return null;
    let accounts = null;
    try {
      accounts = await this._get("/accounts", budgetId);
    } catch {
      // Fail closed with the tool's uniform error shape: a failing accounts
      // lookup must not surface as a thrown `insert_failed`/`update_failed`.
      // Issue #570.
      return "Could not validate transfer destination.";
    }
    if (!Array.isArray(accounts)) return "Could not validate transfer destination.";
    if (payee.transfer_acct === sourceAccountId)
      return "Transfer destination cannot be its source account.";
    if (!accounts.some((account) => account.id === payee.transfer_acct && !account.closed))
      return "Transfer destination is closed or unavailable.";
    return null;
  }

  async _handle_update_transaction(args) {
    const {
      id,
      budget_id,
      payee_id,
      payee_name,
      notes,
      amount,
      date,
      category_id,
      account_id,
    } = args;
    if (!budget_id) return { error: "budget_id is required" };
    const budgetId = budget_id;

    // Reject the pair before any network call: the ID would win and the name
    // would be ignored silently. A blank name counts as absent. Issue #421, #487.
    if (payee_id !== undefined && payee_name) {
      return { error: "Provide payee_id or payee_name, not both." };
    }

    // Fetch payees once whenever validation or a category-clear guard needs it.
    // An account-only move does not: it must not become dependent on an
    // endpoint its pre-guard behaviour never touched, so that path loads the
    // list lazily and tolerates a failure. Issue #570.
    let payees = null;
    if (payee_name || payee_id !== undefined || category_id === null) {
      const result = await this._get("/payees", budgetId);
      payees = Array.isArray(result) ? result : [];
    }

    // Read the existing row at most once when a later guard needs its payee or
    // source account. An account-only move can otherwise turn an existing
    // transfer into a self-transfer. Issue #570.
    let currentTransaction = null;
    const readCurrentTransaction = async () => {
      if (currentTransaction) return currentTransaction;
      try {
        currentTransaction = await this._get(`/transactions/${id}`, budgetId);
      } catch {
        return null;
      }
      return currentTransaction;
    };

    // Build fields to update
    const fields = {};
    let updatedPayee = null;
    if (payee_id !== undefined) {
      // An explicit ID is the only way to pick the plain payee when a transfer
      // payee shares its name. Issue #421.
      updatedPayee = payees.find((p) => p.id === payee_id);
      if (!updatedPayee)
        return { error: `Payee ID "${payee_id}" not found in payee list.` };
      fields.payee = updatedPayee.id;
    } else if (payee_name) {
      // Validate payee exists (strict — reject unknown). Unlike insert, an
      // unknown name is an error here: update is a deliberate payee change,
      // not a raw imported description. Issue #483.
      //
      // resolvePayeeMatch carries the duplicate-name policy: a bare name means
      // the transfer payee, and it refuses when that preference would come from
      // array order. Issue #421, #487, #483.
      updatedPayee = resolvePayeeMatch(payees, payee_name);
      if (!updatedPayee)
        return {
          error: `Payee "${payee_name}" not found in payee list. Use a valid payee from fetch_payees.`,
        };
      if (updatedPayee.error) return { error: updatedPayee.error };
      fields.payee = updatedPayee.id;
    }
    // A payee change can create a transfer; an account-only move can alter the
    // source of an existing transfer. Both must use the same target guard.
    // Issue #570, follow-up to #563.
    let transferPayee = updatedPayee?.transfer_acct ? updatedPayee : null;
    let transactionForGuard = null;
    if (!updatedPayee && account_id !== undefined) {
      transactionForGuard = await readCurrentTransaction();
      if (!transactionForGuard)
        return { error: "Could not validate transfer destination." };
      // Load the payee list only for an account-only move, and only once the
      // row is known to carry a payee: a plain non-transfer move stays
      // independent of the payee endpoint. Issue #570.
      const rowPayeeId = transactionForGuard.payee || transactionForGuard.payee_id;
      if (rowPayeeId) {
        try {
          payees = payees || (await this._get("/payees", budgetId));
        } catch {
          return { error: "Could not validate transfer destination." };
        }
        transferPayee = (Array.isArray(payees) ? payees : []).find(
          (payee) => payee.id === rowPayeeId,
        );
      }
    }
    if (transferPayee?.transfer_acct) {
      let sourceAccountId = account_id;
      if (sourceAccountId === undefined) {
        transactionForGuard = transactionForGuard || await readCurrentTransaction();
        sourceAccountId = transactionForGuard?.account;
      }
      if (sourceAccountId == null)
        return { error: "Could not validate transfer destination." };
      const transferError = await this._validateTransferTarget(
        transferPayee,
        budgetId,
        sourceAccountId,
      );
      if (transferError) return { error: transferError };
    }
    if (notes !== undefined) fields.notes = notes;
    if (amount !== undefined) fields.amount = amount;
    if (date !== undefined) fields.date = date;
    if (category_id === null) {
      let effectivePayee = updatedPayee;
      if (!effectivePayee) {
        const transaction = await readCurrentTransaction();
        const transactionPayee = transaction?.payee;
        // The transaction's payee is read by ID first; a bare name goes through
        // the shared policy and is refused rather than guessed. Issue #483.
        effectivePayee = payees.find(
          (payee) => payee.id === transactionPayee,
        );
        if (!effectivePayee) {
          effectivePayee = resolvePayeeMatch(
            payees,
            String(transactionPayee || ""),
          );
          if (effectivePayee?.error) return { error: effectivePayee.error };
        }
      }
      if (effectivePayee?.name?.toLowerCase() !== "misc") {
        return { error: "Category can only be cleared when payee is Misc" };
      }
      fields.category = null;
    } else if (category_id !== undefined) {
      // Validate category exists (strict — reject unknown)
      const categories = await this._get("/categories", budgetId);
      const catMatch = Array.isArray(categories)
        ? categories.find((c) => c.id === category_id)
        : null;
      if (!catMatch)
        return {
          error: `Category ID "${category_id}" not found in category list. Use a valid category from fetch_categories.`,
        };
      fields.category = category_id;
    }
    if (account_id !== undefined) fields.account = account_id;

    if (Object.keys(fields).length === 0) {
      return { error: "At least one field must be provided to update" };
    }

    return this._patch(`/transactions/${id}`, fields, budgetId);
  }

  async _patch(path, body, budgetId) {
    const payload = { ...body };
    if (budgetId) payload.budget_id = budgetId;
    const r = await fetch(`${this._apiUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw await actualApiError(r);
    return r.json();
  }

  // ── Telegram transaction entry ─────────────────────────────────

  async _handle_process_transaction({ raw_text }) {
    if (!this._orchestrator) {
      return {
        action: "error",
        details: "Orchestrator not available",
      };
    }
    if (!raw_text || !String(raw_text).trim()) {
      return {
        action: "error",
        details: "No transaction text provided",
      };
    }
    return this._orchestrator.processText(String(raw_text).trim());
  }
}
