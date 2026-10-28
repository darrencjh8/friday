QUESTIONS
q: Does Hermes fall back to the container env for a passthrough name missing from the profile scope? | a: No. With gateway.multiplex_profiles true (live config), tools/env_passthrough.resolve_passthrough_value calls agent.secret_scope.get_secret, which returns the default (None) on a scope miss when serves_routed_profile() is true, and that is always true under multiplexing. Verified live on 2026-10-28: the terminal tool printed "GTASKS_CLIENT_ID set: False" while the container env has both.
q: Where does the profile scope come from? | a: build_profile_secret_scope reads <home>/.env plus external secret sources. Live /opt/data/.env has no GTASKS_* key.
q: Is there an existing mechanism to put a container variable into the profile .env? | a: Yes. The PYALLOWLIST block in modules/hermes/50-seed-defaults mirrors mirrored_exact names (BWS_ACCESS_TOKEN, NOTION_API_KEY, IMAP_*) from the boot environment into $HERMES_HOME/.env, atomically and mode 0600.
q: Do GTASKS values need dotenv quoting? | assumption: No. Google OAuth client ids and secrets are [A-Za-z0-9._-] only, matching the block's existing plain KEY=value ponytail limit.
q: Is the #58 terminal.env_passthrough entry still needed? | a: Yes. It is what makes the names allowlisted; the profile .env is what gives them a value.

# GTASKS credentials in the profile secret scope (issue #75)

## Problem

`wiki-due-reminders` still fails after #58 with `GTASKS_CLIENT_ID/GTASKS_CLIENT_SECRET must be set.`, from both `execute_code` and `terminal`. #58 allowlisted the names, but under `multiplex_profiles` an allowlisted name takes its value from the profile secret scope (`/opt/data/.env`), which lacks them.

## Change

1. `modules/hermes/50-seed-defaults`: add `GTASKS_CLIENT_ID` and `GTASKS_CLIENT_SECRET` to `mirrored_exact` in the `PYALLOWLIST` block, with a one-line comment saying why.

The next deploy's boot writes both into `/opt/data/.env`; no manual prod edit.

## Tests

- New `modules/tests/test_hermes_seed_allowlists.py::SeedAllowlistTest.test_mirrors_gtasks_oauth_client` (the reproduction): runs the real block with both variables set and asserts both lines land in the profile `.env` and the secret is not printed. RED at base, GREEN after.
- Existing `python -m unittest discover -s modules/tests -p 'test_*.py'`.

## Out of scope

Changing how Hermes resolves passthrough values, and the `gtasks.py` CLI itself.
