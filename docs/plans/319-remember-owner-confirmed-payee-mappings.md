QUESTIONS
q: Does the insert path at tools.js:1975 preserve an orchestrator-composed note line, or recompose notes from args? | assumption: It passes through — composeNotes preserves non-Merchant/Statement lines as user lines (transaction-notes.js). Build verifies with a test at the insert boundary and moves the line into the insert handler if not.
q: When a destination correction names neither a masked suffix nor a recipient bank, is there an existing fact shape to record, or does the correction stay one-row-only? | assumption: One-row-only; no new fact shape is invented — the two evidence cases both named an account/suffix, and YAGNI forbids inventing a shape for a case with no evidence.

# Plan: remember owner-confirmed payee and transfer mappings so repeat transfers book directly (#319)

## Problem (fact-checked)

- Held transfers: the orchestrator holds unverified-counterparty transfers (`_hold_cause: "person_identity_unverified"`, orchestrator.js ~:1385; `"destination_unresolved"`, ~:1631-1650) and raises one heads-up via `notify_message`. When the owner states the category in chat, the model books the row via the insert/update tools — but nothing records the mapping. The next identical transfer holds again and notifies again (issue evidence: same recipient twice, owner stated the category twice, first attempt lost to a restart).
- Destination corrections: the owner says "that was a transfer to my wallet account"; the row is fixed via `update_transaction`, but no fact is written, so the next transfer to that closed/never-added account holds again.
- The read side already works: `rememberedPayee` (orchestrator.js:514) frees the outgoing hold (:1628-1631); `counterpartyIsRememberedEntity` (:427, :1105) releases the person hold; `identityMappingsFromFacts` (bank-movement.js) reads suffix facts and `X alert recipient maps to Y account` facts. The write side is the gap.
- The skill already tells the model to offer "Remember this for future <merchant> payments?" after correcting a *booked merchant* transaction (`modules/hermes/skills/expense-tracker/SKILL.md`, "Correcting a booked transaction"). It does not cover held transfers (no booked row, no merchant descriptor — the key is the counterparty name / incoming amount rule) or destination corrections (no canonical form given).
- No code writes a "remembered mapping" note today (grep: no `Remembered:` note anywhere); acceptance criterion 3 is unmet.

## Design

Reuse the existing learned-facts mechanism. No new write path, no new tool, no new fact grammar.

- Payee/category: `<NAME> maps to <Payee> payee` plus `<Payee> maps to <Category> category`, via the existing `learn_fact` tool (tools.js:326; `_handle_learn_fact` → `memory.add`, which dedups: duplicate / structured / semantic duplicate). Descriptor validated with `descriptorOf` (learning.js) before the call. Incoming person transfer: `Incoming <CUR> <amount> from <NAME>` via `incomingKey` — never the name alone (docs/design.md).
- Destination: `Card/Account ending <suffix> belongs to <account>` (`canonicalSuffixFact`, suffix-facts.js) when the alert named a masked suffix; `<bank> alert recipient maps to <account> account` when it named a recipient bank. Both are already read by `identityMappingsFromFacts`.
- Trust boundary (unchanged from #720/#723): only an owner-stated mapping is recorded, in the same turn as the booking — the owner's statement IS the confirmation, so no second "remember this?" question. Never `learn_fact` a Jev pick, never on silence, never `Misc`. The offer flow (`PendingLearning`, /remember commands, `confirm_learning`) is untouched.
- Rejected: automatic recording inside `insert_transaction`/`update_transaction` — the pipeline also calls those for auto-bookings, so an automatic write would launder Jev guesses into memory, violating #720. Rejected: offer-first for a hand-stated mapping — a second round trip for something the owner already confirmed.
- Booking note (the only code change): in `_resolvePhase2`, after the payee is final, when `payee_source` is `"memory"` or `"incoming_rule"`, append a note line naming the mapping, e.g. `Remembered: <key> maps to <payee> payee`, using the existing `[output.notes, line].filter(Boolean).join("\n")` pattern (cf. the Abroad/Trip line at :3312). Key: the counterparty name for the person-memory / ownerPayee path, `incomingKey(name, {currency, amount_cents})` for the rule path (import it from learning.js — the orchestrator already imports `descriptorOf` from there). When the destination was resolved via a remembered suffix/recipient mapping, the note names that mapping: `_resolveMovementToOutput` sets `_remembered_destination_fact` (the fact text) when `resolveMovementAccounts` used a stored suffix/recipient mapping, and Phase 2 appends a line naming it whenever that field is present — the `_suffix_mappings` output cannot carry it (`_collectSuffixMappings` deliberately skips any suffix already in the store, so it is empty exactly when a remembered fact did the resolving, and recipient mappings are never collected there), and the internal-transfer branch sets `payee_name` with no `payee_source`, so the destination trigger is the field, not `payee_source`. One append site in Phase 2 covers both paths. It flows through to the Phase 3 insert site (:3981, `composeNotes`) so it lands in the inserted row's notes. `composeNotes` preserves non-Merchant/Statement lines (transaction-notes.js). The old :3211 site cannot be used: the Phase 2 memory tier is guarded by `!output.payee_name`, and transfer outputs whose payee came from a remembered mapping arrive from `_resolveMovementToOutput` with `payee_name` already set, so `memoryKey` stays `""` and :3211 never runs for them.
- Heads-up unchanged for first-timers: the hold plus a single heads-up stay for any counterparty with no remembered mapping; only a remembered mapping skips them (the read side already does this).

## Changes

1. `modules/hermes/skills/expense-tracker/SKILL.md` — extend "Correcting a booked transaction" with a short "Held transfers and destination corrections" subsection: after booking a held transfer the owner confirmed, or fixing a transfer destination, record the mapping in the same turn with the canonical forms above (payee/category, incoming amount rule, suffix/recipient destination fact); say what was saved; no second question when the owner already stated it; never Jev, never `Misc`, never on silence. Prompt-only change; no new tool.
2. `modules/expense-tracker/src/orchestrator.js` — in `_resolvePhase2`, after the payee is final, append the `Remembered: ...` note line to `output.notes` when `payee_source` is `"memory"` / `"incoming_rule"` (key per Design), and when the output carries `_remembered_destination_fact` (set by `_resolveMovementToOutput` when `resolveMovementAccounts` used a stored suffix/recipient mapping — see Design). One append site in Phase 2, feeding the Phase 3 insert.
3. `modules/expense-tracker/tests/remembered-payee-booking-note-319.test.js` (new) — vitest:
   - `319-note-names-mapping`: a movement whose counterparty has a `NAME maps to PAYEE payee` fact books with `payee_source: "memory"` and notes containing `Remembered: <key> maps to <payee> payee`. (RED: note line absent.)
   - `319-suffix-note-names-mapping`: a movement whose destination was resolved via a stored suffix/recipient fact books with notes containing `Remembered: ...` naming that mapping. (RED: note line absent.)
   - `319-remembered-recipient-books-direct`: a second identical transfer to the remembered recipient books with no `_hold_unresolved_transfer` and no heads-up. (RED: held again.)
   - `319-first-time-still-heads-up`: an unknown recipient still holds with exactly one heads-up. (Guards criterion 4.)
   - `319-destination-fact-resolves`: a suffix fact (or recipient fact) makes a transfer to a closed/never-added account resolve instead of holding. (RED: holds.)
   Test command: `npm test` (`vitest run`) in `modules/expense-tracker`. Existing tests already cover the read side (`transfer-hold-families`, `transfer-destination-validation-570`, `payee-category-tier1a`); the new file pins only the new behavior.

## Out of scope

- New UI; changes to the offer flow, `confirm_learning`, /remember commands, or `PendingLearning`; new fact grammar; automatic recording in insert/update; touching `confirm_learning` when commands are on; any Hermes live-state work (none needed — repo code + skill prompt only).

## Verification

- `npm test` in `modules/expense-tracker` green, with the new tests RED at base and green at HEAD (the RED control the tests gate requires).
- Review: 1 clean plan round (0 Critical/High) via the loop.py plan gate; human approval on the plan hash before build.
