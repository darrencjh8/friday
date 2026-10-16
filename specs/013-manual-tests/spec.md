# Manual Pipeline Tests

**Spec:** 013-manual-tests
**Status:** Deferred
**Moved From:** `specs/001-gateway-baseline/tasks.md` T2.1 (2026-06-12)

Manual end-to-end test cases extracted from gateway-baseline. Deferred for formal regression run later.

## Suites (24 cases)

### Suite A: Read Operations (5)
A1–A5: List accounts, categories, transactions, spending by category, account balance.

### Suite B: Simple Write — SGD (3)
B1–B1c: Track expense → confirm → verify in Actual Budget UI.

### Suite C: Duplicate Detection (2)
C1–C2: Duplicate skip, non-duplicate insert.

### Suite D: Currency Routing (3)
D1–D3: SGD → Example SGD, MYR → Example MYR, ambiguous → ask.

### Suite E: Payee-to-Category Mapping (4)
E1–E4: Hawker→Food, Grab→Transport, Coffee→Coffee, unknown→ask.

### Suite F: Account Matching (2)
F1–F2: Card ending match, bank name match.

### Suite G: Error Handling (3)
G1–G3: Unknown account, missing payee, missing amount.

### Suite H: Portfolio Tracker (2)
H1–H2: /status, balance query.

## Acceptance
- [ ] All 24 cases pass with no errors in docker compose logs.

Full test case details at `specs/001-gateway-baseline/tasks.md` §T2.1 (original source).
