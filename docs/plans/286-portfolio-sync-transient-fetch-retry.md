# Plan: retry transient fetch failures in the portfolio sync legs (friday #286)

QUESTIONS
q: Retry the Graph/download (pull) and resolve/upload (push) fetches with the token fetched once before the loop, and retry the two flex fetch steps from SendRequest — or retry each individual fetch inside them? | assumption: token once, then the Graph/download or resolve/upload fetches in one loop (the token fetch takes the leg's retryDelays via getAccessToken, so the token hop gets the same 30s/60s backoff without re-exchanging after success); flex retries both steps from SendRequest. Whole-function retry was rejected in review round 1: it would re-call getAccessToken per attempt.
q: Does the IBKR Flex query cover a multi-day window, so a missed day's trades are re-imported by the next successful run — or is it a single-day query, making a missed day permanently lost? | assumption: multi-day window (the standing daily statement query); the implementation confirms the query's period from the IBKR configuration and says so in the PR; if it is single-day, the plan is revised before building.
q: When the pull fails, should the sync still push the local file (current behavior — risks overwriting a newer remote file) or skip the push? | assumption: unchanged — push still runs; the retry removes the observed trigger, and skipping the push would leave the Actual Budget balance updates unsaved for the day. Changing push gating is a separate decision, not this fix.
q: Should the shell script (portfolio-sync.sh) also retry the whole sync once? | assumption: no — the retry belongs in the service legs where the failure is; a shell-level retry would re-run the whole sync including a second push.
q: Retry delays — reuse the existing shapes (getAccessToken: 2s, 4s; fetchBudget: 1s, 2s, 4s)? | a: No — 3 attempts total with 30s then 60s delays (attempts at t=0, 30s, 90s), spanning the observed recovery of up to about 86 seconds; worst case about 90s per leg, and all three legs failing fully is about 270s plus the AB/taxonomy steps, approaching curl's 300s budget — delays must not grow beyond 30s/60s without revisiting that budget. Tests inject short delays via the retryDelays option so the suite stays fast.

## Goal

Stop a transient external-network blip from failing the daily
`finance-portfolio-sync` run. The 2026-11-20 14:30 SGT run failed with exit
1 because the OneDrive pull and the IBKR flex pull both failed with the bare
Node message `fetch failed`, and neither leg retried. After this change a
blip lasting up to about 90 seconds is absorbed by bounded retries, and
if the legs still fail, the error names the underlying cause instead of the
bare `fetch failed`.

## Fact-checks (verified 2026-11-21 in a fresh clone at HEAD 78863e7)

- Issue #286, live state: OPEN, `in-progress` label, picked-up comment from
  friday-museai present. Failure `execution_failed`, observed
  2026-11-20T10:31:05Z, job `finance-portfolio-sync` (`aee1c123bb29`),
  schedule `30 14 * * *`. Script exit 1; stderr shows the sync triggered at
  06:30:44Z, HTTP 200 at 06:32:10Z, `sync complete`, then `ERROR: a sync
  step failed`; stdout shows `pull: error (fetch failed)` and `flex_pull:
  error (fetch failed)`, `push: ok (uploaded)`, `taxonomy_export:
  completed`, all four sync targets `unchanged (delta=0)`.
- The cron: `README.md:80` and `modules/hermes/50-seed-defaults:1151-1216`
  seed `finance-portfolio-sync` (`30 14 * * *`), which runs
  `modules/hermes/scripts/portfolio-sync.sh` as a zero-token `POST
  http://portfolio-tracker:8081/tools/pp-sync-all`.
- The script (`modules/hermes/scripts/portfolio-sync.sh`) curls the endpoint
  (`--max-time 300`), parses the JSON body, prints one line per leg, and
  exits 1 when any leg printed an error line — correct per #81 (Hermes
  judges a no_agent script cron by its exit code alone). HTTP was 200, so
  the exit 1 came from the two error legs, not the transport. No change
  needed in the script.
- `fetch failed` is Node's undici `TypeError` message for a network-level
  failure (DNS, connect, TLS, reset). Both failing legs use global `fetch`:
  pull goes `PpClient.pull()` (`modules/portfolio-tracker/src/java_bridge.js:343`)
  → `pullFromOneDrive()` (`src/onedrive.js:77`) → `fetch` to
  login.microsoftonline.com / graph.microsoft.com / the download URL; flex
  pull goes `pullFlexXml()` (`src/ibkr_flex.js:48`) → `fetch` to
  ndcdyn.interactivebrokers.com. Both legs return only `e.message`, dropping
  `e.cause` (which carries e.g. `getaddrinfo ENOTFOUND`), so the log cannot
  say which hop failed or why.
- Timing evidence the outage was transient: the pull ran ~06:30:44Z and the
  push — which also needs a Microsoft token fetch plus a Graph PUT —
  succeeded ~06:32:10Z; the Actual Budget fetches over the internal Docker
  network (`actual-api:3000`) succeeded and the targets computed. External
  fetches failed, internal worked, and the external path recovered within
  about 86 seconds.
- Retry gaps, read from the code: `getAccessToken` already retries 3 times
  with 2s/4s backoff (`src/onedrive.js:37-72`), but the Graph
  resolve/children/download fetches in `pullFromOneDrive` and the
  resolve/upload fetches in `pushToOneDrive` have no retry, and
  `pullFlexXml` has no retry at all. The token hop is the gap inside the
  gap: `getAccessToken` throws after ~6s (2s+4s sleeps), and `pull`/`push`
  catch that throw before any Graph retry loop is entered — so a transient
  failure at `login.microsoftonline.com` still fails the leg in ~6s, and
  the incident log (which dropped `e.cause`) cannot prove which hop
  failed. `fetchBudget` in `src/tools.js:943`
  retries 3 times with `2 ** attempt` second backoff — the shape to copy.
  The timeouts are `AbortSignal.timeout` (30s in `ibkr_flex.js:75,127`,
  10–60s in `onedrive.js`), whose abort error is a `TimeoutError`
  (`The operation timed out`), distinct from the network `TypeError`.
- What the failure cost that day: the flex import never ran (no XML), so the
  prior day's IBKR trades/dividends were not imported that day; the AB
  balances were unchanged (delta=0), so the push of the local file changed
  nothing. The scheduler health finding fired correctly — #286 exists
  because the signal worked, not because the signal is broken.
- Callers of the three functions, so the fix lands everywhere at once:
  `pullFromOneDrive` / `pushToOneDrive` are called from
  `tools.js:_computeSyncAll` (the cron path), `tools.js:701,712` (the MCP
  onedrive tools), `mcp-server.js:301,307,349,379`, and
  `java_bridge.js:171,345,425` (pull, corruption-recovery pull, push);
  `pullFlexXml` is called from `tools.js:891` only.
- Existing tests that stub `fetch` the same way the new tests do:
  `modules/portfolio-tracker/tests/onedrive.test.js` (fs mocks, token/Graph/
  download stubs), `tests/onedrive-legs.test.js` (M1–M4 leg rendering, the
  flex `skipped` sentinel, a stubbed failing `fetch`), and
  `tests/loan-sync-147.test.js` (mocks `pullFlexXml`).

## Change

1. `modules/portfolio-tracker/src/ibkr_flex.js` — `pullFlexXml`: wrap the
   two fetch steps in up to 3 attempts total (delays 30s, then 60s), retrying
   only transient errors (see the classifier below). A retry restarts from
   step 1 (`SendRequest`), not from the `GetStatement` step, because a
   reference code may be single-use. Never retry the not-configured
   sentinel (`NOT_CONFIGURED_ERROR`), an IBKR `<Status>Fail</Status>`
   response (e.g. error 1012, token expired), or HTTP 4xx. On final
   failure, include the underlying cause in the returned error:
   `fetch failed (<cause message>)` when `e.cause` is present, so the next
   incident names the hop and the reason. Signature:
   `pullFlexXml({ retryDelays = [30000, 60000], retryBudgetMs = 90000 } = {})`; existing callers
   pass no arguments and get the defaults.

   Transient classifier (one small `isTransientFetchError(e)` predicate,
   written identically in both modules — the repo hand-rolls per-site retry
   loops, so no shared module is introduced for one predicate): retry when
   any of these holds, otherwise do not retry —
   - `e` is a `TypeError` with message `fetch failed` (undici network
     failure: DNS, connect, TLS, reset), or
   - `e.name === "TimeoutError"` (an `AbortSignal.timeout` abort — the
     timeouts are 30s in `ibkr_flex.js:75,127` and 10–60s in `onedrive.js`,
     and the abort error is a `TimeoutError`, not a `TypeError`), or
   - `e.message` matches `/HTTP (429|5\d\d)/` (an HTTP 429 or 5xx thrown as
     `... HTTP <status> ...`).
   Never retry HTTP 4xx, IBKR `<Status>Fail</Status>` responses (returned,
   not thrown), `Not configured`, `Portfolio.portfolio not found`, or
   local-file errors.
   `ibkr_flex.js` needs a module-local `sleep` helper for the retry delays
   (`onedrive.js` already has one at the bottom of the file).

   Elapsed guard (each retry loop measures elapsed from its own start):
   before each retry sleep, stop retrying when elapsed + next delay exceeds
   90s. When attempts fail fast (the incident's mode) the full 90s window
   is preserved (attempts at t=0, 30s, 90s); when a fetch hangs to its
   timeout, the loop stops burning the curl budget instead. The guard
   budget is an option, `retryBudgetMs` (default 90000), so tests can pin
   it with a small value.
2. `modules/portfolio-tracker/src/onedrive.js` — `pullFromOneDrive` and
   `pushToOneDrive`: the same 3-attempt transient-only retry (delays 30s,
   then 60s, same classifier, same 90s elapsed guard), with the same
   cause-surfacing in the returned `error`. The access token is fetched
   ONCE, before the retry loop, but with the leg's backoff:
   `getAccessToken({ retryDelays, retryBudgetMs } = {})` takes the leg's
   options (its own default `[2000, 4000]` is preserved for existing
   callers such as `uploadBackup`), and `pull`/`push` pass the leg's
   `retryDelays` through — so a transient failure at
   `login.microsoftonline.com` gets the same 30s/60s backoff instead of
   failing the leg in ~6s, and the token is frozen after first success
   (no re-exchange per attempt). The loop retries only the Graph
   resolve/children/download fetches (pull) and the resolve/upload fetches
   (push). The GETs are idempotent and the PUT is a full-file replace
   (`conflictBehavior=replace`), so retrying those fetches is safe.
   Signatures: `pullFromOneDrive(localPath, { retryDelays = [30000, 60000],
   retryBudgetMs = 90000 } = {})` and `pushToOneDrive(localPath, {
   retryDelays = [30000, 60000], retryBudgetMs = 90000 } = {})`; existing
   callers pass at most the path and get the defaults. `pullFlexXml` takes
   the same options shape: `pullFlexXml({ retryDelays = [30000, 60000],
   retryBudgetMs = 90000 } = {})`.
3. No change to `tools.js`, `portfolio-sync.sh`, `50-seed-defaults`, or the
   cron schedule. No change to the shell parser's leg rendering — it prints
   `detail`/`error` verbatim, so the richer message flows through
   unchanged, and the `ONEDRIVE_RELOGGED` re-login path (which keys off
   `Token HTTP 400` / `OneDrive refresh token not found`) is unaffected
   because 4xx is never retried and its message wording is unchanged.
4. No new dependency, no config change, no credential handling. Worst-case
   latency, corrected to count the per-attempt timeouts as well as the
   delays (the earlier draft counted delays only): when attempts fail fast
   (the incident's mode) each leg takes about 90s, so a fully degraded run
   is about 270s plus the healthy AB/taxonomy steps (~10–30s) — inside
   curl's 300s budget, but tight; if a future run ever hits the curl
   timeout, raising `--max-time` in `portfolio-sync.sh` is the fix, not
   longer delays. When fetches hang to their timeouts, the 90s elapsed
   guard caps each loop: flex at most ~150s, pull at most ~160s (token
   loop ~60s + Graph loop ~100s), push at most ~110s. A simultaneous hang
   of every remote still exceeds 300s — the run then fails, which is the
   correct outcome for a total outage; the guard's job is to keep a single
   hanging leg from burning the whole budget and orphaning the push.
   Tests inject short delays (`retryDelays: [10, 20]`) so the suite stays
   fast; production uses the `[30000, 60000]` defaults.

## Tests

- New file `modules/portfolio-tracker/tests/sync-retry-286.test.js` (already
  written as the RED control; see below): 15 tests —
  `sync.retry.286.flex.pull.retries.transient.fetch.failure`,
  `sync.retry.286.onedrive.pull.retries.transient.fetch.failure`,
  `sync.retry.286.onedrive.push.retries.transient.fetch.failure`,
  `sync.retry.286.fetch.error.names.underlying.cause`,
  `sync.retry.286.flex.pull.retries.http.503`,
  `sync.retry.286.flex.pull.does.not.retry.http.400`,
  `sync.retry.286.flex.pull.retries.timeout.abort`,
  `sync.retry.286.onedrive.pull.retries.http.503`,
  `sync.retry.286.flex.pull.does.not.retry.expired.token`,
  `sync.retry.286.onedrive.pull.does.not.retry.http.400`,
  `sync.retry.286.flex.pull.retries.getstatement.after.referencecode`,
  `sync.retry.286.onedrive.pull.retries.download.failure`,
  `sync.retry.286.onedrive.push.retries.upload.failure`,
  `sync.retry.286.onedrive.pull.retries.token.fetch.with.leg.delays`,
  `sync.retry.286.flex.pull.stops.retrying.after.elapsed.budget`.
  The first twelve fail at base (the retry/cause tests, the three
  second-fetch tests, the token-delay test, and the elapsed-guard test);
  the three never-retry guards pass at base and pin the boundary. Every
  retry test passes `retryDelays: [10, 20]` so it runs in milliseconds
  against the 30s/60s production defaults. The second-fetch tests pin the
  retry surface a partial implementation would miss: the flex test returns
  a `ReferenceCode` first, fails the `GetStatement` fetch, then succeeds
  on the retry (which restarts from `SendRequest`, 4 fetch calls total);
  the pull test fails the download (503) after a good resolve; the push
  test fails the upload PUT after a good resolve. The token test mocks the
  token fetch failing twice then succeeding and asserts the whole leg
  finishes in under 1000ms — at base `getAccessToken` ignores the injected
  delays and sleeps 2000ms+4000ms, so it fails there and passes once the
  leg's delays reach the token fetch (margins: ~6000ms at base vs ~30ms
  with the fix, threshold 1000ms). The guard test passes
  `retryDelays: [20, 40], retryBudgetMs: 45` with a permanently failing
  fetch and asserts exactly 2 fetch calls: attempt 1, one 20ms sleep,
  attempt 2, then the guard stops it (elapsed ~20ms + 40ms delay > 45ms).
- RED control, recorded in the dev-loop run (phase `REPRODUCED`, base
  78863e7): `cd modules/portfolio-tracker && npm install --ignore-scripts
  --no-audit --no-fund --loglevel=error && npx vitest run
  tests/sync-retry-286.test.js -t
  sync.retry.286.flex.pull.retries.transient.fetch.failure` — exits 1 at
  base, must exit 0 at HEAD. The `npm install` is needed because the
  throwaway worktree has no `node_modules`; `--ignore-scripts` is required
  because the better-sqlite3 native build fails in this environment, and
  `TMPDIR` must point off `/tmp` (a 512M tmpfs that fills with the worktree
  plus `node_modules`). The full file (all 15 tests) is run at the tests
  gate; the existing `onedrive.test.js` and `onedrive-legs.test.js` files
  are run alongside to confirm no regression.
- No live-service verification is possible from this VM (no host access;
  `portfolio-tracker:8081` and IBKR are production): the fix is verified by
  the stubbed-`fetch` tests above, not a live run. The next daily 14:30
  SGT run is the live confirmation; a repeat of the incident would now show
  the retry succeeding (or the cause in the error line).

## Out of scope (considered and rejected)

- Shell-level retry in `portfolio-sync.sh`: the retry belongs in the service
  legs where the failure is; a shell retry would re-run the whole sync
  including a second push.
- Changing push-after-failed-pull gating (QUESTIONS q3): separate decision.
- Changing `getAccessToken`'s retry policy: it already retries, and its
  4xx retry is harmless (3 quick attempts, then a clear `Token HTTP 400`).
- Alerting changes: the scheduler health finding worked — it filed #286.
