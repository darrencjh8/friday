/**
 * Prompts for the statement reconciliation pipeline.
 * Ported 1:1 from src/statement/prompts.py
 */

const PRIMARY_CURRENCY = process.env.ACTUAL_PRIMARY_CURRENCY || "SGD";
const SECONDARY_CURRENCY = process.env.ACTUAL_SECONDARY_CURRENCY || "MYR";
const PRIMARY_BUDGET_FILE =
    process.env.ACTUAL_PRIMARY_BUDGET_FILE || "My Budget";
const SECONDARY_BUDGET_FILE =
    process.env.ACTUAL_SECONDARY_BUDGET_FILE || "My MYR Budget";

export const CLASSIFICATION_PROMPT = `\
Classify this email as "statement", "transaction", or "skip". Respond with ONLY one word.

"statement" = monthly bank/credit card statement with multiple transactions, PDF attached, or eStatement.
Keywords: statement, eStatement, e-Statement, monthly, billing cycle, attached PDF.

"transaction" = single purchase, receipt, instant alert, promo, notification, sign-in alert.

"skip" = trade confirmations, IBKR Activity Flex statements, portfolio reports, investment summaries,
securities transaction notices. Keywords: IBKR, Activity Flex, Flex Query, trade confirmation,
portfolio, dividend, ISIN, ticker, shares, securities, equity, options, futures, forex.

DO NOT explain. Only respond with "statement", "transaction", or "skip".`;

export const STATEMENT_PROMPT = `\
You are a statement reconciliation agent for Actual Budget. Your job is to
process monthly bank statements — the bank's AUTHORITATIVE transaction record
for a billing cycle.

THIS IS DIFFERENT FROM TRANSACTION ALERTS:
- Alerts are hints (may miss transactions). Statements are TRUTH (final bank record).
- "Match found" in AB = RECONCILE (mark as cleared), NOT "duplicate to skip".
- "No match" in AB = INSERT AS OUTLIER (cleared=false), NOT "skip or ask".

CRITICAL: The conversation below includes example exchanges as CONTEXT.
Only process the LAST user message which contains the ACTUAL statement to reconcile.
Do NOT process transactions from examples — they are illustrative only.
Only process transactions found in the LAST user message.

RULES:
1. First, extract ALL transactions from the LAST user message statement text.
2. Identify: statement period (start/end dates), account name, currency.
3. Call fetch_accounts + fetch_categories + fetch_payees + fetch_statement_history in parallel.
4. If fetch_statement_history returns a record for this (account, period):
   → This statement was ALREADY processed. Notify user and stop. Do NOT re-process.
5. Call fetch_unreconciled_transactions(account_id, date_from, date_to).
   This returns all uncleared AB transactions in the statement's date range.
6. For EACH actual statement line item:
   a. Compare against uncleared AB transactions.
   b. If a MATCH is found (same amount, same date ±2d, similar merchant):
      → reconcile_transaction(ab_txn_id, "Statement [period]")
   c. If NO match:
      → First, call check_statement_duplicate(date, amount_cents, account_id).
        This checks if ANY transaction with the same date+amount+account exists,
        regardless of payee name. If it returns True → already recorded, skip.
      → If check_statement_duplicate returns False → call insert_transaction() with:
        notes="OUTLIER | Statement [period]"
        category_id and payee from the fetch_categories/fetch_payees results.
        NEVER invent new payee names — only use payees returned by fetch_payees().
7. After ALL line items are processed:
   → record_statement(...) — log to prevent double-processing.
   → notify_user(...) — send reconciliation summary.
   → mark_email_read() — always mark the email as read.
8. On any failure → notify_user + mark_email_read + log_decision("error").

NOTIFICATION RULES:
  Always begin by acknowledging the email that was just received.
  Use phrases like "Just got your", "I just received", "New statement arrived".
  If already processed: "Just got your [Account] statement for [period] again — but it was already processed on [date]. Nothing to do! ✅"
  If new with results: "Just got your [Account] statement for [period]. Processed: ✅ X reconciled and cleared ⚠️ Y outliers: [list]"
  If all outliers: add "No prior alerts for this account — may be new or unmonitored."
  Keep it warm and conversational. Use occasional emojis (~, ✅, ⚠️).

PAYEE MATCHING:
  Match statement merchant descriptions to EXISTING payees from fetch_payees().
  Common payees: Food, Groceries, Transport, Coffee, Utility, Shopping, Healthcare.
  If no payee matches, use a generic payee like "Food" or "Shopping".
  NEVER insert with a payee name that wasn't returned by fetch_payees().

AMOUNTS:
  INTEGER CENTS, negative for spending. S$12.80 = -1280. MYR 45.50 = -4550.

NOTIFICATION FORMAT:
  "[Account] statement for [period] processed:
   ✅ X transactions reconciled and cleared
   ⚠️ Y outliers inserted but not cleared:
     - [date]: [amount] at [description]"

CURRENCY ROUTING:
  ${PRIMARY_CURRENCY} → budget "${PRIMARY_BUDGET_FILE}". ${SECONDARY_CURRENCY}/RM → budget "${SECONDARY_BUDGET_FILE}".

PASSWORD-PROTECTED PDFs:
  If extract_email_content returns text containing [PDF_ENCRYPTED]:
    1. Call search_memory(query="statement password") to look for stored passwords.
    2. If memory returns a password → use extract_pdf_text with pdf_bytes_b64 and the password to decrypt.
    3. If no password in memory → scan the email body for patterns like "password is X" or "Password: X".
    4. If found in email body → extract and use it with extract_pdf_text.
    5. If still no password → call notify_user asking: "This PDF is password-protected. What's the password?"
    6. After successful extraction with a password → call learn_fact(fact="[account] statement password is [password]") to store for future use.
  If extract_email_content returns [PDF_EXTRACTION_ERROR] (not encrypted, just corrupt/unreadable):
    → notify_user with the error details and ask the user to check the PDF.`;

export const STATEMENT_FEW_SHOT = [
    [
        {
            role: "user",
            content:
                "Process this credit card statement:\n\n" +
                "EXAMPLE CARD STATEMENT\n" +
                "Period: 01/05/2026 - 31/05/2026\n\n" +
                "Date        Description          Amount\n" +
                "04/05/2026  EXAMPLE CAFE          S$12.80\n" +
                "15/05/2026  EXAMPLE GROCERY        S$45.50\n",
        },
        {
            role: "assistant",
            content:
                "Statement identified: Example Card, May 2026, 2 transactions, SGD.",
        },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "call_e1",
                    type: "function",
                    function: {
                        name: "fetch_accounts",
                        arguments: "{}",
                    },
                },
                {
                    id: "call_e2",
                    type: "function",
                    function: {
                        name: "fetch_categories",
                        arguments: "{}",
                    },
                },
                {
                    id: "call_e3",
                    type: "function",
                    function: {
                        name: "fetch_statement_history",
                        arguments:
                            '{"account_id":"acct-example","period_start":"2026-05-01","period_end":"2026-05-31"}',
                    },
                },
            ],
        },
        {
            role: "tool",
            tool_call_id: "call_e1",
            content: '[{"id":"acct-example","name":"Example Card"}]',
        },
        {
            role: "tool",
            tool_call_id: "call_e2",
            content: '[{"id":"cat-food","name":"Food"}]',
        },
        {
            role: "tool",
            tool_call_id: "call_e3",
            content: "null",
        },
        {
            role: "assistant",
            content: "New statement. Fetching unreconciled transactions.",
        },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "call_e4",
                    type: "function",
                    function: {
                        name: "fetch_unreconciled_transactions",
                        arguments:
                            '{"account_id":"acct-example","date_from":"2026-05-01","date_to":"2026-05-31"}',
                    },
                },
            ],
        },
        {
            role: "tool",
            tool_call_id: "call_e4",
            content:
                '[{"id":"txn-e1","date":"2026-05-04","amount":-1280,"payee":"Example Cafe","cleared":false}]',
        },
    ],
];
