> Historical record: loan sync is implemented (tests committed) and this plan's premise no longer holds. This file is kept as a record of the plan.
QUESTIONS
q: How is the currency of a source verified? | a: The operator confirms that membership in the configured primary Actual Budget establishes SGD; reject any explicit conflicting currency.
q: How are customer-specific source and destination accounts supplied? | a: Supply private runtime configuration; do not include account identifiers or names in public repository content or logs.

## Plan

- Add failing tests using synthetic identifiers, covering configured account selection, signed cents, missing or invalid accounts and balances, unchanged balances, changing balances, summary reporting, and the OneDrive push.
- Read the three distinct configured sources from the primary budget's accounts endpoint and balance endpoint. Require each to resolve to an open off-budget account; reject conflicting currency, failed reads, invalid integers, and unsafe sums. Never log private account identifiers or names.
- Resolve the configured portfolio destination, validate its currency and reject any collision with an existing sync target before passing the signed sum to the existing balance reconciliation bridge. Surface a sanitized error for collisions; test that existing targets still sync. Surface failures in the loan target and cron summary without suppressing existing targets, including early budget-fetch failures.
- Wire private runtime settings through the existing Compose and deployment pipeline, without committing customer-specific values. The operator supplies those settings through the existing private configuration mechanism.
- Add focused regression tests to the required CI test list and its guard. Run those tests and the relevant portfolio-tracker suite. Obtain independent review and CI validation on the same commit, then use the repository's PR and deployment flow.

## Reconciliation reproduction

On base commit `5f7ceca1e4ff969dc1ba3c1c462051e978275905`, with only the synthetic test and loader copied into the base worktree, run:

`node --no-warnings --experimental-loader ./modules/portfolio-tracker/tests/loan-loader.test.mjs --test modules/portfolio-tracker/tests/loan-repro-147.test.js`

The command exits 1: `not ok 1 - loan_sync_147 failed reconciliation`; the expected signed target is `-3.25`, but the actual target is `undefined`. This reproduces the missing loan reconciliation, not merely missing configuration. The test and loader are in the working tree awaiting plan approval.
