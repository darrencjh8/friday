# Expense Tracker — Receipt Processing

Process bank transaction alerts into Actual Budget. Trigger: email from UOB, CIMB, Maybank, transaction alert, spent, charged, receipt, payment.

## Card/account suffix facts — how matching works, and how to repair it

A "suffix fact" maps the card or account number in an alert to the account that
should be booked. The tracker stores them in this shape:

```
Card ending 7111 belongs to Epsilon Nova Card
Account ending 7222 belongs to Epsilon Account
```

On every alert the tracker looks for a fact naming the number in the email. If it
finds one, it books the account that fact resolves to and overrides a different
LLM pick. If it finds none, or the fact cannot be resolved, the LLM's pick stands.

**Reading is tolerant.** All of these are understood, so a user can write a fact
in ordinary words:

- `Card/account ending 7111 belongs to Epsilon Nova Card.`
- `card ending in 7111 belongs to Epsilon Nova`
- `Account/card ending 6600 belongs to Beta 360`

**Writing is canonical.** The stored form always uses `Card` for a card-named
account and `Account` otherwise. `Card/account` is accepted on input but never
written, because the parser keys on the suffix and the account, not the prefix.

**Account names are matched by words, not exact text.** `Nova` resolves to
`Epsilon Nova Card`, `Vista` to `Epsilon Vista Card`. Matching refuses when it is
ambiguous: `DBS` matches three accounts, so it books nothing rather than
guessing. A name that matches no live account also refuses, and a fact naming a
live account from a different bank than the sender email is ignored.

### Diagnosing a wrong booking

The user says something like "card 7111 went to the wrong account" or "why did
BUS/MRT book to Epsilon Account".

1. `search_facts` with the card number, e.g. `search_facts("7111")`.
2. Look for `belongs to` facts. Check whether the named account is the right one.
3. `fetch_context` for both budgets to confirm the account exists, is open, and
   belongs to the bank that sends the alerts.
4. Then, depending on what is wrong:
   - Names the wrong account → `update_fact` with the corrected canonical fact.
   - Malformed, or duplicated in several spellings → `delete_fact` the bad line,
     or `cleanup_facts` to canonicalise and drop duplicates. Its result includes
     `normalised`, the count of suffix facts rewritten.
   - Ambiguous or missing → ask the user which account; do not guess.
5. Confirm to the user exactly what was stored.

When the user teaches a new card ("card 7111 is the Nova card"), `search_facts` and
`fetch_context` first to confirm the account, then `learn_fact` with the canonical
fact, and say what you saved.

### Facts about facts

- One mapping per number. Two facts for one number mean the later line wins by
  file order, which is not a decision to leave implicit.
- `6600` and `166600` pointing at the same account is correct, not a duplicate:
  one OCBC format prints the short number and another prints the long one.
- The pipeline never overwrites an existing account-type fact (`X is a bank
  account`). A contradiction is logged. Fix a wrong type deliberately with
  `update_fact`, because the type decides whether a purchase is booked negative.

### Remembering a Jev payee guess (#720)

When memory has no payee and the pipeline could not decide, a model (Jev) may
pick one from the full email, and the notification then asks "Remember this
mapping?". That is a guess, so nothing is saved until the user says yes.

- When the tracker's own Telegram message carries `/remember_<id>` and
  `/forget_<id>` commands, the user answers with a tap. You cannot confirm and
  never see the id: do not ask the user to reply "yes" to you, and do not try
  to call `confirm_learning` (it is not available).
- Otherwise call `list_pending_learning` to see the open offers (descriptor,
  payee, runner-up, id).
- Only after an explicit user yes, in a later turn than the offer, call
  `confirm_learning` with that offer's id. If the user says no, call
  `decline_learning`. Declining never changes the booked transaction.
- Never `learn_fact` a Jev mapping yourself, and never confirm on silence or on
  a yes that does not refer to the offer.
- Residual limit: confirmation is a tool call the agent makes, so it rests on
  this instruction and on the id being absent from the notification. The tool
  cannot itself prove a human typed the yes, and the memory data mount is
  read-only to Hermes, so a fact still reaches memory only through the
  expense-tracker tools.

### Must not

- Guess an account for a user, or store a fact the user did not confirm.
- Edit Actual Budget transactions directly.
- Use HTTP endpoints for these tools: `fetch_context` is MCP-only.

## Pipeline (3-phase design — see `src/orchestrator.js`)

The expense-tracker orchestrator handles ALL phases internally. Hermes only routes emails — the orchestrator does LLM analysis, code-driven resolution, and execution. (Spec 021 replaced the earlier 4-phase / V2-V3 gate design.)

**Phase 1 — LLM Analysis:** Single LLM call (`reasoning=low`) with the `fetch_context` tool to read live accounts/categories/payees. Extracts merchant, amount, date, currency and proposes payee/category, leaving fields blank when unsure. 1 retry.

**Phase 2 — Resolution (code-driven, no LLM gates):** Deterministic fill-in of blanks:
- **payee:** memory → `resolve_merchant` (memory → web search → classification) → Jev full-email fallback (needs `JEV_API_KEY`, offers a confirmable memory) → `"Misc"`
- **category:** memory → LLM category picker (`getCategoryPickerPrompt`) → `null`

**Phase 3 — Execute:** Insert with duplicate check, notify, `learn_fact` ×1. Skip for non-transactions. Notify on exhaustion.

## Key design principles

- **Leave blank > guess:** LLM leaves fields empty when unsure. Phase 2 code resolves blanks via memory/web search or falls back to `Misc`/`null`.
- **Memory-first:** Memory is consulted first in both payee and category resolution before any web/LLM step.
- **No keyword table:** Payee matching is memory + web search. No hardcoded keyword→payee mappings (no `src/keywords.js`).

## Output style

When presenting expense data to the user, be concise and structured. Use bullet points or tables — never long paragraphs. Keep SOUL.md personality (warm, feminine, ~) but don't narrate data. State what happened, then list results.

Example format:
```
3 tx updated~

• Jun 18 RM30 → TNG eWallet
• Jun 15 RM30 → TNG eWallet  
• Jun 15 RM20 → TNG eWallet

Learned: RYT transfers = TNG top-up
```
