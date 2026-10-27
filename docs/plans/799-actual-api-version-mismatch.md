QUESTIONS
q: What should CI do when the sync-server is newer than the client? | a: Fail. The user chose this on 2026-10-12: a PR touching modules/actual-api fails, and a daily scheduled run fails too, so a server upgrade made outside this repository is caught between PRs.
q: What counts as a mismatch? | a: The client's major.minor is older than the server's (the user chose this). Patch versions are ignored, and a client ahead of the server passes.
q: How should the runtime tell the user? | a: Send a warning through the existing Hermes webhook (NOTIFY_URL, signed with HERMES_WEBHOOK_SECRET, the same contract expense-tracker's notify_user uses), once per client/server version pair per process, and return an explicit ACTUAL_VERSION_MISMATCH error instead of "No budget file is open".
q: Should the warning fire before anything breaks, e.g. at startup? | assumption: No. Being newer is not always breaking; only a budget the newer client migrated fails. The daily CI run is the early warning, and the runtime warns when a load actually fails.
q: Can CI reach the sync-server? | a: Yes. GET <ACTUAL_BUDGET_URL>/info is public and unauthenticated. The production sync-server URL is vars.ACTUAL_BUDGET_URL, defined on the darren-prod environment (verified: https://flyio-frosty-glitter-5667.fly.dev). That environment has no protection rules or branch policy, so the drift job declares `environment: darren-prod` to read it. Inside the stack, the compose value of ACTUAL_BUDGET_URL points at actual-api itself, not the sync-server.

# Plan: actual-api client/server version mismatch (#799)

## Root cause (verified on production 2026-10-12)

- The sync-server on fly.io reports `@actual-app/sync-server 26.10.0`. Its 26.10 web UI opened the MYR budget and applied migration `…8782000` (the 26.10 migration).
- modules/actual-api runs `@actual-app/api` 26.9.0, whose newest migration is `…3118115`. `load-budget` returns `{ error: "out-of-sync-migrations" }` and closes the budget.
- In 26.9.0's `api/download-budget`, the local-cache branch ignores that result and resolves. `server.js` sees a successful download, and every read then throws "No budget file is open".
- The Dockerfile copies only package.json and runs `npm install`, so the lockfile is ignored and the deployed version floats with `^26.9.0`.

The base-commit reproduction `__tests__/version_mismatch.test.js` fails with `Received string: "No budget file is open"`.

## Change scaffold

- `modules/actual-api/server.js`: three call sites run `retryWithBackoff(() => actual.downloadBudget(...))`: `init()`, `reopenActiveBudget()` and `applyBudgetSwitch()`. Each route catches with `res.status(500).json({ error: e.message })`.
- Tests: jest (`npm test` in modules/actual-api, run by the `actual-api` job in `.github/workflows/test.yml`). The existing `budget_reopen_regression.test.js` and `read_budget_race.test.js` drive the same probe/reopen path and must stay green.
- Deploy: `deploy.yml` rebuilds actual-api when `modules/actual-api/` changes; compose env lives in `modules/docker-compose.yml`.

## Changes

1. **Dependency**: pin `@actual-app/api` to `26.10.0` (exact, no caret) and regenerate `package-lock.json`.
2. **Dockerfile**: `COPY package.json package-lock.json ./`, then `npm ci --omit=dev`, then `COPY *.js ./` in place of `COPY server.js .`. The new `version-check.js` that `server.js` requires then ships in the image, and so does any later top-level module. Guard: the `actual-api` job in `.github/workflows/test.yml` gains a step that builds the image and runs `docker run --rm --entrypoint node <image> -e "require('./version-check'); require('@actual-app/api')"`. A file missing from the image now fails CI instead of crash-looping production, because jest runs from the source tree and cannot see it.
3. **`modules/actual-api/version-check.js`** (new, about 50 lines):
   - `clientVersion()`: reads the installed library's package.json from disk. Its `exports` map hides it from `require`.
   - `isClientBehind(client, server)`: compares major.minor and ignores any pre-release tag.
   - `serverVersion(url)`: GET `/info` and return `build.version`.
   - `notifyOnce(message)`: a signed POST to `NOTIFY_URL`, memoized per message, which is a no-op when `NOTIFY_URL` is unset. A notify failure is logged and never thrown.
4. **`server.js`**: one helper, `downloadAndOpen(syncId)`, replaces the three call sites. It runs the existing retried download, then checks `budgetIsOpen()`; the check stays outside the retry, so it doesn't loop through backoff. If the budget is closed:
   - When the client is behind the server, it throws `ACTUAL_VERSION_MISMATCH: @actual-app/api <client> is older than sync-server <server>; a newer client migrated budget <syncId>. Bump @actual-app/api in modules/actual-api.` and sends that text once through `notifyOnce`.
   - Otherwise it throws `Budget <syncId> did not open after download; see actual-api logs`.
   - If `/info` itself fails, it uses the generic message and states that the server version could not be read.
5. **`modules/docker-compose.yml`**: pass `NOTIFY_URL` and `HERMES_WEBHOOK_SECRET` to actual-api, using the same variables expense-tracker already receives.
6. **`modules/actual-api/scripts/check-server-version.js <url> [lockfile]`**: reads the `@actual-app/api` version from `package-lock.json` (default: the module's own; the optional second argument lets tests pass a fixture; no install needed) and the server version from `<url>/info`, using `isClientBehind`.
   - On drift it prints `::error title=Actual version mismatch::@actual-app/api <c> is older than sync-server <s>` and exits 1.
   - If the server is unreachable it prints `::warning::` and exits 0, so a fly.io blip doesn't fail unrelated runs.
7. **`.github/workflows/actual-version-drift.yml`**: runs on `pull_request` for paths `modules/actual-api/**` and the workflow file, daily on `schedule`, and on `workflow_dispatch`. It is a single job with `environment: darren-prod` running `node modules/actual-api/scripts/check-server-version.js "${{ vars.ACTUAL_BUDGET_URL }}"`. It reads no secrets.

## Tests

- RED (already committed): `__tests__/version_mismatch.test.js`. Route-level, with mocked library and `fetch`. Covers the mismatch message, the one-time signed webhook, and the generic message when there is no version gap.
- `__tests__/version_check.test.js`: the `isClientBehind` table and `clientVersion`.
- `__tests__/check_server_version.test.js`: spawns the CI script with a fixture lockfile against a local `http` stub serving `/info`. Covers three cases:
  - Client behind: exit 1, with stdout containing `::error title=Actual version mismatch::`.
  - Client equal or ahead: exit 0.
  - Server unreachable (closed port): exit 0, with `::warning::`.
- CI image smoke (see change 2): the image contains every module `server.js` requires.
- The full `npm test` suite stays green.
- Manual check: run `node scripts/check-server-version.js https://<prod sync url>` locally before and after the bump. Expect exit 1 on 26.9.0 and exit 0 on 26.10.0.

## Rollout

Merge, then let deploy.yml rebuild actual-api. The cached MYR file already carries `…8782000` (the 26.10 migration), which 26.10.0 knows, so MYR loads without a manual step. Verify with a read-only `GET /accounts?budget_id=<MYR>` after deploy, with user approval.

## Out of scope

The wiki-finance-refresh cron agent writing YAML frontmatter into a `.json` file. That's a Hermes prompt nit and gets its own issue.
