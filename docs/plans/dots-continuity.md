QUESTIONS
q: Which cron jobs are in scope? | a: The eight named Dots-delivered jobs whose seed blocks live in `modules/hermes/50-seed-defaults`.
q: Which settings may migration change? | a: Only `attach_to_session`; preserve every other existing field and do not create duplicates.
q: How is webhook ownership selected? | a: Keep `${DOTS_HOME_CHANNEL}`; docker-compose resolves it to `owner`. Add only `mirror_to_session: true`.

## Goal

Persist reply continuity for the notify webhook and Dots-delivered cron jobs.

## Scope

- Set `mirror_to_session: true` on `platforms.webhook.extra.routes.notify`, retaining the existing Dots target and environment-based owner channel.
- Add `attach_to_session: true` to the managed fields for `wiki-finance-refresh`, `memory-compact`, `wiki-due-reminders`, `wiki-repo-docs`, `gtasks-clear-completed`, `notion-monthly-bills-reset`, `actual-backup`, and `proactive-tick`.
- Extend focused tests for new-install seeds, in-place migration of existing jobs, webhook config, and preservation of operator schedules/enabled state/other fields.

## Validation and rollout

- Run focused Python tests, the Hermes seed test script, and the expense-tracker webhook Vitest.
- Open a PR, obtain required review and CI, then merge through GitHub so deploy.yml ships the change.
- After deployment, inspect the resolved live notify route and listed cron jobs. Do not edit production or restart/redeploy manually.

## Risks

- Existing job schedules and operator-owned settings could be overwritten; `attach_to_session` is the only new managed migration field and tests pin preservation.
- The checked-in target uses `${DOTS_HOME_CHANNEL}` rather than a literal chat ID; deployment resolves it to `owner`, preserving existing ownership configuration.
