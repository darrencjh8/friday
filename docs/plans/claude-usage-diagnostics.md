# Claude Usage Failure Diagnostics

QUESTIONS
q: Does this change claim to fix the earlier stale interval? | a: No. The collector recovered before inspection; the earlier failure is unproven.
q: Should this change refresh credentials or modify the live schedule? | a: No. Keep credentials read-only and leave operational scheduling changes for explicit follow-up approval.

## Evidence and Scope

Issue #35 tracks missing diagnostics when the usage snapshot becomes stale.
`modules/fetch-claude-usage.py:main` catches every exception and returns 1 with
no evidence, while the documented cron invocation discards stdout and stderr.
The only production caller of the helper is its command-line entry point;
deployment also invokes that entry point for a best-effort first snapshot.
Existing helper tests require quiet stdout/stderr and preservation of the last
good output. The router marks a snapshot stale after 900 seconds.

Read-only inspection found a fresh host snapshot, a correct read-only directory
bind, and an upstream HTTP 200. The schedule points at a retired checkout whose
helper is currently identical; deploying the new code alone will not migrate
that schedule. Document this limit rather than claiming the incident is fixed.

## Changes

1. In the helper's existing failure handler, choose only a fixed diagnostic
   category: numeric HTTP status, network, invalid_data, filesystem, unexpected.
   Never log exception strings, URLs, paths, bodies, tokens, or credential data.
2. Send one warning via the standard-library syslog module with a fixed
   `claude-usage: collection failed:` prefix. Syslog survives cron's redirection.
   Catch logging failures so they cannot change the nonzero exit or overwrite
   the previous snapshot. Keep successful runs quiet and unchanged.
3. Add isolated tests for HTTP 401/429, network, invalid data, filesystem,
   unexpected errors and logging failure. Mock syslog and network; use only
   synthetic temporary credentials and snapshots. Run the existing helper and
   deploy-wiring tests unchanged.
4. Update the deployment runbook: explain safe categories, how an authorized
   operator reads system logs, and why the user-owned cron must reference the
   current deployed helper rather than a retired checkout. Do not change cron,
   deployment code, token refresh, or router status contracts in this PR.

## Validation and Delivery

The new failure-diagnostic test has reproduced against base 6b7a18b. After plan
approval, implement minimal handling, run all collector tests and PII checks,
then obtain spec conformance and independent exact-SHA code review before PR
and CI. This is diagnostic coverage, not a fix for an unproven upstream outage.

Dev-loop codex-router #464 affects virtualenv interpreter symlinks. Use a copied
interpreter in this worktree's ignored virtualenv; no policy gate is relaxed.
