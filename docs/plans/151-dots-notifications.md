QUESTIONS
q: Should these notifications also continue to Telegram? | a: No. Send proactive-tick and expense-tracker webhook notifications to Dots only; leave other routes unchanged.
q: Should an existing proactive-tick keep its current delivery target? | a: No. The seed owns this target and should migrate it to Dots while preserving operator-owned schedule and enabled fields.

# Send selected notifications to Dots

## Goal

Send `proactive-tick` cron messages and expense-tracker transaction webhook notifications to Dots. Do not fan out to Telegram or change other notification routes.

## Change

- Assert the `platforms.webhook.extra.routes.notify` route delivers to `dots` with `DOTS_HOME_CHANNEL` as its channel.
- Set the seeded `proactive-tick` delivery to `dots`, and manage that field on existing seeded jobs so deployment migrates the current job without changing its schedule or enabled state.
- Leave all other cron jobs and notification routes unchanged.

## Validation

- Add `modules.tests.test_dots_notification_destinations.DotsNotificationDestinationsTest.test_proactive_tick_and_expense_webhook_deliver_to_dots`; it must fail at base and pass at HEAD, asserting the webhook route and both new-job and existing-job proactive-tick destinations.
- Run the focused Dots wiring and proactive-tick tests, then the seeded-cron shell test.
- Do not run production services, deploy, or change production data; CI/CD handles deployment after PR merge.

## Risk

This is a user-facing delivery destination change. Dots must be configured and reachable for these two notification paths; Telegram will no longer receive these selected messages. Other notification paths retain existing behavior.
