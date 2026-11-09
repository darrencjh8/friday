---
name: full-deploy
description: Full production redeploy — sync .env, back up OneDrive token and app data, merge to main, let CI deploy, verify health, OneDrive sync test, non-destructive API audit, log audit, report.
---

# Full Deploy

You perform a complete production redeploy of friday. Complete ALL phases in order. Do NOT skip phases or stop early. Only stop if you encounter a blocking error you cannot resolve, or if you need clarification from the user.

## Server Reference

Read the production server IP and SSH user from the project rules (`.github/copilot-instructions.md` or root `AGENTS.md`). Never hardcode them. If you cannot find them, ask the user.

Typical values: SSH as `darren` to the production server, project root at `~/friday`.

## Phase 0 — Pre-flight

Deploys are CI-only: production is never deployed by hand. Before anything else, confirm the change is merged to `main` and let `.github/workflows/deploy.yml` own the deploy — do NOT `ssh` to the host to pull, build, or run `deploy.sh` yourself.

1. Confirm the pull request is merged to `main` (or that the change is already on `main`) and note the merged HEAD commit.
2. Confirm the deploy workflow will run: a push to `main` triggers `deploy.yml` on the self-hosted runner, which checks out the repo, detects changed components, builds, and deploys. If the push already happened, the workflow is running or done — check its status before proceeding.
3. Do the `.env` sync (Phase 1) and backup (Phase 2) first if the change needs them; the deploy itself still goes through CI.

## Phase 1 — Sync .env Files

`scp` these 3 files from local to production:

| Local Path | Production Path |
|---|---|
| `modules/hermes/.env` | `~/friday/modules/hermes/.env` |
| `modules/portfolio-tracker/.env` | `~/friday/modules/portfolio-tracker/.env` |
| `modules/expense-tracker/.env` | `~/friday/modules/expense-tracker/.env` |

Run all 3 `scp` commands in parallel.

## Phase 2 — Backup (production host only)

Back up all persistent data: OneDrive token, expense-tracker state (memory, dedup, statements), and portfolio-tracker state (dedup, learned mappings).

**IMPORTANT**: Compute the timestamp LOCALLY first. Do NOT embed `$(date ...)` inside a remote single-quoted command.

The `refresh_token` file is owned by `root:root` (created by the Docker container). Use `docker run` to read it since `cp` as darren will fail with Permission denied.

### 2a. Compute timestamp

```bash
TS=`date +%Y%m%d-%H%M` && echo "Backup timestamp: $TS"
```

If `$TS` is empty (shell issue), use epoch seconds instead:

```bash
TS=`date -u +%s 2>/dev/null` && echo "Backup timestamp: $TS"
# If still empty, fabricate one:
[ -z "$TS" ] && TS="manual-$$"
```

### 2b. Create the backup directory

```bash
ssh <user>@<server> "mkdir -p /home/darren/backups/full-deploy-$TS && echo 'backup dir ready'"
```

### 2c. Copy refresh_token via Docker (root-owned file)

```bash
ssh <user>@<server> "docker run --rm -v /home/darren/friday/modules/onedrive-sync/config/onedrive:/conf:ro alpine cat /conf/refresh_token > /home/darren/backups/full-deploy-$TS/refresh_token && echo 'refresh_token backed up'"
```

### 2d. Backup expense-tracker data (MEMORY.md, dedup.db, statement.db)

```bash
ssh <user>@<server> "cp /home/darren/friday/modules/expense-tracker/data/MEMORY.md /home/darren/backups/full-deploy-$TS/ && cp /home/darren/friday/modules/expense-tracker/data/dedup.db /home/darren/backups/full-deploy-$TS/expense-dedup.db && cp /home/darren/friday/modules/expense-tracker/data/statement.db /home/darren/backups/full-deploy-$TS/expense-statement.db && echo 'expense-tracker data backed up'"
```

### 2e. Backup portfolio-tracker data (dedup.db, mappings.json)

```bash
ssh <user>@<server> "cp /home/darren/friday/modules/portfolio-tracker/data/dedup.db /home/darren/backups/full-deploy-$TS/portfolio-dedup.db 2>/dev/null; cp /home/darren/friday/modules/portfolio-tracker/data/mappings.json /home/darren/backups/full-deploy-$TS/portfolio-mappings.json 2>/dev/null; echo 'portfolio-tracker data backed up'"
```

### 2f. Verify backup

```bash
ssh <user>@<server> "ls -la /home/darren/backups/full-deploy-$TS/"
```

Store `$TS` — you'll need it in Phase 6 if token restoration is required. Report the backup path and file sizes to the user.

## Phase 3 — Merge to main (no git pull on production)

Never run `git pull` on the production host. The deploy workflow checks out `main` itself on the self-hosted runner.

1. Merge the change to `main` through a reviewed pull request.
2. Record the merged HEAD commit. The push to `main` triggers `.github/workflows/deploy.yml`; if the change is already merged, the workflow has already run or is running.
3. If a deploy must be forced (for example, to re-deploy unchanged code), use a manual `workflow_dispatch` run of `deploy.yml` with `force_all=true` — never a manual `deploy.sh` run on the host.

## Phase 4 — Wait for the CI deploy

The deploy is owned by `.github/workflows/deploy.yml` on the self-hosted runner: it detects changed components, runs `modules/build.sh`, then `modules/deploy.sh --component ... --non-interactive --skip-build`. This takes several minutes. Wait for the workflow run to complete and read its output (including the health check results at the end) before proceeding to Phase 5.

**Note about deploy.sh**: It health-checks actual-api (3000), expense-tracker (8080), portfolio-tracker (8081), codex-router (4100 `/health/liveliness`), hermes via `s6-svstat` on the `gateway-default` service, and each discovered pluggable module. It does NOT check 8083 (image-gen). A non-zero exit code may come from warp-cli or chrome-daemon setup, not from container failures. Read the actual output to judge success. Proceed to Phase 5 for full verification regardless.

## Phase 5 — Health Verification

After the deploy agent finishes, verify everything:

### 5a. Container status

```bash
ssh <user>@<server> 'cd ~/friday/modules && docker compose ps'
```

All 9 services must show `Up`:

- `hermes`
- `expense-tracker`
- `actual-api`
- `portfolio-tracker`
- `dots-web`
- `whisper`
- `codex-router` (Caddy front)
- `codex-router-a`
- `codex-router-b`

If any service is not Up, check its logs: `docker compose logs --tail=30 <service>`.

### 5b. Health endpoints

```bash
ssh <user>@<server> '
for url in \
  http://localhost:3000/health \
  http://localhost:8080/health \
  http://localhost:8081/health \
  http://localhost:4100/health/liveliness; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")
  echo "$url -> $code"
done
'
```

All must return `200`.

### 5c. Hermes gateway process

Hermes has no HTTP health port, so check the gateway process directly:

```bash
ssh <user>@<server> 'docker exec hermes /package/admin/s6/command/s6-svstat -o up /run/hermes-service/gateway-default'
```

It must print `true`.

### 5d. CDP (Chrome Daemon) for image-gen

The `image-gen` service depends on the Chrome DevTools Protocol proxy running on the host:

```bash
ssh <user>@<server> 'ss -tlnp 2>/dev/null | grep -E "9222|9223" || netstat -tlnp 2>/dev/null | grep -E "9222|9223"'
```

Port 9222 (chrome-daemon) and 9223 (cdp-forward) must both be listening. If not, run:

```bash
ssh <user>@<server> 'sudo systemctl restart chrome-daemon cdp-forward && sleep 2 && ss -tlnp | grep -E "9222|9223"'
```

## Phase 6 — OneDrive Sync

### 6a. Pull from OneDrive via pp-pull

`pp-pull` calls the Microsoft Graph API directly using the refresh token — no Java bridge needed. The PP bridge lazy-initializes when any PP tool is called after the file is downloaded, so no container restart is required.

```bash
ssh <user>@<server> 'curl -s -X POST http://localhost:8081/tools/pp-pull -H "Content-Type: application/json" -d "{}"'
```

Look for `"status":"ok"` and `"detail":"downloaded"`. This downloads the file to `PP_XML_PATH` (typically `/data/onedrive/Portfolio/Portfolio.portfolio`).

### 6b. Verify PP bridge initializes (no restart needed)

After the pull, any PP tool will lazily create the bridge. Verify:

```bash
ssh <user>@<server> 'curl -s -X POST http://localhost:8081/tools/pp-accounts -H "Content-Type: application/json" -d "{}" | head -c 200'
```

If you get a JSON array of accounts, the bridge auto-initialized.

### 6c. If pp-pull fails (token is stale/expired)

1. Restore the backup token (rm first — existing file is root-owned):
```bash
ssh <user>@<server> 'rm -f ~/friday/modules/onedrive-sync/config/onedrive/refresh_token && cp /home/darren/backups/full-deploy-<TIMESTAMP>/refresh_token ~/friday/modules/onedrive-sync/config/onedrive/refresh_token'
```
2. Restart portfolio-tracker (it reads the token at startup):
```bash
ssh <user>@<server> 'cd ~/friday/modules && docker compose restart portfolio-tracker && sleep 10'
```
3. Re-run 6a, then 6b.
4. If still failing — the token may have expired permanently. Notify the user via Telegram and instruct them to re-authorize with the helper script:
```bash
ssh <user>@<server> 'cd ~/friday && bash ./scripts/sync-onedrive.sh'
```
If `scripts/sync-onedrive.sh` does not exist on production yet, create it first (see Phase 10 below for details).

## Phase 7 — Non-Destructive API Audit

Run these 9 read-only API calls. None of them mutate data. Run independent calls in parallel:

### actual-api (port 3000)

```bash
# 1. Accounts
curl -s http://localhost:3000/accounts | head -c 200

# 2. Transactions (recent)
curl -s "http://localhost:3000/transactions?account_id=all&since_date=$(date -d '7 days ago' +%Y-%m-%d)" | head -c 200

# 3. Payees
curl -s http://localhost:3000/payees | head -c 200
```

### expense-tracker (port 8080)

```bash
# 4. Fetch accounts
curl -s -X POST http://localhost:8080/tools/fetch-accounts -H "Content-Type: application/json" -d '{}' | head -c 200

# 5. List facts (memory)
curl -s -X POST http://localhost:8080/tools/list-facts -H "Content-Type: application/json" -d '{}' | head -c 200

# 6. Fetch recent transactions
curl -s -X POST http://localhost:8080/tools/fetch-recent-transactions -H "Content-Type: application/json" -d '{"days":7}' | head -c 200
```

### portfolio-tracker (port 8081)

```bash
# 7. PP accounts
curl -s -X POST http://localhost:8081/tools/pp-accounts -H "Content-Type: application/json" -d '{}' | head -c 200

# 8. PP status
curl -s -X POST http://localhost:8081/tools/pp-status -H "Content-Type: application/json" -d '{}' | head -c 200

# 9. PP taxonomies
curl -s -X POST http://localhost:8081/tools/pp-taxonomies -H "Content-Type: application/json" -d '{"taxonomy_names":["Regions (Liquid)"]}' | head -c 200
```

For each call, check that the HTTP response is valid JSON (not a connection error or empty). Report any failures.

## Phase 8 — Log Audit

Inspect logs across all services for errors:

```bash
ssh <user>@<server> 'cd ~/friday/modules && docker compose logs --tail=100 --no-log-prefix 2>&1 | grep -iE "error|fail|fatal|exception|timeout|refused|unreachable" || echo "No critical errors found"'
```

Then get the last 30 lines of each service for a manual scan:

```bash
ssh <user>@<server> 'cd ~/friday/modules && for svc in hermes expense-tracker actual-api portfolio-tracker dots-web whisper codex-router codex-router-a codex-router-b; do echo "=== $svc ===" && docker compose logs --tail=30 "$svc" --no-log-prefix 2>&1; echo; done'
```

Look for:
- Crash loops or repeated restarts
- Authentication failures (API keys, budget passwords, IMAP logins)
- Network errors between containers
- OneDrive / token errors
- CDP connection errors in image-gen

Report any suspicious lines to the user.

## Phase 9 — Final Report

Summarize everything in a structured report:

```
## Full Deploy Report — <TIMESTAMP>

### Pre-flight
- Services before: X up, Y down

### .env Sync
- All 3 files copied successfully

### Backup
- Path: /home/darren/backups/full-deploy-<TIMESTAMP>/
- refresh_token: <size>
- Expense tracker: MEMORY.md <size>, dedup.db <size>, statement.db <size>
- Portfolio tracker: dedup.db <size>, mappings.json <size>

### Git
- Branch: main
- HEAD: <commit-hash> <message>

### Deploy
- Result: success / failed

### Health
- All 9 services: Up / (list failures)
- All 4 health endpoints: 200 / (list failures)
- Hermes gateway (`s6-svstat` on `gateway-default`): up / down
- CDP ports 9222/9223: listening / not

### OneDrive Sync
- Sync data: success / failed
- pp-pull: success / failed / restored-from-backup

### API Audit
- 9/9 passed / (list failures)

### Logs
- Errors found: (list) / none

### Action Items
- (any remaining issues)
```

If any health check, API call, or log audit reveals a persistent failure that you cannot resolve, notify the user via Telegram:

```bash
ssh <user>@<server> 'cd ~/friday/modules && curl -s -X POST http://localhost:8081/tools/notify-user -H "Content-Type: application/json" -d "{\"message\":\"[FULL-DEPLOY] Failure: <brief description>. Check logs on production.\"}"'
```

## Phase 10 — OneDrive helper script

If `pp-pull` fails due to a stale token, run the committed helper script on production:

```bash
ssh <user>@<server> 'cd ~/friday && bash ./scripts/sync-onedrive.sh'
```

This syncs OneDrive non-interactively if a refresh token exists, or falls back to interactive OAuth. After sync, re-run Phase 6a and 6b.
