QUESTIONS
q: Does AC-3 require holding when no far-side row exists? | assumption: No. In the ordinary path the far row has not arrived, so holding would stall every transfer. The narrower invisible-row gap is accepted risk and tracked.
q: Add the settle-based AC-3 proof to CI now? | assumption: No. It is slow and timing-dependent; it is tracked as follow-up coverage.

# Plan: #598 own-account FAST transfer pair

## Goal

One own-account FAST transfer (OCBC 360 → POSB Cashback, SGD 1,000.00, 2026-09-23, ref `2609230000266880`) must book as a single transfer pair instead of two unclassified `Misc` rows, and the two legs must link both ways once both exist.

## Status of this change

The implementation is already written and reviewed on branch `fix/598-own-account-fast-transfer-pair`: three commits (`2be2232`, `83bf200`, `a4be72b`), since merged with `origin/main` so the branch carries the current base `aa8b50f`. Four review rounds ran under the previous gate protocol and closed two High, two Medium, and one Low finding; the last two rounds returned APPROVE on the unchanged HEAD, and CI is green on `a4be72b`.

This plan therefore records the change under the current gate rather than proposing new work. There are no further code mutations: everything the plan describes is already committed and covered by tests in this branch. The only open item is a Low finding, which this plan disposes of as accepted risk in line with the policy that a Low or Nit finding is closed by disposition and never by mutation.

## The defect, and why it needed three commits

The transfer arrives as two separate bank alerts (OCBC outgoing, DBS inbound) and each one was booked independently:

1. The DBS inbound sentence form carries no `Amount :` label, so `parseBankMovement` returned `null`, the movement fell through to the LLM extractor, and it was booked as an unclassified `Misc` credit. Fixed by the DBS inbound FAST branch in `bank-movement.js`.
2. The OCBC leg parsed, but its destination `Darren POSB (-155500)` resolved to no live account, so the leg was not recognised as a transfer. Fixed by the suffix and recipient-bank resolution in `bank-movement.js` and the suffix-learning gate in `orchestrator.js`.
3. Once both rows existed, nothing linked them. Linking after the insert is too late: the near leg is inserted carrying the other account's transfer payee, and the Actual engine's `runTransfers` then creates a *second* counterpart row, after which the link route rejects the already-linked leg. Fixed by deciding the existing far side **before** the insert and suppressing the derived transfer payee at the wire.

## What each changed file does

- `modules/expense-tracker/src/bank-movement.js` — parses the DBS inbound FAST notice; carries `recipient_bank`; resolves the destination through the account's own suffix.
- `modules/expense-tracker/src/orchestrator.js` — `_findExistingFarSide` decides the far side before `reserve_transfer` (so a hold reserves nothing and stays retryable); holds on an ambiguous or wrong-account candidate instead of degrading to the duplicate-creating path; passes `suppress_transfer_payee`; fixes the suffix-learning gate so a suffix is only learned from evidence that actually names the account.
- `modules/expense-tracker/src/tools.js` — `find_link_candidate` returns `{candidate, matches}` so "no far side" is distinguishable from "several candidates"; `insert_transaction` honours `suppress_transfer_payee` where the payee is actually decided, not merely at the argument.
- `modules/actual-api/server.js` — `POST /transactions/link-transfer` writes each leg's `transfer_id` to the other, standing in for `runTransfers`, which creates a counterpart instead of linking two existing rows.
- `modules/expense-tracker/docs/transfer-inference-test-plan.md` — documents the linking path and its pass criteria.

## Verification

- Reproduction recorded at the base revision: the DBS inbound body fails to parse as an incoming movement at `aa8b50f` and parses at HEAD.
- Targeted tests: `modules/expense-tracker/tests/own-account-fast-transfer-598.test.js` (17 tests, including wire-level assertions that the transfer payee is suppressed, driven through the real `ToolRegistry` rather than a mock), `modules/actual-api/__tests__/link_transfer.test.js` (+7 tests).
- Mutation check: disabling the payee suppression turns the wire-level test red, so the test guards the defect rather than restating the implementation.
- Full suites: expense-tracker 1163 passed / 5 skipped; actual-api jest 199 passed.
- End-to-end on a real budget: seeding the two legs as ordinary rows and replaying the route's two writes produces both `transfer_id`s pointing at each other, both categories null, and exactly two rows with no counterpart. This required waiting for the async batch to settle; an immediate read reports a stale state and wrongly suggests only one write landed.

## Accepted risk

The far-side read recognizes one row shape: an uncleared, unlinked row on the far account, on the same calendar day, at the opposite signed amount, still on the unclassified `Misc` payee. A far row that exists but differs — a different payee, a cleared row, or a leg whose date was resolved through the LLM path's UTC normalisation instead of the parser's SGT slice — is invisible to the read, so the near leg is booked with its transfer payee and the duplicate shape can recur. Fail-closed behaviour currently covers only multiple candidates. This is a fail-open read and the sharper half of the finding is real; it is accepted as risk with a tracking issue rather than fixed here, because closing it means widening the detection heuristic, which is a larger change than the defect it guards and carries its own risk of linking rows that are not a pair.

## Test plan

No new tests: the change under this plan is already covered, and the policy forbids mutating for a Low finding. The recorded reproduction is replayed by the test gate at HEAD, so the fix must still stop the reproduction or the gate fails closed.

## Follow-ups to file

1. The far-side read's fail-open gap above, with the reproduction shape and the wrong-account/absent-match reasoning.
2. Promote the settle-based end-to-end proof into CI, so a future change to the link route cannot silently break it.
