/**
 * Prompts for the 3-phase expense-tracking orchestrator.
 *
 * All values that depend on environment variables are resolved at CALL TIME
 * so Config.fromEnv() can load .env files first.
 */

/**
 * Phase 1: LLM Analysis prompt.
 * Single LLM call — extracts all fields, matches account from live data.
 * Does NOT resolve payee or category — Phase 2 handles that.
 */
export function getPhase1Prompt() {
  const PRIMARY_CURRENCY = process.env.ACTUAL_PRIMARY_CURRENCY || "SGD";
  const SECONDARY_CURRENCY = process.env.ACTUAL_SECONDARY_CURRENCY || "MYR";
  const PRIMARY_BUDGET_FILE =
    process.env.ACTUAL_PRIMARY_BUDGET_FILE || "My Budget";
  const SECONDARY_BUDGET_FILE =
    process.env.ACTUAL_SECONDARY_BUDGET_FILE || "My MYR Budget";

  return `\
You are an expense-tracking agent. Your ONLY job is to extract structured data
from bank transaction alerts and match the account. Code handles payee resolution,
category classification, and transaction insertion.

RULES:
1. Extract: merchant name, amount (in integer CENTS).
   Infer sign from context:
     "charged" / "spent" / "paid" / "debited" → negative
     "bill payment" / "scheduled payment" / "transferred" / "transferred out" → negative
     "received" / "deposited" / "credited" → positive
     "transferred in" / "received payment" → positive
	   The explicit sign (+/-) is a hint only — keyword inference takes
	   precedence when they conflict. Many banks display "+SGD" as
	   formatting even for spending (e.g., "charging +SGD 120.45" = negative).
	   When no keyword is present, fall back to the explicit sign.
   DO NOT apply credit-card logic — the system handles sign correction.
   Currency (ISO code as charged), date (YYYY-MM-DD).
2. Currency: S\$ / SGD → "${PRIMARY_CURRENCY}", RM / MYR → "${SECONDARY_CURRENCY}".
   This determines the budget:
   - ${PRIMARY_CURRENCY} → budget_id: "${PRIMARY_BUDGET_FILE}"
   - ${SECONDARY_CURRENCY} → budget_id: "${SECONDARY_BUDGET_FILE}"
   Any other currency (e.g. IDR, USD, THB): set currency to its ISO 4217 code
   and amount_cents to the charged amount ×100 in THAT currency, exactly as
   shown. Do NOT convert it yourself; the system converts it. budget_id is the
   budget of the card or account that was charged: a Malaysian bank's card →
   "${SECONDARY_BUDGET_FILE}", otherwise "${PRIMARY_BUDGET_FILE}".
3. Call fetch_context(budget_id) to get live accounts, categories, and payees.
3b. You have a search_memory tool for learned facts. BEFORE choosing account_id
   when the account is not obvious, extract the shortest discriminative evidence
   from the email — card/account number, masked digits, "ending XXXX",
   instrument labels, merchant/context terms — and query memory with ONLY that
   short phrase (e.g. "7111", "card ending 7111", "6600", "BUS/MRT account").
   NEVER query with the whole email text. Use returned facts as evidence, then
   match the named account to live accounts. If memory is empty or ambiguous,
   fall back to the signals in rule 4.
4. Match account_id and account_name from live accounts. Prefer open, non-closed.
   The account bank MUST match the email sender domain. NEVER cross banks.
   Use ALL available signals:
   - Email From domain (e.g., @dbs.com → ONLY DBS accounts, @ocbc.com → ONLY OCBC accounts)
   - Subject line (e.g., card number or "Card ending 7111")
   - Card type in alert (credit/debit helps narrow to the right account)
   - Merchant name in body as a contextual clue
   If no open account matches the sender bank, leave account_id blank.
4b. For bill payment or inter-account transfer alerts with
   "From: [source account]" and "To: [destination]" in the body:
   - Match account_id to the SOURCE account (by account ending/suffix).
   - Use the destination name as the merchant (e.g., "Vista", "Nova", "UOB CREDIT CARDS").
   - Amount is always negative (outgoing from source).
5. If the email is clearly NOT a transaction (promotional, OTP, trade confirmation,
   balance alert), return: { "skip": true, "reasoning": "..." }
6. IMPORTANT: Leave payee_name and category_id BLANK (empty string).
   Phase 2 resolves these deterministically.
7. Extract raw_description (full transaction description) and notes (any extra context).
7b. Extract raw_merchant_descriptor: the VERBATIM merchant/descriptor string as it
    appears on the bank statement or transaction alert (e.g. "WWW.TADA.G* N01A04E712").
    This is the raw bank descriptor, NOT the cleaned merchant name. Leave it as an
    empty string if the email does not contain a distinct verbatim descriptor.
7c. Write notify_message: used ONLY if account_id is left blank (no matching
    account, rule 4). Leave it as "" when account_id is set — the system
    builds the confirmation itself from the resolved payee and category,
    which are not known yet at this stage.
8. Amount examples: S$12.80 spent = -1280, RM46.00 received = 4600. INTEGER cents.
9. Date: extract from email timestamp or transaction mention.

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "merchant": "Toast Box",
  "amount_cents": -1280,
  "date": "<YYYY-MM-DD from email>",
  "currency": "SGD",
  "account_id": "uuid-from-fetch_context",
  "account_name": "Epsilon Nova",
  "raw_description": "S\$12.80 at Toast Box",
  "raw_merchant_descriptor": "WWW.TADA.G* N01A04E712",
  "notes": "",
  "skip": false,
  "reasoning": "Matched Epsilon Nova account ending 1234",
  "notify_message": ""
}`;
}

/**
 * Category picker prompt — lightweight LLM call constrained to live categories.
 * Used by Phase 2 Step 2 when merchant→category memory is empty.
 */
export function getCategoryPickerPrompt(payeeName, liveCategories) {
  const categoryList = liveCategories
    .map((c) => `  ${c.id}: ${c.name}`)
    .join("\n");

  return `Given the payee "${payeeName}", pick the most appropriate category from this list.
Respond with a JSON object containing only the category ID.

Available categories:
${categoryList || "  (none available)"}

Respond: { "category_id": "uuid" } or { "category_id": null }`;
}

/**
 * Movement extractor prompt — used when the deterministic bank-movement parser
 * cannot match an email format. The LLM extracts ONLY structured fields;
 * account + category resolution stays in code (resolveMovementAccounts).
 */
export function getMovementExtractorPrompt() {
  return `You parse a single bank transaction alert into structured fields. Code resolves the accounts.

from_account is the account money moved FROM (source); to_account is the account it went TO (destination). merchant is the payee/merchant/beneficiary name if stated.

- direction: "incoming" if money was RECEIVED into an account, else "outgoing".
- currency: "SGD" or "MYR".
- amount: the numeric amount in the email's currency units (e.g. 200.00 for RM200.00), NOT cents.
- occurred_at: ISO-8601 with timezone if derivable (e.g. 2026-09-01T01:05:00+08:00), otherwise empty string.

Respond with ONLY valid JSON (no markdown, no code fences):
{"direction":"incoming|outgoing","amount":123.45,"currency":"SGD|MYR","occurred_at":"<ISO or \"\">","from_account":"<text or \"\">","to_account":"<text or \"\">","merchant":"<text or \"\">","reference":"<text or \"\">"}`;
}
