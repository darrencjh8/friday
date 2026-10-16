# Portfolio Tracker

LLM-powered agent that synchronizes investment data across Portfolio Performance, IBKR, Actual Budget, and Google Sheets. It runs as a Node.js/ESM service inside the `modules/docker-compose.yml` stack and is driven by Hermes Agent.

## Architecture

```
Hermes Agent  (Telegram, Slack, cron, IMAP)
        │                                    │
        │ MCP — Streamable HTTP              │ REST
        ▼                                    ▼
  POST/GET/DELETE /mcp                 /tools/*  (22 endpoints)
        └────────────────┬───────────────────┘
                         ▼
        Portfolio Tracker (Node.js, port 8081)
          ├─ LLM orchestrator (router auto-thinking via Responses API, DeepSeek fallback) — PDF trade confirmations only
          ├─ Java CLI bridge → pp-cli.jar → Portfolio Performance XML
          ├─ OneDrive (Microsoft Graph OAuth) pull/push
          ├─ IBKR Flex Web Service
          └─ Actual Budget API / Google Sheets
```

Hermes registers the module in `modules/hermes/config.yaml` under `mcp_servers:` as `http://portfolio-tracker:8081/mcp`. The Streamable HTTP transport is created per session in `src/mcp-server.js` and mounted in `src/index.js`; REST `/tools/*` and the IMAP handler are preserved alongside it.

## Prerequisites

- Node.js 22+ (ESM project — `"type": "module"` in `package.json`; the image uses `node:22-slim`)
- Java 17+ JRE (`pp-cli` targets Java 17 bytecode; the Docker image copies Temurin 21)
- Maven (to build `pp-cli`)
- Tesseract OCR + Poppler + qpdf (PDF processing; installed in the Docker image)
- Portfolio Performance 0.84.1 model JAR (vendored at `pp-cli/lib/`, not on Maven Central)
- DeepSeek API key (fallback LLM for PDF trade confirmations) and, for the primary route, the codex-router `LLM_BASE_URL` / `LLM_MODEL` (default `auto-thinking`) / `LLM_API_KEY` / `LLM_REASONING_EFFORT`. The router serves `auto-thinking` on the Responses API only; DeepSeek stays on Chat Completions.
- Google Cloud service account (Sheets)
- OneDrive OAuth client ID (Microsoft Graph)

Telegram/Slack bot tokens are configured on Hermes Agent, not on this module.

## Setup

### 1. Build the Java CLI

The Portfolio Performance model JAR is not on Maven Central. It is vendored at `pp-cli/lib/name.abuchen.portfolio-0.84.1.jar`; install it into local Maven, then build the CLI:

```bash
cd modules/portfolio-tracker/pp-cli
mvn install:install-file \
  -Dfile=lib/name.abuchen.portfolio-0.84.1.jar \
  -DpomFile=lib/name.abuchen.portfolio-0.84.1.pom \
  -DgroupId=name.abuchen.portfolio \
  -DartifactId=name.abuchen.portfolio \
  -Dversion=0.84.1 -Dpackaging=jar
mvn clean package
```

This produces `pp-cli/target/pp-cli.jar` (Maven `finalName` is `pp-cli`). `modules/build.sh` runs exactly this before building the portfolio-tracker image, so a manual build is only needed outside Docker/CI.

### 2. Configure Environment

```bash
cp .env.example .env
```

`guardEnv()` in `src/index.js` refuses to start when any of these are unset:

`DEEPSEEK_API_KEY`, `ACTUAL_BUDGET_URL`, `ACTUAL_BUDGET_PASSWORD`, `ACTUAL_PRIMARY_BUDGET_FILE`, `ACTUAL_SECONDARY_BUDGET_FILE`, `ONEDRIVE_CLIENT_ID`, `IBKR_FLEX_TOKEN`, `IBKR_FLEX_QUERY_ID`, `IBKR_PP_SGD_ACCOUNT`, `IBKR_PP_USD_ACCOUNT`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEET_ID`.

Other variables from `.env.example`:

- Balance-sync account UUIDs: `PP_EMERGENCY_PRIMARY_ACCOUNT`, `PP_EMERGENCY_SECONDARY_ACCOUNT`, `PP_WARCHEST_PRIMARY_ACCOUNT`
- `PP_XML_PATH` — default `/data/portfolio.xml`; compose sets `/data/onedrive/Portfolio/Portfolio.portfolio`
- `IMAP_HOST`, `IMAP_USERNAME`, `IMAP_PASSWORD` — PDF trade confirmations (leave empty to disable)
- `TAXONOMY_NAMES`, `TAXONOMY_SHEET_MAPPING`
- `IBKR_PP_PORTFOLIO_ACCOUNT` (optional routing account)
- `PP_PASSWORD` (encrypted PP files), `PORTFOLIO_MEMORY_PATH`, `TRANSFORMERS_CACHE`

### 3. Install Dependencies

```bash
npm install --production
```

### 4. Run

```bash
node src/index.js
```

Listens on `PORT` (default `8081`). MCP is served at `/mcp`, REST tool endpoints at `/tools/*`, and `/health` for the health check.

Or via Docker:

```bash
docker build -f docker/Dockerfile -t portfolio-tracker .
docker run -v $(pwd)/.env:/app/.env:ro \
           -v /path/to/portfolio.xml:/data/portfolio.xml \
           -v /path/to/google-service-account.json:/app/config/google-service-account.json \
           -p 8081:8081 \
           portfolio-tracker
```

OneDrive sync is handled by `pp-pull` and `pp-push` tools (Microsoft Graph API via `src/onedrive.js`), not a separate `onedrive-sync` container. These tools no longer require the Java bridge — the bridge lazy-initializes when the XML file is first downloaded.

## Telegram Commands

These commands are delivered by Hermes Agent, which calls this module's MCP tools; the module itself has no Telegram integration.

| Command | Action |
|---|---|
| `/ibkr` | Prompt to send IBKR flex query XML |
| `/sync` | Trigger Actual Budget → PP balance sync with auto OneDrive pull+push |
| `/sheet` | Trigger taxonomy → Google Sheets export |
| `/status` | Show recent activity |
| `/help` | Show commands |

PDF trade confirmations arrive by IMAP or Telegram upload. IBKR flex data is auto-pulled from the Flex Web Service during sync (`src/ibkr_flex.js`); a manual upload is a fallback only (`src/prompts.js`).

<!-- TODO(verify): confirm the live Hermes command set; module code exposes MCP tools and REST endpoints, not Telegram handlers. -->

## How It Works

1. **Inbound events** arrive via Hermes Agent (Telegram/Slack) or IMAP email
2. **LLM classifies** intent and extracts structured data via deterministic tools (OCR, XML parsing)
3. **Tools fetch live context** from PP (accounts, securities) and Actual Budget
4. **LLM matches** securities by ISIN/ticker, accounts by broker/currency
5. **Confirmation** is requested for multi-trade imports
6. **Java CLI** safely writes transactions to PP XML using PP's own model classes
7. **Memory** learns successful matches for future accuracy

## Testing

```bash
npx vitest run     # or: npm test
```

The `package.json` test script is `vitest run`. The last run of `npx vitest run` in this worktree printed:

```
Test Files  22 passed | 1 skipped (23)
     Tests  404 passed | 3 skipped (407)
```

Java CLI tests (from `modules/portfolio-tracker/pp-cli`):

```bash
mvn test
```

`maven-surefire-plugin` in `pp-cli/pom.xml` excludes `PpClientUpdateBalanceTest`, `PpClientUpdateBalanceEdgeTest`, and `PpClientImportIbkrTest` due to a JAR signing conflict; the pom documents running those manually against the shaded `pp-cli.jar`.

## Feature Specifications

There is no `.speckit/` directory. Specifications live under `specs/` with numbered directories. The portfolio-relevant ones:

| Spec directory | Real status |
|---|---|
| `specs/003-portfolio-tracker/` | MCP server implemented. `src/mcp-server.js` implements the Streamable HTTP transport (stateful, per-session), registered at `POST/GET/DELETE /mcp` in `src/index.js`; `src/ibkr_flex.js` and `src/onedrive_oauth.js` are present. The doc headers lag: `spec.md` still reads `Status: Specified` and `tasks.md` `Status: In Progress`. |
| `specs/006-portfolio-cpf-sync/` | Specified, not implemented. `spec.md` reads `Status: NOT YET IMPLEMENTED`; no CPF parser exists in `src/`. |
| `specs/008-portfolio-poems-sync/` | Specified, not implemented. `spec.md` reads `Status: NOT YET IMPLEMENTED`; no POEMS statement parser exists in `src/` (POEMS appears only as an example string in tool descriptions). |

## Balance Formula

Balance sync formula matches PP official UI: uses `isDebit`/`isCredit` semantics and excludes portfolio accounts from double-counting.
