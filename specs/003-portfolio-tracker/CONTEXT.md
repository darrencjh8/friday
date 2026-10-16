# Portfolio Tracker MCP — Phase 1 Context Dump

## What We're Building

Add MCP server to portfolio-tracker module. Phase 1 exposes **6 MCP tools** in 3 groups.
IBKR flex import is folded into `portfolio_sync` — pulled from IBKR Flex Web Service, not a standalone MCP tool.

## Files Already Changed

### Java CLI — pp-cli

**`pp-cli/src/main/java/name/abuchen/portfolio/cli/PpClient.java`**
- Added 6 imports (Extractor, Extractor.BuySellEntryItem, SecurityCache, Extractor.SecurityItem, Extractor.TransactionItem, IBFlexStatementExtractor)
- Added `importIbkr(File xmlFile)` method at end of class — uses PP's native IBFlexStatementExtractor (same as desktop UI)

**`pp-cli/src/main/java/name/abuchen/portfolio/cli/Main.java`**
- Added `import` command case: `result = ppc.importIbkr(new File(require(params, "ibkr-xml")));`

### Node.js — portfolio-tracker

**`src/onedrive_oauth.js`** (NEW)
- `getAuthUrl()` — constructs Microsoft OAuth URL from `ONEDRIVE_CLIENT_ID` env var
- `exchangeCodeForToken(redirectUri)` — exchanges auth code for refresh token, saves to disk

**`src/mcp-server.js`** (NEW)
- MCP Streamable HTTP server with 12 tools following expense-tracker pattern
- `POST/GET/DELETE /mcp` transport (StreamableHTTPServerTransport, per-session)

**`src/index.js`**
- Imported `createMcpServer`, called before `app.listen()`

**`src/java_bridge.js`**
- Added `importIbkr(xmlContentB64)` method — base64-decode → temp file → `java -jar pp-cli.jar import`

**`package.json`**
- Added `@modelcontextprotocol/sdk` ^1.9.0, `zod` ^3.24.0

### Spec files (specs/022-portfolio-tracker-mcp/)

**`spec.md`** — Full spec with mermaid diagrams, 8 user stories, tool reference table
**`plan.md`** — Architecture diagram, key decisions, MCP schemas, OneDrive OAuth flow
**`tasks.md`** — 14 tasks across 3 phases, ~4h 50m estimated

### Build & Test Commands

```bash
# Build Java CLI
cd modules/portfolio-tracker/pp-cli
mvn clean package -DskipTests

# Test import command
java -jar target/pp-cli.jar import \
  --file /path/to/Portfolio.portfolio \
  --ibkr-xml /path/to/ibkr-flex.xml
```

## 6 MCP Tools

| Group | Tool | Implementation |
|---|---|---|
| Sync | `portfolio_sync` | `_computeSyncAll()` extended with IBKR flex pull → import |
| OneDrive Auth | `portfolio_onedrive_auth_url` | `src/onedrive_oauth.js` — `getAuthUrl()` |
| OneDrive Auth | `portfolio_onedrive_auth_complete` | `src/onedrive_oauth.js` — `exchangeCodeForToken()` |
| OneDrive Auth | `portfolio_onedrive_status` | Checks `ONEDRIVE_REFRESH_TOKEN_PATH` file exists |
| OneDrive IO | `portfolio_onedrive_pull` | Thin wrapper over `pullFromOneDrive()` |
| OneDrive IO | `portfolio_onedrive_push` | Thin wrapper over `pushToOneDrive()` |

**Removed from v1.0.0:** `portfolio_ibkr_flex` standalone tool. IBKR flex is now pulled from IBKR Flex Web Service inside `portfolio_sync`.

## Key Architecture Decisions

1. **Email stays in portfolio-tracker** — Hermes does NOT handle portfolio email. IMAP IDLE on "Trades" folder is unchanged.
2. **IMAP no longer processes IBKR flex** — IBKR flex queries are pulled from IBKR Flex Web Service REST endpoint, not from email. IMAP IDLE handles PDF trade confirmations only.
3. **IBKR flex pull uses IBKR Flex Web Service** — New `src/ibkr_flex.js` module POSTs to IBKR's REST endpoint with token + query ID to fetch the latest flex XML. Deterministic, no LLM.
4. **IBKR import uses PP native extractor** — `IBFlexStatementExtractor` (same as PP desktop UI). New `import` command in Java CLI. Zero LLM involvement for IBKR.
5. **LLM orchestrator preserved** — stays for PDF trade confirmations only.
6. **MCP transport**: Streamable HTTP (same as expense-tracker pattern). SSE was rejected because it breaks on container restart (session mismatch); see `mcp-server.js` header.
7. **OneDrive OAuth via MCP** — New `src/onedrive_oauth.js` for interactive setup flow. No more SSH + `authorize.sh`.
8. **Cron coexistence**: Hermes cron + internal apscheduler both run. Sync is idempotent.

## Files Still To Create

- `modules/portfolio-tracker/src/ibkr_flex.js` — IBKR Flex Web Service pull (~50 LOC)

## Files Still To Modify

- `modules/portfolio-tracker/src/tools.js` — Add IBKR flex pull to `_computeSyncAll()` pipeline
- `modules/portfolio-tracker/src/config.js` — Add `IBKR_FLEX_TOKEN`, `IBKR_FLEX_QUERY_ID` env vars
- `modules/portfolio-tracker/src/mcp-server.js` — Remove `portfolio_ibkr_flex` tool (~15 LOC removed)
- `modules/hermes/config.yaml` — Add `portfolio-tracker` MCP server + cron

## Sync Pipeline (updated)

```
portfolio_sync():
  1. OneDrive pull          ← existing
  2. IBKR flex pull          ← NEW (src/ibkr_flex.js)
  3. Java CLI import         ← existing (pp-cli import command)
  4. AB balance sync         ← existing
  5. OneDrive push           ← existing
  6. Taxonomy export         ← existing
```

## Next Step

POC: test pp-cli `import` command's duplicate handling with a real PP portfolio file + IBKR flex XML.
