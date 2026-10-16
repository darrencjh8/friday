# Spec Drift Audit

**Status:** DOCS FIXED + PORTFOLIO DEAD-CODE/PROMPT FIXES (see `code-notes.md`)
**Branch:** `usr/darren/spec-drift-audit`
**Worktree:** `../friday-spec-drift`
**Source of truth:** the **code**. Specs/docs are corrected to match code, unless a row is flagged as a *code bug* needing a separate decision.

This document scaffolds every reported GitHub spec-drift issue (33 total) plus additional drift found during the audit. Each row was verified by reading the actual code at the commit `f22135d`.

Verdict legend:
- **CONFIRMED** — drift exists as reported; fix the doc.
- **CONFIRMED+** — drift exists and is *worse/different* than reported (counts moved since the issue was filed).
- **PARTIAL** — claim is partly right; code has changed since filing or the wording is imprecise.
- **OUTDATED-REF** — the cited spec/file path no longer exists in the repo.
- **CODE-BUG** — code is the source of truth but the behavior looks wrong; needs a human decision, not just a doc edit.

---

## A. Portfolio-tracker (module `modules/portfolio-tracker`)

### Issues citing `skills/productivity/portfolio-tracker/SKILL.md` (#152–158)

> **Important:** There is **no** `portfolio-tracker/SKILL.md` in this repo. Only `modules/hermes/skills/{image-gen,expense-tracker}/SKILL.md` exist. These issues were filed against a SKILL.md that lives in the deployed container, not the repo. The *equivalent* canonical doc in-repo is `specs/003-portfolio-tracker/{spec.md,CONTEXT.md}` and `README.md`. Fixes target those.

| # | Issue | Verdict | Code evidence | Correct value | Fix target |
|---|-------|---------|---------------|---------------|------------|
| 152 | D1: "Import into Actual Budget" but code reads FROM AB, writes TO PP | **CONFIRMED** | `tools.js:712-811` fetches `…/budget-12m` then `ppBridge.updateBalance()` for 3 PP accounts. No AB write anywhere. | Data flow is **AB → PP** (AB is a source). | spec.md/CONTEXT.md wording |
| 153 | D2: doc lists 5 pipeline steps, code has 6 (SGD status) | **CONFIRMED** | `tools.js:_computeSyncAll` steps: pull → flex → AB→PP → push → taxonomy → **SGD status** (`_computeStatusSgd` L849, `_fetchLiveRates`). | 6 steps incl. SGD status | doc (no repo SKILL.md) |
| 154 | D3: token path `onedrive_refresh_token` vs `onedrive/refresh_token` | **CONFIRMED** | `config.js:120`, `mcp-server.js:113/162` default `"/app/config/onedrive/refresh_token"`. | `/app/config/onedrive/refresh_token` | doc (no repo SKILL.md) |
| 156 | A1: 19 REST endpoints undocumented in SKILL.md | **CONFIRMED+** | `index.js:126-162` registers **20** `/tools/*` routes. | 20 REST routes | spec.md REST table (already lists 20) |
| 157 | A2: 11 critical startup env vars undocumented | **CONFIRMED** | `index.js:21-46 guardEnv()` lists 12 vars; spec.md:429 lists them. SKILL.md (container) omits. | 12 critical env vars | already in spec.md:429 |
| 158 | B1: AB↔PP direction; dead `_abClient` | **CONFIRMED (code reality) / CODE-BUG (intent)** | `this._abClient = abClient` was always `null` and never used (pre-#261 constructor around `tools.js:457`; line refs previously cited here were stale). | Code does AB→PP; `_abClient` is dead. | Decision: remove dead field OR build AB-write. Doc → AB→PP. **Resolved (#261, ff9347e): dead `abClient` plumbing removed.** |

### Issues #210–226 (cite portfolio source files)

| # | Issue | Verdict | Code evidence | Correct value | Fix target |
|---|-------|---------|---------------|---------------|------------|
| 210 | #3 Hardcoded account UUIDs ignore env vars | **PARTIAL** | `tools.js:757-781` now uses `this._config.ppEmergency*Account \|\| "<uuid>"` — env vars **are** honored; UUID is only a fallback. | Env vars work; hardcoded UUID = fallback. | spec.md:345 wording; README env docs |
| 211 | #4 AB category env vars read but never consumed | **RESOLVED — removed** | Was: `config.js` set `abEmergencyPrimaryCategory`/`abEmergencySecondaryCategory`/`abWarchestCategory` from `AB_*_CATEGORY` with zero consumers (the issue's `ACTUAL_CATEGORY_*` names were stale). The assignments, the `.env.example` block, and all test assertions were removed. | Dead config, now gone | Done — verify with `grep -r "AB_EMERGENCY\|AB_WARCHEST"` |
| 212 | #5 MCP transport: CONTEXT.md SSE vs spec Streamable HTTP | **CONFIRMED** | `mcp-server.js:1-8,353,406-411` = `StreamableHTTPServerTransport`. | Streamable HTTP | CONTEXT.md:26,77 |
| 213 | #6 Few-shot examples show old IBKR email workflow | **PARTIAL** | `prompts.js:152-221` examples parse pasted flex/PDF text (Telegram), not the auto IBKR-API pull (`ibkr_flex.js`). | Sync auto-pulls via IBKR Flex API | prompts.js (code) — see #228 |
| 214 | #7 `portfolio_onedrive_status` token_path missing | **CONFIRMED** | `mcp-server.js:156-216` registers no params and returns `{authorized, client_id, …}` — **no** `token_path`. spec.md:277 documents `token_path`. | No `token_path` in/out | spec.md:277 output shape |
| 215 | #8 `_computeSyncAll()` returns undocumented fields | **CONFIRMED** | `tools.js:856-866` returns 9 fields (`sync_targets, summary, pull, flex_pull, flex_import, push, taxonomy_export, taxonomy_data, portfolio_status`). | Document 9-field shape | spec.md:269 area |
| 216 | #9 Dead code `classifyEmail()` | **RESOLVED — removed** | Was defined in `email_handler.js` with zero callers; `classify.js` routes every Trades-folder email straight to the orchestrator. Function, its test block, its test import, and its mock entry were removed. The expense-tracker's live `classifyEmail()` in `src/classify.js` is unrelated and untouched. | Dead code, now gone | Done — verify with `grep -rn "classifyEmail" modules/portfolio-tracker` |
| 217 | #10 Dead config `BALANCE_SYNC_MODEL`, `LOG_LEVEL` | **RESOLVED — removed** | `config.js` set `logLevel`/`balanceSyncModel` with no consumers; neither var was in `.env.example`. Assignments and all test assertions removed. | Dead config, now gone | Done — verify with `grep -rn "balanceSyncModel\|logLevel" modules/portfolio-tracker` |
| 218 | #16 `GOOGLE_SERVICE_ACCOUNT_JSON` fail-fast vs README "optional" | **RESOLVED — docs already correct; no code change** | `index.js:33` guardEnv exits if missing; `tools.js:923-929` skips gracefully; the docs already list it as required (`modules/portfolio-tracker/README.md:65`, `specs/003-portfolio-tracker/spec.md:453`). The previously cited `README.md:45` is a bash-block line and never said "(optional)". | Currently mandatory at startup | Resolved — the docs already required these vars; no README/spec/code change was needed or made (the earlier "make conditional OR fix docs" action was unnecessary). |
| 219 | #17 AB budget response shape undocumented | **CONFIRMED** | `tools.js:763,771,779` read `sgd.emergency_total`, `myr.emergency_total`, `sgd.investment_total` (`\|\|0` fallback). | Document response shape | spec.md:345 area |
| 220 | #11 Stale "SSE transport" comment in index.js | **RESOLVED — already fixed** | Comment now reads `// Register MCP Streamable HTTP transport (POST/GET/DELETE /mcp)`, matching `createMcpServer()` in `mcp-server.js`. | Streamable HTTP at `/mcp` | Done |
| 221 | #12 REST count: 19 (diagram) vs 20 (table) | **CONFIRMED** | Code = **20** routes (`index.js:126-162`). Table (spec.md:387) correct; diagram (spec.md:38, also L240) wrong. | 20 | spec.md:38, :240 |
| 222 | #13 plan.md hardcoded `IBKR_GET_URL` vs dynamic | **CONFIRMED** | `ibkr_flex.js:13,54-55` builds URL via `URLSearchParams` on `IBKR_SEND_URL`; no static GET url. | Dynamic URL | plan.md:155 |
| 223 | #14 Java 17 (design.md) vs 21 (Dockerfile) | **CONFIRMED** | `docker/Dockerfile:3-4` `eclipse-temurin:21-jre`. `design.md:85,455` say Java 17. | Java 21 | design.md:85,455 |
| 224 | #15 Unused Dockerfile deps (curl, gnupg, ca-certificates) | **NOT CONFIRMED** | `docker/Dockerfile:8-13` installs `tesseract-ocr, poppler-utils, python3, make, gcc` — **none** of curl/gnupg/ca-certificates. Cited deps not present. | No change needed | none (issue stale) |
| 225 | #18 `budget_id` query param missing in spec URL | **CONFIRMED** | `tools.js:719` `…/budget-12m?budget_id=${encodeURIComponent(budgetName)}`. spec.md:345 omits it. | `?budget_id=<name>` | spec.md:345 |
| 226 | #19 Cron 3 AM SGT (spec) vs 10 AM KL (design.md) | **CONFIRMED+** | **Source of truth:** `modules/hermes/50-seed-defaults:110` seeds `portfolio-daily-sync` with `{"kind":"cron","expr":"0 12 * * *"}` (noon, container time). Both `design.md:433` ("10 AM KL") and `spec.md:26,87,214` ("3 AM SGT") are stale. (commit 54a6245 moved 10am→12pm.) | `0 12 * * *` per 50-seed-defaults | design.md:433, spec.md:26/87/214/plan.md:19 |
| 229 | #2 Config omits `ACTUAL_SECONDARY_BUDGET_FILE` validation | **PARTIAL** | `config.js:8-13` REQUIRED has 4 vars (no secondary); BUT `index.js:27` guardEnv **does** require it at startup. | Guarded at startup via index.js | Optional: add to config.js for defense-in-depth |

### Additional portfolio drift found (unreported)

| ID | Drift | Evidence | Fix target |
|----|-------|----------|------------|
| P-N1 | spec.md calls MCP a "thin **SSE** wrapper" while same doc later says Streamable HTTP | spec.md:15 vs :59,:376,:378 | spec.md:15 |
| P-N2 | MCP tool count drift: docs say **6** tools; code registers **10** (`portfolio_insert_transaction`, `portfolio_get_all`, `portfolio_query_security`, `portfolio_taxonomy` added) | `mcp-server.js:106-333`; CONTEXT.md:26 | spec.md/CONTEXT.md |
| P-N3 | `README.md` was Python-era ("Install Python Dependencies", `pip install -r requirements.txt`, `python -m src.main`) but module is Node.js | README.md:49-58 | README.md (fixed) |

---

## B. Expense-tracker (module `modules/expense-tracker`)

| # | Issue | Verdict | Code evidence | Correct value | Fix target |
|---|-------|---------|---------------|---------------|------------|
| 227 | CRITICAL SKILL.md 4-phase vs code 3-phase | **CONFIRMED** | `orchestrator.js:1-8` "3-phase pipeline" (LLM Analysis / Resolution / Execute); no V2/V3 gates. SKILL.md:5-17 describes 4-phase + V2/V3. | 3-phase | SKILL.md:5-17 |
| 228 | #1 CRITICAL LLM prompt says IBKR-via-email vs API-driven | **PARTIAL/CODE** | This is the **portfolio** prompt (`portfolio-tracker/prompts.js`), not expense. Prompt L46-48 lists email/Telegram as IBKR sources; sync auto-pulls via IBKR Flex API. | Sync is API-driven | portfolio prompts.js |
| 230 | HIGH MCP tool count 19 vs 17 documented | **CONFIRMED+** | `mcp-server.js` registers **22** `server.tool()` (incl. `list_inbox_emails`, `read_inbox_email`, `extract_inbox_pdf`, `compact_facts`, `cleanup_facts`). | 22 MCP tools | parent index / design.md |
| 231 | HIGH REST endpoint count 25 vs 16 in design.md | **CONFIRMED+** | `index.js:127-154` `toolNames` = **26** (incl. `extract_inbox_pdf`). design.md:87 says "16 HTTP POST endpoints" + Python filename `tools_api.py`. | 26 REST endpoints | design.md:87 |
| 232 | MED keyword table (Spec 015 FR-005) never created | **CONFIRMED** | `src/keywords.js` does **not** exist. `tools.js:1356` resolve chain = memory → web → `"Misc"`; no keyword step. | No keyword step (per Spec 021) | spec 015 FR-005 |
| 233 | LOW Spec 002 plan.md Python vs JS code | **CONFIRMED** | `plan.md:14-20` Python 3.12/aioimaplib/pytesseract/main.py. `spec.md:16` "Python host provides 16 tools". Code is Node.js (`src/index.js`, imapflow, pdftotext). | Node.js | spec 002 spec.md/plan.md |
| 234 | LOW design.md `data/mappings.json` migrated to MEMORY.md | **CONFIRMED** | design.md:173 documents `data/mappings.json`; code migrates to MEMORY.md (`memory.js`, `index.js`). | MEMORY.md | design.md:173 |
| 235 | LOW Spec 015 gateway plugin `budget_resolve_merchant` → MCP tool | **CONFIRMED** | Exposed as MCP `resolve_merchant` (`mcp-server.js`); no `budget_*` gateway plugin. | MCP `resolve_merchant` | spec 015 FR-009 |
| 236 | LOW Spec 020 keyword chain superseded by Spec 021 | **CONFIRMED** | Spec 020 already marked SUPERSEDED; code = memory→web→fallback (`tools.js:1356`). | Historical only | spec 020 banner (no action / annotate) |

### Additional expense drift found (unreported)

| ID | Drift | Evidence | Fix target |
|----|-------|----------|------------|
| E-N1 | design.md describes a **Python** layout (`tools_api.py`, line-count annotations) but module is JS | expense docs/design.md:87 etc. | design.md |
| E-N2 | spec 002 spec.md "16 deterministic tools" count stale (REST 26 / MCP 22) | spec.md:16 | spec 002 |
| E-N3 | Root `design.md` §4 still describes the legacy **OpenClaw gateway** model — "typed plugin tools (`budget_` prefix)" (L211) and "21 typed plugin tools" (L223) — superseded by Hermes MCP (#235). Larger architectural rewrite, not just a count. | design.md:211,223 | design.md (flagged, deferred) |

---

## C. Root `design.md`

| Line | Drift | Correct value |
|------|-------|---------------|
| 85, 455 | "Java 17" | Java 21 (`portfolio-tracker/docker/Dockerfile`) |
| 433 | "Daily 10 AM KL" | 3 AM SGT (per specs) — verify against deployed cron (moved to 12pm, commit 54a6245) |
| 322, 457, 476 | Streamable HTTP | ✅ correct (no change) |

---

## D. Consolidation (see `consolidation-plan.md`)

The expense-tracker baseline is currently spread across spec 002, 015, 020, 021, `modules/expense-tracker/docs/design.md`, and the Hermes SKILL.md — several contradicting the code. Plan consolidates the **current** baseline into `specs/002-expense-tracking/` as the single source future agents consume, with 015/020/021 retained as historical deltas pointing to it.
