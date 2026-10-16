# Feature Specification: Three-Phase Orchestrator Refactor

**Feature:** three-phase-orchestrator-refactor
**Spec Version:** 1.0.0
**Status:** Implemented (current pipeline)
**Created:** 2026-06-20
**Replaces:** Spec 020 (orchestrator-deterministic-finalize)
**Baseline:** `specs/002-expense-tracking/spec.md`

> **Current pipeline.** This delta defines the **active** 3-phase orchestrator (Phase 1 LLM Analysis → Phase 2 code-driven Resolution → Phase 3 Execute), implemented in `modules/expense-tracker/src/orchestrator.js`. No keyword step. Matches `modules/hermes/skills/expense-tracker/SKILL.md`.

---

## Problem

The current 4-phase orchestrator (`orchestrator.js`) has accumulated structural friction:

| Symptom | Root Cause |
|---------|------------|
| Payee resolved in two places (Phase 2 LLM + Phase 3 code) | LLM guesses payee, code patches it — two authorities, no single owner |
| Category is LLM-only with no fallback | Phase 2 LLM decides category; if blanked, stays blank forever |
| Duplicate validation gates (`_validatePhase2`, `_validatePhase3`) | Both check payee + category against live data with near-identical code |
| Duplicate `fetch_context` calls | Called in Phase 2 and Phase 3 unnecessarily (same data) |
| 2-7 LLM API calls per transaction | Phase 2 LLM with up to 4 retries + optional Phase 3 LLM |
| Bug #91 happened because "Misc" bypass logic needed in 2 places | Same logic duplicated across V2 and V3 gates |

The spec 020 design (3 phases with deterministic Phase 1.5) was partially implemented but the code diverged into 4 phases. This spec realigns the implementation with that design intent, incorporating lessons learned from production.

---

## Design

### New Flow

```
┌─────────────────────────────────────────────────────────────┐
│  PHASE 1: LLM ANALYSIS                                     │
│                                                             │
│  Input: raw email text / Telegram alert                     │
│  LLM: reasoning=low, has fetch_context tool                  │
│  Output: { merchant, amount_cents, date, currency,         │
│            account_id, account_name, notes, skip,          │
│            reasoning, notify_message, raw_description }    │
│                                                             │
│  Code derives budget_id from currency (same as current      │
│  Phase 1b): currency=PRIMARY → primaryBudgetFile, else     │
│  secondaryBudgetFile. skip=true → action="skip".           │
│  Prompt embeds currency→budget mapping so LLM can call      │
│  fetch_context with correct budget_id.                      │
│  Prompt includes account memory hints: after Phase 1 extracts│
│  merchant, code calls search_memory(merchant + "account")   │
│  and injects matching facts into retry feedback if needed.   │
│                                                             │
│  All guard failures (parse, amount, date, account) are      │
│  batched into a single retry message. Max 2 LLM calls.      │
│                                                             │
│  Guard: Parse failure → 1 retry with "Valid JSON only"      │
│  Guard: amount_cents must be numeric (any sign), date must   │
│         be valid and within 15 days — blank field in data    │
│         passed back to LLM as retry feedback                 │
│  Guard: account_id must exist in live accounts, not closed  │
│         Invalid → 1 retry with account list feedback        │
│         Still invalid → notify, stop                        │
│         (email: notify_user + mark_read; Telegram: return   │
│          { action: "notified" } inline — preserves both     │
│          execution variants from current Phase 4)            │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 2: RESOLUTION (code-driven, LLM-assisted)            │
│                                                             │
│  Step 1 — Payee:                                            │
│    search_memory(merchant) → "maps to X payee"?             │
│      hit  → payee = X, source = "memory"                    │
│      miss → resolve_merchant(merchant, budget_id)           │
│              → memory → Brave web → LLM classify payees     │
│              → payee or "Misc" (fallback)                   │
│                                                             │
│  Step 2 — Category:                                         │
│    fetch live categories                                    │
│    search_memory(merchant + " category") → match?           │
│      hit  → category_id = matched UUID                      │
│      miss → lightweight LLM:                                │
│              "Given payee 'X', pick from: [Cat1, Cat2, …]"  │
│              → category_id or null                          │
│              → auto-learn for next time                     │
│                                                             │
│  Output: { payee_name, category_id?, payee_source }         │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 3: EXECUTE (mostly unchanged from current Phase 4)    │
│                                                             │
│  insert → check_duplicate → insert_transaction              │
│         → mark_read → notify_user → learn_fact × 1          │
│         (account_name; payee learned by resolve_merchant,    │
│          category by Phase 2 Step 2)                         │
│         → learn_fact returns contradiction ?                 │
│           update_fact (self-correcting auto-learn)           │
│                                                             │
│  skip   → mark_read → log_decision                          │
└─────────────────────────────────────────────────────────────┘
```

### What Gets Removed

| Removed | Why |
|---------|-----|
| Phase 2 LLM Audit (`_runPhase2`) | LLM no longer guesses payee/category — resolution is code-driven |
| `_validatePhase2` gate + retry loop | Nothing to validate — payee/category resolved by code, not LLM |
| `_validatePhase3` gate + retry loop | Nothing to validate — same reason |
| `_gatherMemoryHints` as separate step | Folds into Phase 2 Step 1 (search_memory for payee) |
| `_buildMessages` legacy method | Dead code — unused in 4-phase pipeline, only called by tests |
| Keyword table (memory → keyword → web chain from Spec 020) | Was never implemented; resolve_merchant is memory → web → Misc |
| Post-Phase-2 3-way routing | Collapsed — only skip, no-account, or proceed |
| Post-Phase-3 payee-only gate | Collapsed — always proceed to Phase 3 |
| Duplicate `fetch_context` calls | Phase 1 calls it (LLM tool for accounts); Phase 2 calls it (code for categories). Two calls, two purposes — no longer redundant |

### What Gets Added

| Added | Purpose |
|-------|---------|
| Phase 1 account validation + 1 retry | Catch hallucinated/closed accounts before execution |
| Phase 1 parse-failure retry (1×) | Recover from malformed LLM JSON |
| Phase 2 Step 2: lightweight category classifier | Close the "no category fallback" gap |
| Phase 2 Step 2: auto-learn category | User fixes once, memory matches next time |

---

## Phase 1 Detail

### LLM Configuration

```
Model: deepseek-flash
Reasoning: low (Phase 1 keeps fetch_context but runs at low depth for cost)
Tools: [ fetch_context ]
Temperature: 0.1
```

### LLM Prompt

The Phase 1 prompt replaces the current Phase 1a prompt. It instructs the LLM to:

1. Extract merchant, amount_cents, date, currency, raw_description
2. Call `fetch_context(budget_id)` to get live accounts/categories/payees
   (prompt provides currency→budget mapping: "SGD → budget X, MYR → budget Y")
3. Match account_id and account_name from live accounts
   (retry prompt includes memory hints: code calls search_memory
    for merchant + "account" patterns after Phase 1 extracts merchant)
4. Detect skip conditions (promotional, non-transaction, balance alert)
5. Leave payee_name and category_id blank — Phase 2 resolves them
6. Return structured JSON

### Account Validation

```
After Phase 1 returns:
  if (skip) → Phase 3 (skip path)
  
  accounts = await this._tools.executeTool("fetch_context", { budget_id })
  // (called from code, not extracted from LLM messages — guarantees fresh data)
  valid = accounts.find(a => a.id === account_id && !a.closed)
  
  if (!valid):
    retry once: "Account {id} not found or closed. Pick from: [names]"
    if still invalid → notify, stop
  
  // Correct account_name from live data (prevents swapped names)
  account_name = valid.name  // authoritative from Actual Budget
```

### Retry Strategy

All guard failures are batched into a single retry message:

```
try:
  call Phase 1 LLM
  validate parse, amount, date, account
  if any invalid:
    retry once: "Fix these issues: [specific feedback]. Valid JSON only."
    if still invalid → notify, stop
```

Maximum 2 LLM calls per transaction (initial + 1 retry).

---

## Phase 2 Detail

### Step 1: Payee Resolution

Reuses the existing `resolve_merchant` tool unchanged. The tool already:

1. Searches memory for `"merchant maps to X payee"` pattern
2. Falls through to Brave web search + LLM classification
3. Falls back to `{ payee: "Misc", source: "fallback" }`

No new code needed for this step — it's already the current `_handle_resolve_merchant` implementation.

### Step 2: Category Classification

New code. Two-tier resolution:

```
// Tier 1: Memory lookup (always runs, keyed on merchant)
const memResult = await search_memory(merchant + " category");
const match = memResult.text.match(/maps to (.+?) category/i);
if (match) return matchCategoryId(match[1], liveCategories);

// Tier 2: Lightweight LLM picker (only when payee carries semantic signal)
// Gate after Tier 1 — memory may have merchant→category facts
// even when resolve_merchant can't map the merchant to a payee
if (payeeName === "Misc") return null;

const pickerPrompt = `Given the payee "${payeeName}", pick the most appropriate
category from this list. Respond with a JSON object containing the category ID.

Available categories:
${liveCategories.map(c => `  ${c.id}: ${c.name}`).join('\n')}

Respond: { "category_id": "uuid" } or { "category_id": null }`;

// LLM config: reasoning="disabled", temperature=0, deepseek-flash
const response = await llm.chat(
  [{ role: "user", content: pickerPrompt }],
  undefined, undefined,
  { reasoning: "disabled" },
);
const { category_id } = parseJson(response);

// Guard: validate picker output against live categories
const validCategory = liveCategories.find(c => c.id === category_id);
if (!validCategory) category_id = null;

// Auto-learn for next time (self-corrects on contradiction)
if (category_id) {
  const catName = liveCategories.find(c => c.id === category_id)?.name;
  const fact = `${payeeName} maps to ${catName} category`;
  const learned = await learn_fact(fact);
  if (learned?.reason === "contradiction" && learned?.existing) {
    await update_fact({ old_text: learned.existing, new_text: fact });
  }
}

return category_id || null;
```

The picker LLM call is cheap — single-turn, short prompt, no tools, no reasoning needed. Much lighter than the current Phase 2 audit prompt.

---

## Phase 3 Detail

### Execution (replaces current Phase 4)

Phase 3 is a rename of current Phase 4 with one change: `learn_fact` reduced from 3 facts to 1.

**Rename:**
- `_executePhase4()` → `_executePhase3()` — used by email path
- `_executePhase4Silent()` → `_executePhase3Silent()` — used by Telegram path

**Learn change:** In the insert path, remove `learn_fact` calls for payee and category (now handled by `resolve_merchant` internally and Phase 2 Step 2). Keep only the account `learn_fact`, with two-step self-correction:

```js
// Remove these:
learn_fact(`${merchant} maps to ${payeeName} payee`);    // resolve_merchant auto-learns
learn_fact(`${payeeName} maps to ${category} category`);  // Phase 2 Step 2 auto-learns

// Keep this — with contradiction→update_fact fallback:
const fact = `${account_name} is a payment account`;
const learned = await learn_fact(fact);
if (learned?.reason === "contradiction" && learned?.existing) {
  await update_fact({ old_text: learned.existing, new_text: fact });
}
```

Everything else stays identical — `check_duplicate`, `insert_transaction`, `mark_email_read`, `notify_user`, `log_decision`.

### Production Wiring

Replace the 4-phase flow in both entry points with the 3-phase flow.

**`_processEmailInternal` (email path):**
```
Phase 1a + Phase 1b + Phase 2 + routing → replaced by:
  phase1 = await _runPhase1(emailText)
  if (!phase1 || phase1.action === "skip") → Phase 3 (skip)
  if (!phase1.account_id) → notify, stop
  phase2 = await _resolvePhase2(phase1)
  return _executePhase3(phase2)
```

**`_processTextInternal` (Telegram path):**
```
Same flow as email, but:
  - Stop paths return { action: "notified", details: "..." } (no notify_user call)
  - Phase 3 uses _executePhase3Silent (no notify/mark_read)
```

### Dead Code to Remove

| Method/Block | File | Reason |
|-------------|------|--------|
| `_runPhase1a()` | orchestrator.js | Replaced by `_runPhase1()` |
| `_runPhase1b()` | orchestrator.js | Budget logic folded into `_runPhase1()` |
| `_runPhase2()` | orchestrator.js | LLM audit replaced by `_resolvePhase2()` |
| `_runPhase3()` | orchestrator.js | Payee resolution folded into `_resolvePhase2()` |
| `_validatePhase2()` | orchestrator.js | V2 gate no longer needed |
| `_validatePhase3()` | orchestrator.js | V3 gate no longer needed |
| `_gatherMemoryHints()` | orchestrator.js | Folded into Phase 1 retry + Phase 2 Step 1 |
| `_buildMessages()` | orchestrator.js | Legacy method, unused in production |
| `_executePhase4()` | orchestrator.js | Renamed to `_executePhase3()` |
| `_executePhase4Silent()` | orchestrator.js | Renamed to `_executePhase3Silent()` |
| `getPhase1aPrompt()` | prompts.js | Replaced by `getPhase1Prompt()` |
| `getPhase2Prompt()` | prompts.js | No longer needed |
| `getLlmSystemPrompt()` | prompts.js | Replaced by `getPhase1Prompt()` |
| `getSystemPrompt()` | prompts.js | Legacy prompt, unused |
| `getFewShotExamples()` | prompts.js | Legacy examples, unused |
| `getPhase2ToolSchemas()` | tools.js | No longer needed (Phase 2 is code, not LLM) |

---

## Behavioral Changes

| Scenario | Current (4-phase) | Proposed (3-phase) |
|----------|-------------------|-------------------|
| Unknown merchant, no memory | Phase 2 LLM guesses → maybe wrong → V2 catches → Phase 3 fixes | Phase 2 resolve_merchant directly → Misc fallback |
| Known merchant, memory hit | Phase 2 LLM sees hint → picks payee | Phase 2 Step 1: memory hit → instant |
| Category blank | Inserts uncategorized (if payee set) | Same — `category_id: null` |
| LLM hallucinates account | V2 catches, retries up to 3× | Simple assertion, 1 retry, then stop |
| LLM returns malformed JSON | Phase 2 retries up to 3× | 1 retry, then stop |
| Promotional email | Phase 1a skip → Phase 4 skip | Phase 1 skip → Phase 3 skip |
| Positive amount (credit/refund) | Rejected by V2 gate (`n >= 0`) | Accepted (numeric, any sign) |
| Phase 1 reasoning mode | Phase 1a: `disabled` (no tools, simple extract) | Phase 1: `low` (has fetch_context tool, runs shallow) |
| `learn_fact` scope | 3 facts (payee, account, category) in Phase 4 | 1 fact (account_name) in Phase 3; payee handled by resolve_merchant, category by Phase 2 Step 2 |

---

## User Stories

### US-1: Single LLM Analysis Call (Priority: P1)

As a system processing transaction emails, I want the LLM to extract structured fields in one call, so that LLM API costs and latency are reduced.

**Acceptance Criteria:**
- [ ] Only 1 LLM call for extraction (Phase 1), not 2 (Phase 1a + Phase 2)
- [ ] LLM has only `fetch_context` tool
- [ ] LLM does NOT output payee_name or category_id
- [ ] Parse failure triggers 1 retry, then stops

### US-2: Deterministic Payee Resolution (Priority: P1)

As a system that matches merchants to payees, I want payee resolution to be code-only with a fixed fallback chain, so that the same merchant always maps to the same payee.

**Acceptance Criteria:**
- [ ] Payee resolved in Phase 2 Step 1, never by LLM
- [ ] Resolution chain: memory → resolve_merchant → "Misc"
- [ ] `resolve_merchant` called only when memory misses
- [ ] "Misc" treated as valid payee (not rejected — validates fix for #91)

### US-3: Category Resolution with Fallback (Priority: P1)

As a system that classifies transactions, I want category to have both memory and LLM fallback, so that transactions are never silently uncategorized when a reasonable guess exists.

**Acceptance Criteria:**
- [ ] Memory check first: `search_memory(merchant + " category")`
- [ ] LLM picker as fallback: constrained to live categories only
- [ ] Null category is valid (transaction inserts uncategorized)
- [ ] Successful classification auto-learns for next time

### US-4: Account Validation with Recovery (Priority: P1)

As a user who trusts the system with my budget data, I want hallucinated account IDs caught before execution, so that transactions are never inserted to wrong or closed accounts.

**Acceptance Criteria:**
- [ ] account_id validated against live accounts (must exist, not closed)
- [ ] Invalid account triggers 1 retry with feedback
- [ ] Still invalid → notify user, stop (no insert)
- [ ] Account validation runs before Phase 2 resolution

### US-5: Backward Compatibility (Priority: P2)

As a system with existing tool endpoints, I want all REST API endpoints and tool schemas to remain unchanged, so that external callers are unaffected.

**Acceptance Criteria:**
- [ ] All `/tools/*` endpoints remain registered
- [ ] `resolve_merchant`, `insert_transaction`, `check_duplicate` endpoints unchanged
- [ ] MCP server tool schemas unchanged
- [ ] StatementProcessor pipeline unaffected

---

## Non-Goals

- Changing the StatementProcessor (separate pipeline)
- Changing the IMAP handler or dedup journal
- Changing the `resolve_merchant` internal implementation
- Changing Phase 3 execution (Phase 4 in current code)
- Telegram entry point (`processText`) behavior preserved (inline return, no push notification)
- Both execution variants preserved: email (`_executePhase3` with notify+mark_read) and Telegram (`_executePhase3Silent` with inline return)

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Category classifier produces wrong category | LLM picker constrained to live list; null on uncertainty; user can fix in AB |
| Account hallucination with only 1 retry | 1 retry with explicit account list feedback covers most cases; stop is safer than inserting to wrong account |
| Cold-start: new merchants always go to "Misc" | Same as current behavior — resolve_merchant fallback is unchanged |
| Category auto-learn locks in wrong answer | Two-step `learn_fact → update_fact` on contradiction; when user re-categorizes in AB, memory auto-corrects (fixes #100) |
| Removing V2/V3 gates allows invalid data through | Payee resolved by code (validated by resolve_merchant), category classified against live list — no LLM guessing to validate |
| Phase 1 LLM produces skip=false for promotional email | Current Phase 1a has same risk with no retry; acceptable tradeoff |

---

## Files to Modify

| File | Change |
|------|--------|
| `src/orchestrator.js` | Rewrite orchestrator: 3 phases, remove V2/V3 gates, add account validation, add category classifier. Add two-step `learn_fact → update_fact` on contradiction for auto-learn self-correction. Preserve both `_executePhase3` (email: notify+mark_read) and `_executePhase3Silent` (Telegram: inline return, no notify/mark_read). |
| `src/prompts.js` | New Phase 1 prompt (replaces Phase 1a + Phase 2 prompts), new category picker prompt |
| `tests/orchestrator.test.js` | Rewrite tests for 3-phase flow |
| `tests/deterministic-orchestrator.test.js` | Rewrite tests for 3-phase flow |
| `tests/prompts.test.js` | Update prompt tests |

### Files NOT Modified

| File | Reason |
|------|--------|
| `src/tools.js` | `resolve_merchant` unchanged |
| `src/mcp-server.js` | Tool schemas unchanged |
| `src/classify.js` | Email classification unchanged |
| `src/index.js` | Entry point unchanged |
| `src/statement/**` | Statement pipeline unchanged |

---

## Implementation Order

1. Write the new Phase 1 + category picker prompts (`prompts.js`)
2. Implement `_runPhase1()` — LLM extraction + account validation + parse retry
3. Implement `_resolvePhase2()` — payee (memory → resolve_merchant → Misc) + category (memory → LLM picker → null)
4. Rename `_executePhase4` → `_executePhase3`, `_executePhase4Silent` → `_executePhase3Silent`, remove payee+category learn_fact calls
5. Wire `_processEmailInternal` and `_processTextInternal` to use 3-phase flow
6. Remove dead code listed above
7. Update existing tests + add new tests for 3-phase flow
