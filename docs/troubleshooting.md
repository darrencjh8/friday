# Troubleshooting

Failure modes an agent or operator will actually hit, and where the answer is.
Production is never fixed by hand: diagnose from logs and the status endpoints,
then ship a fix through a pull request so CI/CD applies it. See
[operations.md](operations.md) for the deploy flow and the health endpoints.

## The deploy fails before anything starts

`modules/deploy.sh` validates configuration before it builds or restarts
anything, so a missing variable fails the run without touching production.

- **"N variable(s) missing or empty."** The message names the variable above it.
  In GitHub Actions the value comes from repository secrets; locally it comes from
  the module's `.env` file. `COMMANDCODE_API_KEY` is the one most often missing
  and it is **required**, not optional: six of the seven Hermes auxiliary slots
  pin `commandcode/*` as their primary model, and without the key the router never
  publishes it, which breaks compression, vision, `web_extract`,
  `kanban_decomposer`, `triage_specifier`, and `profile_describer` outright
  rather than degrading them. The seventh slot, `approval`, is unaffected
  because it pins `auto-thinking` instead.
- **"Module .env not found at …"** A pluggable module declares its required
  variables in `modules/<name>/module.env`; outside GitHub Actions those
  variables are read from that module's `.env`. Locally the file is simply
  absent, which is different from the value being empty.
- **"OneDrive authorization is required to sync the Portfolio file."** The
  refresh token under `modules/onedrive-sync/config/onedrive/` is missing or
  unreadable. It is runtime state and is never committed. This message only
  appears on an **interactive** run: it sits inside the `NON_INTERACTIVE != true`
  guard in `deploy.sh`, and CI always passes `--non-interactive`. A deploy that reaches CI without a token instead
  prints the warning `"⚠ No refresh_token found. OneDrive is not initialized."`
  and carries on — it is yellow, not a failure, so it will
  not stop a deploy or mark a step red. Neither path fails the run.

## The deploy completes but a service is not healthy

`deploy.sh` runs the checks in [operations.md](operations.md) after
`compose up` and exits non-zero if any fails, printing "N service(s) not
healthy". Read `docker-compose logs` for that service. Notes that change what to
look for:

- **codex-router** is checked on `/health/liveliness` through the front on
  `:4100` and is retried against a readiness budget. A deploy rolls the
  `codex-router-a` / `codex-router-b` colours one at a time, so `:4100` stays
  up; a single early failure is expected, exhausting the budget is not.
- **hermes** has no HTTP health port (`HERMES_DASHBOARD=0`), so the check is
  `s6-svstat` on the `gateway-default` service. A failure here is a gateway
  process problem, not an HTTP one.
- **Only the components just deployed are health-checked.** A retired module
  cannot answer, which is why a partial deploy never trips on it.
- After the HTTP checks the script runs `hermes mcp test` for both trackers, and
  only for the ones just deployed. A service can be healthy on `/health` and
  still have a broken MCP connection, which is what that catches — but note the
  asymmetry: a failure there prints "failed (retry later)" in yellow and does
  **not** fail the deploy. A green deploy with a yellow MCP line means the
  connection is broken, not that everything is fine.

## A documented change did not reach production

- **Merged to `main` but nothing changed?** Check what the deploy detected. The
  workflow maps changed paths onto components by prefix (`modules/hermes/`,
  `modules/actual-api/`, `modules/codex-router-front/`, and so on; a change
  under `.github/` deploys `hermes`). If no prefix matches, `COMPONENTS` is empty
  and the step falls back to `all` — so a change outside those directories
  rebuilds and redeploys the whole stack rather than nothing. A change to
  `modules/docker-compose.yml`, `modules/deploy.sh`, or a root `Dockerfile` also
  forces a full deploy.
- **`modules/codex-router` does not exist in your clone.** It is not part of
  this repository. CI checks `darrencjh8/codex-router` out into that path at
  deploy time; a plain clone has no such directory and that is expected.
- **The router is behind.** `sync-codex-router.yml` runs every five minutes and
  deploys when `codex-router`'s `main` differs from the last deployed revision,
  so a router merge lands on its own schedule, not with whatever else you merged.

## Secrets and PII

- `secrets-scan.yml` and `.gitleaks.toml` run on every push. A hit blocks the
  merge; it is not a warning.
- `modules/expense-tracker/data/dedup.db` and `.../data/statement.db` hold
  transaction hashes and statement state, and `modules/expense-tracker/metadata.json`
  holds Actual Budget IDs, a user UUID, and encryption keys. The root
  `.gitignore` covers all three: `data/` is unanchored, so it matches
  `modules/expense-tracker/data/` at any depth, and `*.db` and
  `**/metadata.json` catch the rest. Verify with
  `git check-ignore -v <path>` rather than assuming. Treat the ignore rules as a
  safety net against an accidental commit, not as a substitute for keeping these
  out of the working tree, and never paste them into an issue.
- `.gitleaks.toml` adds **five** custom PII rules — `email-address`,
  `private-key-header`, `openai-api-key`, `slack-webhook`, and
  `generic-api-key-assignment` — and their exceptions are **per rule, not
  global**. `email-address` allowlists the `@example.com` and `@test.com` regexes
  and the `tests/` and `__tests__/` paths, so a fixture there will not trip it — a
  real address anywhere else will. `private-key-header` allowlists only `tests/`,
  so a `__tests__/` fixture with a private-key header does trip it.
  `generic-api-key-assignment` is scoped by *path* to `.env.example`,
  `.template`, `.sample`, `config.example`, and `.config.sample`, and its regexes
  whitelist only obvious placeholders — so in every other file that rule never
  examines the line at all. A separate global `[allowlist]` at the top of the
  file covers lockfiles.

## Where the knowledge lives

| Symptom | Read |
|---|---|
| an email was booked wrongly | [architecture.md](architecture.md), expense-tracking pipeline |
| a portfolio import is wrong | [architecture.md](architecture.md), portfolio-tracking pipeline |
| a spec and the code disagree | [docs/expense-tracker/](expense-tracker/), and the `specs/` table in [docs/README.md](README.md) |
| a test fails for an environmental reason | [testing.md](testing.md) |
| the deploy did the wrong thing | [operations.md](operations.md) |
