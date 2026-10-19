QUESTIONS
q: Does actual-api GET /transactions page or cap rows? | a: No. modules/actual-api/server.js:986 returns every getTransactions row between since_date and today.
q: Is full transaction history required by the weekly digest? | a: No. The snapshot deliberately fetches only TXN_DAYS = 8 days for recent-change detection.

# Plan: stop wiki-finance-refresh reporting the Actual transaction window incomplete

## Problem
The 2026-10-19 weekly digest opened with "incomplete: Actual Budget transaction feeds are unpaged, so the 45 SGD rows and 0 MYR rows do not verify complete transaction history." The snapshot meta in `modules/hermes/scripts/wiki-source-snapshot.py` labels the source `has_more: "false (unpaged route)"`. The prompt in `modules/hermes/50-seed-defaults` marks a run partial when a source is "unavailable or truncated", and the agent read "unpaged" as possibly truncated.

## Change
1. `actual()` meta: `has_more: False` plus `completeness: "complete for window (actual-api /transactions returns every row, no paging or cap)"`.
2. Step 1 of the wiki-finance-refresh prompt: one sentence that Actual transactions cover only the last 8 days by design, are complete for that window, full history is not required, and zero rows is valid.

## Tests
New `modules.tests.test_wiki_source_snapshot.WikiSourceSnapshotTest.test_actual_meta_marks_the_transaction_window_complete` stubs `mcp_call` and `http_json` and asserts `has_more is False`, `completeness` mentions complete, and no "unpaged". Existing `modules/hermes/tests/test-50-seed-defaults.sh` must stay green.

## Risk
Prompt-only wording plus a metadata label; no data path changes. Deployed by existing CI/CD after merge.
