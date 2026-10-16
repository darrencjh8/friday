# Tasks: Portfolio Tracker MCP (Phase 1)

**Spec**: 022-portfolio-tracker-mcp
**Spec Version**: 1.1.0
**Status**: In Progress

---

## Phase 1: MCP Server in portfolio-tracker

### T001: Add MCP SDK + zod dependencies ✅

- **File**: `modules/portfolio-tracker/package.json`
- **Action**: Add `@modelcontextprotocol/sdk` and `zod` to `dependencies`
- **Related**: spec 021 expense-tracker `package.json` for version reference
- **Effort**: 5 min

### T002: Create OneDrive OAuth helper module ✅

- **File**: `modules/portfolio-tracker/src/onedrive_oauth.js` (NEW)
- **Action**: Two exported functions:
  - `getAuthUrl()` — constructs Microsoft OAuth URL from `ONEDRIVE_CLIENT_ID` env var
  - `exchangeCodeForToken(redirectUri)` — extracts `code` param from redirect URL, POSTs to Microsoft token endpoint, saves refresh token to `ONEDRIVE_REFRESH_TOKEN_PATH`
- **Detail**: Existing `src/onedrive.js` only handles token refresh + file operations. This new module adds the one-time OAuth setup path that's currently done manually via `authorize.sh`.
- **Effort**: 20 min

### T003: Create MCP server module ✅

- **File**: `modules/portfolio-tracker/src/mcp-server.js` (NEW)
- **Action**: Create MCP Streamable HTTP server following `modules/expense-tracker/src/mcp-server.js` pattern
- **Tools** (6 total):
  - `portfolio_sync` — calls `registry._computeSyncAll()` (deterministic, no LLM; includes IBKR flex pull)
  - `portfolio_onedrive_auth_url` — calls `getAuthUrl()` from `onedrive_oauth.js`
  - `portfolio_onedrive_auth_complete` — accepts `redirect_uri`, calls `exchangeCodeForToken()`
  - `portfolio_onedrive_status` — checks if refresh token file exists
  - `portfolio_onedrive_pull` — calls `pullFromOneDrive()` from `src/onedrive.js`
  - `portfolio_onedrive_push` — calls `pushToOneDrive()` from `src/onedrive.js`
- **Transport**: Streamable HTTP on `POST/GET/DELETE /mcp` (the earlier SSE `GET /sse` + `POST /messages` design was replaced during implementation)
- **Effort**: 1.5 h

### T004: Register MCP routes in index.js ✅

- **File**: `modules/portfolio-tracker/src/index.js`
- **Action**: Import `createMcpServer` from `./mcp-server.js`, call it before `app.listen()`
- **Placement**: After route registration, before `app.listen()` (matching expense-tracker pattern at L169-170)
- **Effort**: 10 min

### T005: Create IBKR Flex Web Service module ✅

- **File**: `modules/portfolio-tracker/src/ibkr_flex.js` (NEW)
- **Action**: Export `pullFlexXml()` function:
  - POSTs to IBKR Flex Web Service REST endpoint with `IBKR_FLEX_TOKEN` + `IBKR_FLEX_QUERY_ID`
  - Handles the two-step protocol (initial request → reference code → second request)
  - Returns `{ success, xml?, error? }`
  - Non-fatal on failure (sync continues without flex import)
- **Detail**: Replaces the removed `portfolio_ibkr_flex` MCP tool and IMAP-based IBKR flex processing. Deterministic REST call, no LLM.
- **TDD**: `PpClientImportIbkrTest` (7 tests) — import, dedup, account routing, fallback
- **Effort**: 25 min

### T006: Wire IBKR flex pull into _computeSyncAll() ✅

- **File**: `modules/portfolio-tracker/src/tools.js`
- **Action**: In `_computeSyncAll()`, after OneDrive pull and before AB balance sync:
  1. Call `pullFlexXml()` from `src/ibkr_flex.js`
  2. If XML returned, base64-encode and call `ppBridge.importIbkr(xmlB64)`
  3. Include `flex_pull` and `flex_import` in sync return value
- **Detail**: Flex pull + import are non-critical — if they fail, sync continues with balance sync + taxonomy
- **TDD**: `tools-extended.test.js` — 3 tests (pullFlexXml called, skip on failure, skip when not configured)
- **Effort**: 20 min

### T007: Add IBKR flex env vars to config ✅

- **File**: `modules/portfolio-tracker/src/config.js`
- **Action**: Added `ibkrFlexToken` and `ibkrFlexQueryId` from `IBKR_FLEX_TOKEN` / `IBKR_FLEX_QUERY_ID` env vars
- **TDD**: `config.test.js` — 2 tests (loads from env, defaults to empty)
- **Effort**: 5 min

### T007a: Remove internal cron — managed by Hermes ✅

- **Action**: Removed `ppSyncAllCron` / `PP_SYNC_ALL_CRON` from config.js, tests, and .env.example. Cron registered in `modules/hermes/config.yaml` (see T010 in Phase 2).
- **Effort**: 5 min

### T008: Local MCP smoke test ✅

- **Action**: Verified syntax — `createMcpServer` wired in index.js, `POST/GET/DELETE /mcp` defined in mcp-server.js. Full runtime test in Docker container.
- **Effort**: 15 min

### T008a: Cleanup dead/unnecessary env vars ✅

- **Action**: Resolved by removing the dead configuration instead of documenting it:
  - `LOG_LEVEL`, `BALANCE_SYNC_MODEL` — parsed into `Config` but never consumed. Removed from `src/config.js` and their tests; they were never in `.env.example`.
  - `AB_EMERGENCY_PRIMARY_CATEGORY`, `AB_EMERGENCY_SECONDARY_CATEGORY`, `AB_WARCHEST_CATEGORY` — parsed into `Config` but never consumed (balance amounts come from `sgd/myr.*_total`). Removed from `src/config.js`, from `.env.example`, and from their tests.
- **Detail**: `DEDUP_DB_PATH` and `MAPPINGS_PATH` are kept — they are legitimate overrides even though they match the defaults. `USER_NAME`, `SYSTEM_PROMPT_EXTRA`, `IBKR_FLEX_*` and the `PP_*_ACCOUNT` vars are actively used.
- **Tracks**: issues #211, #217, #261 (C-3, C-4)
- **Effort**: 10 min

---

## Phase 2: Hermes Configuration

### T009: Add portfolio-tracker to Hermes MCP servers ✅

- **File**: `modules/hermes/config.yaml`
- **Action**: Added under `mcp_servers:`:
  ```yaml
  portfolio-tracker:
      url: http://portfolio-tracker:8081/mcp
      tools:
          exclude: []
      supports_parallel_tool_calls: false
  ```
  The `transport: sse` key shown in the original plan is not used — the server is Streamable HTTP at `/mcp`.
- **Effort**: 5 min

### T010: Add Hermes cron for portfolio_sync ✅

- **File**: `modules/hermes/50-seed-defaults`
- **Action**: Seeded `portfolio-daily-sync` cron job (idempotent, scheduled daily at 10 AM) in `/opt/data/cron/jobs.json` alongside existing `memory-backup` cron
- **Detail**: Calls `portfolio_sync` MCP tool — pulls IBKR flex trades, syncs AB balances, exports taxonomies
- **Effort**: 15 min

### T011: Add Hermes Telegram commands ✅

- **Action**: Auto-handled by Hermes MCP tool discovery. Once portfolio-tracker connects, Telegram users can type:
  - `/sync` → Hermes calls `portfolio_sync`
  - `/onedrive setup` → `portfolio_onedrive_auth_url` + `auth_complete`
  - `/onedrive status` → `portfolio_onedrive_status`
  - `/onedrive pull` → `portfolio_onedrive_pull`
  - `/onedrive push` → `portfolio_onedrive_push`
- **Effort**: 5 min

---

## Phase 3: Validation & Deploy

### T012: Rebuild and deploy portfolio-tracker 🔲

- **Action**: 
  1. `cd modules/portfolio-tracker && npm install` (adds MCP SDK)
  2. `docker compose build portfolio-tracker`
  3. `docker compose up -d portfolio-tracker`
- **Effort**: 10 min

### T013: Verify MCP discovery in Hermes 🔲

- **Action**: Check Hermes logs for MCP server connection/discovery messages
- **Expected**: All 6 `mcp_portfolio_tracker_*` tools appear as available
- **Effort**: 10 min

### T014: End-to-end test — portfolio_sync via Hermes 🔲

- **Action**: Trigger `portfolio_sync` via Hermes (Telegram `/sync` or direct tool call)
- **Expected**: OneDrive pull → IBKR flex pull → Java CLI import → AB sync → OneDrive push → taxonomy export completes, result returned
- **Effort**: 15 min

### T015: End-to-end test — OneDrive OAuth flow via Hermes 🔲

- **Action**: Simulate `/onedrive setup` flow:
  1. Hermes calls `portfolio_onedrive_auth_url` → gets URL
  2. Hermes displays URL (simulated)
  3. Hermes calls `portfolio_onedrive_auth_complete({redirect_uri})` with a valid test code
  4. Verify refresh token saved to disk
  5. Hermes calls `portfolio_onedrive_status` → `{ authorized: true }`
- **Note**: Full E2E requires real Microsoft OAuth (manual browser step). Unit test the token exchange with a mock.
- **Effort**: 20 min

---

## Summary

| Phase | Tasks | Total Effort |
|-------|-------|-------------|
| 1 — MCP Server | T001-T008 | 3h 10m |
| 2 — Hermes Config | T009-T011 | 50m |
| 3 — Validation | T012-T015 | 55m |
| **Total** | **15 tasks** | **~4h 55m** |

## Tool Count

| Group | Tools | New Code |
|---|---|---|
| Sync | `portfolio_sync` | Extended `_computeSyncAll()` with IBKR flex pull |
| OneDrive Auth | `portfolio_onedrive_auth_url`, `portfolio_onedrive_auth_complete`, `portfolio_onedrive_status` | New `src/onedrive_oauth.js` (~40 LOC) |
| OneDrive IO | `portfolio_onedrive_pull`, `portfolio_onedrive_push` | Thin MCP wrappers over existing `src/onedrive.js` |
| IBKR Flex | Internal (not exposed as MCP tool) | New `src/ibkr_flex.js` (~50 LOC) |
| **Total** | **6 MCP tools** | **~210 LOC new code** |
