QUESTIONS
q: Where does the multiplexed gateway look for a platform's bot token? | a: In each profile's secret scope. `gateway/run_startup.py` warns "slack is enabled but no profile (default or secondary) provided a bot credential for it … Add its token to the profile that should own it", and the profile scope is built from `$HERMES_HOME/.env` plus secret sources, the same path #75 found for GTASKS.
q: Are the Slack tokens deployed? | a: Yes. `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in the hermes container environment (checked by name only on 2026-10-28), and config.yaml enables Slack on purpose (see SLACK.md). The live `/opt/data/.env` has the Slack home channel and allowlist but neither token.
q: Do the token values need dotenv quoting? | assumption: No. Slack bot and app tokens are `[A-Za-z0-9-]` only, matching the block's existing plain KEY=value limit.
q: Does anything else need the home channel mirrored? | a: No. `SLACK_HOME_CHANNEL` is already in the live profile .env, and `SLACK_ALLOWED_USERS` is mirrored by the existing `*_ALLOWED_USERS` rule.

# Plan: Slack tokens in the profile secret scope (issue #82)

## Problem

Every gateway boot logs that Slack is enabled but no profile provided a bot credential, so Slack is never served. Telegram works because the `PYALLOWLIST` block in `modules/hermes/50-seed-defaults` mirrors `TELEGRAM_BOT_TOKEN` into `$HERMES_HOME/.env`; the Slack tokens are not in that list.

## Change

1. `modules/hermes/50-seed-defaults`: add `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` to `mirrored_exact`, with a one-line comment naming #82.

The next deploy's boot writes both into `/opt/data/.env`; no manual prod edit.

## Tests

- New `modules/tests/test_hermes_seed_allowlists.py::SeedAllowlistTest.test_mirrors_slack_bot_and_app_tokens` (the reproduction): runs the real block with both variables set and asserts both lines land in the profile `.env` and the token is not printed. RED at base, GREEN after.
- Existing `python -m unittest discover -s modules/tests -p 'test_*.py'`.

## Out of scope

Slack app configuration, channel routing, and how Hermes resolves platform credentials.
