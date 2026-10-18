QUESTIONS
q: Which proposals can a Telegram approval authorize? | a: Only merge rows in the exact saved curator run named by the proposal ID; pruning rows are never authorized by merge approval.
q: What happens when the report is missing or changed? | a: Reject the approval and ask for a fresh proposal; never regenerate a report to interpret an old approval.
q: How are selected rows applied? | a: The assistant reads the validated selected mappings from the original run and applies only those mappings through the existing skill tools; this change does not auto-apply anything.
q: What is the dev-loop reproduction workaround for this repository's test layout? | a: Put the RED test under modules/tests, the suite directory discovered from .github/workflows/test.yml; dev-loop issue #462 tracks support for other nested suites.

# Exact-scope skill merge approvals

## Goal

Make Telegram replies to skill-merge proposals usable and bind every approval to the exact saved proposal and selected merge rows. Do not apply any proposal as part of implementation or deployment.

## Facts

- `modules/hermes/scripts/curator-proposals.py` runs a curator dry run and reads the newest `logs/curator/<run>/run.json`.
- The delivered message uses a Markdown table. Telegram rich reply blocks are not fully flattened, and `rich_sent_store` truncates stored text at 2,000 characters; non-empty partial text prevents the adapter's cache fallback.
- Re-running the curator creates a different proposal and is not evidence of what an earlier reply approved.
- Curator reports preserve the original `llm_final`, including the structured consolidation list.
- The Hermes image already copies scripts and skills from this repository into its defaults; existing upstream patches are applied at build time and fail closed on source drift.
- Dev-loop repro issue #462: nested `modules/hermes/tests` files are not overlaid into the base worktree. The regression test lives in `modules/tests`, which the workflow suite discovery recognizes.

## Changes

1. Extend `curator-proposals.py` to print a stable proposal ID derived from the saved run directory and a SHA-256 prefix of its `run.json`. Number merge rows and include concise approval syntax. Do not number or authorize prune rows as merges.
2. Add `curator-proposal-approval.py` to locate the original run by ID, verify its report hash, extract its structured summary, validate `all` or an explicit comma-separated selection, and emit only the selected original merge mappings as JSON. Reject missing, changed, malformed, or out-of-range reports/selections; never run the curator.
3. Add a skill instruction for processing `approve <proposal-id> all`, `approve <proposal-id> 1,3`, and `reject <proposal-id>`. It must invoke the validator, apply only validated mappings through existing skill tools, and stop on any missing/stale/mismatched report. A reply without a proposal ID may use the replied-to proposal context only when its ID is unambiguous; otherwise ask for the ID.
4. Add an idempotent build-time patch for Telegram reply context: native explicitly selected quote stays authoritative; when it is absent, preserve the complete original rich message (including table rows) from the sent-message cache instead of accepting partial flattened text. Increase the cache limit enough for long proposal messages while retaining a finite bound.
5. Add focused tests for proposal ID/hash generation, selected-row validation and stale/malformed reports, and Telegram rich reply precedence/table/long-message behavior. Add them to the existing CI workflow.

## Not changed

- No skill merge is applied by the generator, validator, or build.
- No regenerated curator report is substituted for a referenced proposal.
- No approval of pruning or unrelated skill edits.
- No production service inspection, test, build, deployment, restart, or mutation.

## Validation

- Run the focused tests in the isolated worktree; use the `.venv` interpreter.
- Run the repository's full relevant Python test commands and CI checks, then obtain a fresh clean code review and use the repository PR/CI path.
