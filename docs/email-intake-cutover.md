# Email-intake cutover runbook (issue #783)

The cutover moves email booking from expense-tracker's IMAP IDLE watcher to
Hermes email intake. One GitHub Actions variable decides which of the two books:

| `EMAIL_INTAKE_MODE` | expense-tracker watcher | Hermes intake |
|---|---|---|
| `shadow` (default, also when unset) | books mail, marks it read | classifies, rehearses dry runs, books nothing |
| `live` | off (`imap_watcher_disabled` in its log) | books, marks INBOX read, messages the home chat |

Hermes never books while the watcher could: each live run first asks
`GET http://expense-tracker:8080/health`, and books only when it answers
`"email_watcher": "off"`. An unreachable tracker, or an older one without that
field, counts as on, and live waits.

## Before go

1. The day-14 go/no-go in friday#6 is a go.
2. The four cutover PRs, this runbook's included, are merged and deployed.
3. These Actions settings exist (names only):
   `HERMES_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_HOME_CHANNEL`,
   `BWS_ACCESS_TOKEN`, `BWS_PROJECT`. Without the webhook secret intake only
   classifies; without the Telegram pair it books but sends no message.

## Go

1. In GitHub, set the Actions variable `EMAIL_INTAKE_MODE` to `live`, where it
   is defined today (repository variables, or the `darren-prod` environment's).
   The Deploy workflow passes it to both containers in its one deploy step.
2. Actions → Deploy → Run workflow, `ref` `main`, `components` `all`. Both
   containers must restart: a variable change alone triggers no deploy.

Order does not matter. Mail that arrives while one side is restarting is
unread and unbooked, so live intake catches it up from its handoff snapshot.

## Check

From the deploy run's logs and the containers' logs (read-only):

- expense-tracker logs `imap_watcher_disabled`, and its `/health` shows
  `"email_watcher":"off"`.
- Hermes logs `[email-intake] live mode started`. It logs `live dispatch waits`
  while the watcher still reports on; that must stop within one interval
  (300 s by default).
- The next financial email arrives in the home chat once, booked in Actual.

## Roll back

1. Set `EMAIL_INTAKE_MODE` back to `shadow` (or delete it).
2. Run the Deploy workflow with `components` `all`.

The watcher resumes with unread mail only, so it skips everything intake
already booked and marked read. Hermes drops its live start point on its
first shadow run, so a later go takes a fresh handoff and never re-books mail
the watcher booked in between.
