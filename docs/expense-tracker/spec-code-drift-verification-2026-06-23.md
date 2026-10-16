# Spec-Code Drift Verification — expense-tracker

Generated: 2026-06-23
Task: t_35d7690e
Analyst: static-analyst (independent verification of project-manager's analysis at t_f7034904)

Sources:
- **Spec:** /opt/data/skills/expense-tracker/SKILL.md
- **Code:** /opt/data/friday/modules/expense-tracker/src/ — 15 source files
- **Static analysis report:** From parent task t_a353360b

## Method

Each drift from the existing analysis (t_f7034904/spec-code-drift-analysis.md) was independently verified against source files. Every claim was cross-checked at the specific file:line cited.

---

## Confirmed Drifts (Definitive)

### Drift 1: 4-phase vs 3-phase architecture [CRITICAL]

**Spec claim (SKILL.md lines 5-17):** Describes a 4-phase pipeline:
- Phase 1a: Field Extraction (LLM, reasoning=disabled, no tools)
- Phase 1b: Deterministic Mapping (currency->budget_id, 3x search_memory)
- Phase 2: LLM Audit (cross-reference memory hints vs live data, V2 gate, retries <=3x)
- Phase 3: Web Search (resolve_merchant, V3 gate, retries <=2x)
- Phase 4: Execute (insert, dedup, notify, learn)

**Code reality (orchestrator.js JSDoc header lines 1-8):** "3-phase pipeline. Phase 1: LLM ANALYSIS reasoning=adaptive, fetch_context tool, 1 retry. Phase 2: RESOLUTION code-driven. Phase 3: EXECUTE"

The spec's Phases 1a, 1b, and 2 are collapsed into code's Phase 1. Spec's Phase 3 folded into code's Phase 2. Spec's Phase 4 maps to code's Phase 3.

**Spec section:** SKILL.md lines 5-17
**Code locations:** orchestrator.js:1-8 (header), :266 (_runPhase1), :513 (_resolvePhase2), :685 (_executePhase3)

---

### Drift 2: Phase 1 uses reasoning=adaptive, spec says reasoning=disabled [MEDIUM]

**Spec claim (SKILL.md line 9):** Phase 1a "reasoning=disabled, no tools"

**Code (orchestrator.js:282-283):** this._llm.chat(messages, tools, "auto", { reasoning: "adaptive" })
- reasoning is "adaptive", not "disabled"
- tools IS populated via getPhase1ToolSchemas() (returns fetch_context schema)

**Spec section:** SKILL.md line 9 (Phase 1a)
**Code location:** orchestrator.js:282-283

---

### Drift 3: Phase 1b 3x search_memory not implemented [MEDIUM]

**Spec claim (SKILL.md line 11):** Phase 1b does "3x search_memory for payee/account/category candidates"

**Code (orchestrator.js:266-486):** _runPhase1 does NOT call search_memory during main flow.
- search_memory for account_id is fallback on validation retry only (:431-448)
- search_memory for payee: Phase 2 (:536-543)
- search_memory for category: Phase 2 (:600-620)
- No 3x memory search anywhere

**Spec section:** SKILL.md line 11 (Phase 1b)
**Code location:** orchestrator.js:266-486

---

### Drift 4: V2 validation gate MAX_RETRIES=1, spec says <=3x [MEDIUM]

**Spec claim (SKILL.md line 13):** "V2 validation gate blanks invalid fields, retries <= 3x"

**Code (orchestrator.js:275):** const MAX_RETRIES = 1;
- 1 retry = 2 total attempts max, not up to 3 retries (up to 4 attempts)

**Spec section:** SKILL.md line 13 (Phase 2)
**Code location:** orchestrator.js:275

---

### Drift 5: Phase 3 "Web Search" separate retry loop doesn't exist [MEDIUM]

**Spec claim (SKILL.md lines 15-16):** "Phase 3 Web Search: resolve_merchant. V3 gate validates, retries <= 2x."

**Code (orchestrator.js:559-565):** resolve_merchant called inside _resolvePhase2 without retry gating. No V3 gate. Failure falls to "Misc" default.

**Spec section:** SKILL.md lines 15-16 (Phase 3)
**Code location:** orchestrator.js:559-565

---

### Drift 6: Phase numbering - spec Phase 4 is code Phase 3 [LOW]

**Spec claim (SKILL.md line 17):** Phase 4 - Execute
**Code (orchestrator.js:685):** _executePhase3 / _executePhase3Core
**Spec section:** SKILL.md line 17
**Code location:** orchestrator.js:685

---

### Drift 8: "Leave blank > guess" - code defaults to "Misc" [LOW]

**Spec claim (SKILL.md line 21):** "Leave blank > guess: LLM leaves fields empty when unsure."

**Code (orchestrator.js:582-584):** if (!output.payee_name) { output.payee_name = "Misc"; ... }
Category_id IS correctly left null when unresolvable.

**Spec section:** SKILL.md line 21
**Code location:** orchestrator.js:582-584

---

### Drift 9: "Memory-first" - memory not gathered before LLM audit [LOW]

**Spec claim (SKILL.md line 23):** "Memory hints gathered before LLM audit."

**Code (orchestrator.js:266-486):** Phase 1 LLM call has no memory context. Memory used reactively on validation failure and in Phase 2.

**Spec section:** SKILL.md line 23
**Code location:** orchestrator.js:266-486

---

### Drift 10: Dual-path budget_id risk [LOW]

**Spec claim (SKILL.md line 11):** "Currency -> budget_id" deterministic mapping

**Code (orchestrator.js:346-352):** budget_id derived in code from currency.
**Code (prompts.js:35-37):** Prompt tells LLM about budget_id mapping for fetch_context.

Risk: if LLM misidentifies currency, code fallback uses different budget than LLM used for fetch_context.

**Spec section:** SKILL.md line 11 (Phase 1b)
**Code locations:** orchestrator.js:346-352, prompts.js:35-37

---

## Uncertain Items

### Uncertain 1: "No keyword table" claim vs STRUCTURED_PATTERNS + mappings.json migration [UNCERTAIN]

**Spec claim (SKILL.md line 24):** "No keyword table: Payee matching is memory + web search. No hardcoded keyword->payee mappings."

**Code facts:**
1. migrateFromMappings (memory.js:690-716) converts old mappings.json (keyword->payee/category) into MEMORY.md facts. Runs only if MEMORY.md empty AND mappings.json exists (index.js:54-61).
2. STRUCTURED_PATTERNS (memory.js:30-38) define regex for "X merchant maps to Y payee" — used for dedup/contradiction detection, not payee matching.
3. Payee matching (orchestrator.js:546-551) uses semantic memory search + regex, not keyword lookup. *(superseded: since #471/#472 a structured mapping is matched by key only — exact key or whole-word key containment — and semantic similarity never authorizes one; the line anchors in this dated entry are stale.)*

**Arguments for drift:**
- STRUCTURED_PATTERNS formalize keyword->payee relations (just in memory)
- Migration code shows system designed with keyword mappings as core concept
- Memory facts like "TNG merchant maps to Touch 'n Go payee" ARE keyword->payee mappings

**Arguments against drift:**
- Payee matching uses semantic (embedding-based) search, not keyword table *(superseded: since #471/#472 a structured fact is matched by key only, never by similarity — see `modules/expense-tracker/docs/design.md`, "Merchant matching: keys, not similarity")*
- STRUCTURED_PATTERNS serve dedup/contradiction, not matching
- mappings.json migration is backward-compat cleanup, not active feature
- "Memory + web search" IS how code matches payees

**Why uncertain:** The boundary between "keyword table" and "learned memory fact" is semantic. Does "no keyword table" mean "no keyword->payee lookup exists at all" or "no static hardcoded table, we use dynamic memory"?

**Spec section:** SKILL.md line 24
**Code locations:** `src/suffix-facts.js` (structured patterns), `memory.js` (`migrateFromMappings`, `factNamesMerchant`), `index.js:54-61`, `orchestrator.js` (payee resolution, category resolution). The `memory.js:30-38 / 690-716` and `orchestrator.js:546-551` line numbers written on 2026-06-23 have since moved.

---

## Blocking Signal

One uncertain item requires human decision. Definitive discrepancy list blocked.

**Decision needed:** Is "no keyword table" claim contradicted by STRUCTURED_PATTERNS + mappings.json migration?
- A: Yes, drift — keyword->payee mappings exist in memory format (LOW severity)
- B: No, not drift — spec means no static table; semantic memory is different paradigm
- C: Yes, drift at different severity

---

## Summary

| Status | Count |
|--------|-------|
| Confirmed drift (CRITICAL) | 1 |
| Confirmed drift (MEDIUM) | 4 |
| Confirmed drift (LOW) | 4 |
| Uncertain | 1 |
| Blocked | YES |
