# Issue #372: bill-payment account resolution

## Goal

Remove the legacy bill-payment parser's dependency on numeric account suffixes appearing in Actual Budget account display names. Preserve supported legacy DBS bill-payment formats and resolve identities through the same fact-based resolver used by structured movement parsing.

## Steps

1. Add failing orchestration tests for legacy-shaped bill-payment input where Actual Budget account names contain no suffix digits. Verify deterministic fact resolution, no LLM request, correct account, transfer payee, uncategorized transfer, and closed-account safety.
2. Extract legacy bill-payment fields into a `bank_movement` object and pass it to `_resolveMovementToOutput`.
3. Remove suffix-versus-account-name matching, duplicate date/account lookup code, and the legacy output shape.
4. Keep the legacy parser only as a compatibility extractor for formats not accepted by `parseBankMovement`.
5. Run focused tests, complete expense-tracker suite, syntax checks, and coverage.
6. Perform one fresh self-review as explicitly approved by the user, then create a pull request with `Fixes #372` and wait for required CI before merge.

## Safety

The resolver must not choose ambiguous or closed accounts. If facts cannot resolve an identity, the legacy path must fall through to the existing LLM extractor/full Phase-1 handling rather than insert a transaction against an inferred account.
