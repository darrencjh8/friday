QUESTIONS
q: Can the set of budgets on the sync server change while actual-api runs? | assumption: rarely, and only by an operator creating or deleting a budget file; `withBudget` already documents that "existence cannot change while the process runs", so a list reused for 60 seconds is safe, and a new budget becomes visible within a minute.
q: Which callers should share the cached list? | a: only `resolveBudgetTarget`, the per-request hot path. `init()` runs once and `GET /budgets` is an operator diagnostic, so both keep a fresh `getBudgets()` call.
q: Should a failed fetch be cached? | a: no. A rejected promise clears the cache so the next request tries again; the existing `retryWithBackoff` behaviour is unchanged.

# Plan: share one budget list across concurrent requests (issue #73)

## Problem

`modules/actual-api/server.js` resolves the budget a request names in `resolveBudgetTarget`, which calls `getBudgets()` → `actual.getBudgets()` on every request. That call fetches the sync server's file list, and it runs outside the budget lock, so a burst of N concurrent requests sends N file-list requests at once. In production the sync server answered such bursts with HTTP 429: 608 logged at 2026-10-27 15:xxZ and 1,664 at 2026-10-28 01:29Z, both just after a Hermes deploy, when its jobs hit actual-api together.

The reproduction (`__tests__/budget_list_cache.test.js`) fires 20 concurrent `/accounts` requests that name a budget and counts `actual.getBudgets()` calls: 21 at base (one from `init()`, one per request).

## Change

1. Add a module-level cache in `server.js` used only by `resolveBudgetTarget`:
   - `cachedBudgetList()` returns a shared promise of the budget list. If a promise exists and is younger than `BUDGET_LIST_TTL_MS` (60 000 ms), return it; otherwise start `getBudgets()`, store the promise and its start time, and return it.
   - When the promise rejects, clear the cache (only if it is still the stored one), so failures are never reused.
   - Concurrent callers share the in-flight promise, so a burst costs one file-list request.
2. `resolveBudgetTarget` calls `cachedBudgetList()` instead of `getBudgets()`. `init()` and `GET /budgets` are unchanged.
3. A `ponytail:` comment names the ceiling (a budget created on the server is invisible to name resolution for up to 60 s) and the upgrade path (invalidate on a miss).

## Tests

- RED/GREEN: `__tests__/budget_list_cache.test.js`
  - "a burst of budget-named requests fetches the budget list once": ≤ 2 `getBudgets` calls for 20 concurrent requests (fails at base with 21).
  - "a rejected budget list is not cached": a rejected fetch answers 500, and the next request fetches again and succeeds.
- Full actual-api jest suite must stay green (run in `node:22-slim`, since `@actual-app/api` needs Node ≥ 22).

## Out of scope

- The caller burst itself (Hermes jobs after a deploy) is legitimate traffic; it is not throttled.
- No change to `retryWithBackoff`, the lock, or budget switching.
