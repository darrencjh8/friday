# Code Issues — Status After Dead-Code Removal

The original docs-only phase (#262) recorded the code issues below without touching code. The follow-up docs + stale-code-removal pass then resolved the dead-config and dead-code items and removed them from the modules concerned. This file is the current status of every item.

**Source of truth is the code.** When this table and the code disagree, the code wins — update this table.

## Portfolio-tracker (`modules/portfolio-tracker/src`)

| Ref | Location | Issue | Status | Detail |
|-----|----------|-------|--------|--------|
| C-1 | `tools.js` — `ToolRegistry` constructor (`abClient` param, `this._abClient`) | #158 | **Resolved — dead `abClient` plumbing removed (#261)** | `abClient` is accepted by the constructor, stored as `this._abClient`, and never read. Every call site passes `null` (only `index.js` passes the `factsMemory` argument after it). Removing the parameter changes positional arguments, so it must be done together with all callers instead of as a superficial delete. Remove the field and fix every `new ToolRegistry(...)` call site, OR build the AB-write path if PP→AB import is intended. Resolved in #261: the dead `abClient` parameter and `this._abClient` field were removed and every `new ToolRegistry(...)` call site updated so `factsMemory` is the 5th parameter. The Actual Budget integration itself is live and untouched. |
| C-2 | `email_handler.js` — `classifyEmail()` | #216 | **Resolved — removed** | Function was exported, tested, and had zero production callers; `classify.js` deliberately routes every Trades-folder email to the orchestrator with no LLM classification. Removed the function, its test block, its import in `tests/email-handler.test.js`, and the now-unnecessary mock entry in `tests/tools_memory.test.js`. |
| C-3 | `config.js` — `logLevel`, `balanceSyncModel` | #217 | **Resolved — removed** | Both were read from `LOG_LEVEL` / `BALANCE_SYNC_MODEL` and never consumed. Removed the assignments and every test assertion. The env vars were never in `.env.example`. |
| C-4 | `config.js` — `abEmergencyPrimaryCategory`, `abEmergencySecondaryCategory`, `abWarchestCategory` | #211 | **Resolved — removed** | Category config was set from `AB_*_CATEGORY` env vars but never consumed by the sync logic (balance amounts come from `sgd/myr.*_total`). Removed the assignments, the `.env.example` block, and every test assertion. |
| C-5 | `index.js` — MCP transport comment | #220 | **Resolved — already fixed** | Comment now reads `// Register MCP Streamable HTTP transport (POST/GET/DELETE /mcp)`, matching `createMcpServer()`. |
| C-6 | `index.js` `guardEnv()` vs `tools.js` `_exportTaxonomiesToSheet()` | #218 | **Resolved — docs say required, guard unchanged (no #261 change)** | `GOOGLE_SERVICE_ACCOUNT_JSON` / `GOOGLE_SHEET_ID` still cause `process.exit(1)` at startup even though the runtime export path skips gracefully. Docs now describe them as required, matching the running code. | Make the guard conditional on taxonomy config, OR keep as required and leave docs as-is. **No #261 change: the docs already required these vars; nothing was edited.** |
| C-7 | `config.js` — `REQUIRED_ENV_VARS` | #229 | **Open — deferred** | `REQUIRED_ENV_VARS` still omits `ACTUAL_SECONDARY_BUDGET_FILE`, which `index.js guardEnv()` does require. Defense-in-depth gap only. | Add `ACTUAL_SECONDARY_BUDGET_FILE` to `REQUIRED_ENV_VARS`. |
| C-8 | `prompts.js` — system prompt + few-shot examples | #213, #228 | **Partially resolved (#261) — manual path scoped, not removed** | Prompt still describes manual IBKR ingestion via email/Telegram while `pp-sync-all` auto-pulls via the IBKR Flex Web Service (`ibkr_flex.js`). Not a hard contradiction — the manual paths still exist — but it trains a stale-leaning workflow. Resolved in #261: the manual/fallback scoping is applied to rules 2 and 6, and rule 2 is the one that names `pp-sync-all` for the automated path. The manual email/Telegram rules and few-shot examples remain intentionally. | Refresh prompt/examples toward the API-driven sync. |

## Expense-tracker

No dead-code issues identified that require a code decision. #232/#235/#236 are doc/spec-only (the keyword table never existed; the gateway plugin became an MCP tool). The 3-phase pipeline (`orchestrator.js`) is correct — only `SKILL.md` is stale.

The expense-tracker's `classifyEmail()` (`src/classify.js`) is a **different, live** function: it is awaited by `src/index.js` before dispatch and has its own test suite. Do not confuse it with the removed portfolio-tracker function of the same name.

## Doc-vs-doc reconciliation note (resolved in docs, no code change)

`GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_SHEET_ID` are documented as **required** to match the running `guardEnv()`. Flip C-6 if you would rather make them optional at startup. **No #261 change: the docs already said required; nothing was edited.**

## Operational note for the removals (C-2, C-3, C-4)

Removing those config fields and the helper function changes no runtime behaviour: the fields were only ever written, never read on any live path, and `classifyEmail()` had no callers. Setting `LOG_LEVEL`, `BALANCE_SYNC_MODEL`, `AB_EMERGENCY_PRIMARY_CATEGORY`, `AB_EMERGENCY_SECONDARY_CATEGORY`, or `AB_WARCHEST_CATEGORY` in a deployed `.env` is now a no-op in the same way it always was — the values were already ignored.
