QUESTIONS
q: How is the currency of a source verified? | a: The operator confirms that membership in the configured primary Actual Budget establishes SGD; reject any explicit conflicting currency.
q: How are customer-specific source and destination accounts supplied? | a: Supply private runtime configuration; do not include account identifiers or names in public repository content or logs.

## Plan

- Add failing tests using synthetic identifiers, covering configured account selection, signed cents, missing or invalid accounts and balances, unchanged balances, changing balances, summary reporting, and the OneDrive push.
- Read the three distinct configured sources from the primary budget's accounts endpoint and balance endpoint. Require each to resolve to an open off-budget account; reject conflicting currency, failed reads, invalid integers, and unsafe sums. Never log private account identifiers or names.
- Resolve the configured portfolio destination and validate its currency before passing the signed sum to the existing balance reconciliation bridge. Surface failures in the loan target and cron summary without suppressing existing targets.
- Wire private runtime settings through the existing Compose and deployment pipeline, without committing customer-specific values. The operator supplies those settings through the existing private configuration mechanism.
- Run the focused tests and relevant portfolio-tracker suite. Obtain independent review and CI validation on the same commit, then use the repository's PR and deployment flow.
