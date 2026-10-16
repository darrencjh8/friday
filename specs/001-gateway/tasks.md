# Tasks: Hermes Migration (expense-tracker)

**Input**: Design documents from `/specs/021-hermes-migration/`
**Prerequisites**: spec.md (required)
**Tests**: TDD — verify failure before fix, confirm pass after implementation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- All tasks include exact file paths

---

## Phase 1: Preparation (Local Dev)

**Purpose**: Hermes running locally, expense-tracker MCP adapter built, tested in isolated environment. **No production changes.**

- [ ] T001 Read Hermes quickstart: `https://hermes-agent.nousresearch.com/docs/getting-started/quickstart`
- [ ] T002 Install Hermes Agent locally (not production): `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`
- [ ] T003 Run `hermes setup --portal` to configure DeepSeek provider
- [ ] T004 Verify local chat works: `hermes chat` → send message, confirm DeepSeek response
- [ ] T005 Configure Telegram in `~/.hermes/.env` — set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`
- [ ] T006 Start gateway locally: `hermes gateway` → confirm Telegram DM works for hello message

---

## Phase 2: expense-tracker MCP Adapter (US2)

**Purpose**: Build the ~100-line MCP server wrapper in expense-tracker. All 13 AB tools exposed via MCP. Test against local Hermes.

**⚠️ CRITICAL**: No other work can proceed until expense-tracker exposes MCP tools.

- [ ] T007 [P] [US2] Add `@modelcontextprotocol/sdk` to `modules/expense-tracker/package.json` as devDependency
- [ ] T008 [P] [US2] Create `modules/expense-tracker/src/mcp-server.ts` — MCP server scaffold with `McpServer` instantiation
- [ ] T009 [US2] Implement MCP tool: `fetch_accounts` in `modules/expense-tracker/src/mcp-server.ts` — wraps existing `tools.js` handler, returns JSON
- [ ] T010 [US2] Verify T009 locally: start expense-tracker, connect MCP Inspector (`npx @modelcontextprotocol/inspector`), call `fetch_accounts`
- [ ] T011 [US2] Implement remaining MCP tools in `modules/expense-tracker/src/mcp-server.ts`:
  - `fetch_categories`, `fetch_payees`, `fetch_recent_transactions`
  - `insert_transaction`, `check_duplicate`, `reconcile_transaction`
  - `fetch_unreconciled`, `record_statement`, `check_statement_duplicate`
  - `fetch_statement_history`, `update_transaction`, `mark_email_read`
  - `extract_email_content`, `extract_pdf_text`
- [ ] T012 [US2] Update `modules/expense-tracker/src/index.js` — start MCP server (HTTP SSE on port 8080) instead of IMAP loop
- [ ] T013 [US2] Update `modules/expense-tracker/package.json` — remove `openai`, `@xenova/transformers`, `imapflow`, `mailparser` from dependencies
- [ ] T014 [US2] Verify all 15 MCP tools work: connect Hermes locally with MCP config pointing to `http://localhost:8080/mcp`, confirm tool discovery

**Checkpoint**: expense-tracker MCP server running, all 15 tools callable from Hermes. AB operations work.

---

## Phase 3: Hermes Docker Configuration (US1)

**Purpose**: Docker Compose config for Hermes container on the same network as expense-tracker + actual-api. Email channel configured.

- [ ] T015 [US1] Create `gateway/hermes/` directory for Hermes Docker config files
- [ ] T016 [P] [US1] Create `gateway/hermes/config.yaml` — DeepSeek + Gemini providers, MCP server pointing to `expense-tracker:8080/mcp`, delegation settings (`deepseek-flash` for thinker), cron enabled
- [ ] T017 [P] [US1] Create `gateway/hermes/.env` — `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `EMAIL_*` vars
- [ ] T018 [P] [US1] Create `gateway/hermes/SOUL.md` — agent personality: "an expense tracker assistant. Concise. Proactive about debugging."
- [ ] T019 [US1] Add Hermes service to `gateway/docker-compose.yml`:
  - Image: `nousresearch/hermes-agent:latest`
  - Ports: `8642:8642`
  - Volumes: `./hermes:/opt/data:ro` (config), `hermes_data:/opt/data/rw` (state), `/var/run/docker.sock:/var/run/docker.sock`
  - Networks: same Docker network as expense-tracker
  - Restart: unless-stopped
- [ ] T020 [US1] Update expense-tracker service in `gateway/docker-compose.yml` — remove `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` env vars (no longer needed)
- [ ] T021 [US1] Create `gateway/hermes/exec-approvals.json` — allowlist: `docker compose restart`, `docker ps`, `docker logs`; require-approval: `docker compose down`
- [ ] T022 [US1] Verify Hermes starts in Docker: `docker compose up -d hermes`, check logs for "Hermes Agent" banner, confirm Telegram DM still responds

**Checkpoint**: Hermes running in Docker. Telegram channel works. Email channel configured. Docker socket mounted.

---

## Phase 4: Memory Migration (US3)

**Purpose**: Migrate existing MEMORY.md facts to Hermes memory. Validate semantic search works for merchant recognition.

- [ ] T023 [US3] Locate current `MEMORY.md` — find the active file used by the running expense-tracker (check volume mount in docker-compose)
- [ ] T024 [US3] Write migration script `scripts/migrate-memory.sh`:
  - Read `MEMORY.md` → extract all `## Facts` entries
  - Format as Hermes-compatible memory entries (compact, information-dense)
  - Write to `~/.hermes/memories/MEMORY.md`
- [ ] T025 [US3] Run `scripts/migrate-memory.sh` locally — verify facts appear in Hermes memory
- [ ] T026 [US3] Test semantic memory: start Hermes locally, ask "what credit card ends with 1888?" → verify it returns Delta Extra from memory
- [ ] T027 [US3] Test memory self-learning: process a test email, verify Hermes auto-adds new facts to MEMORY.md
- [ ] T028 [US3] Save Hermes MEMORY.md + USER.md to `gateway/hermes/memories/` for Docker volume mount

**Checkpoint**: Memory migrated. Hermes knows all merchants, accounts, categories from old system.

---

## Phase 5: End-to-End Email Processing (US4)

**Purpose**: Full receipt → AB insertion flow working end-to-end with Hermes Email channel + expense-tracker MCP tools.

- [ ] T029 [US4] Configure Email channel in `gateway/hermes/.env` — `EMAIL_ADDRESS`, `EMAIL_PASSWORD`, `EMAIL_IMAP_HOST`, `EMAIL_SMTP_HOST`, `EMAIL_ALLOWED_USERS`
- [ ] T030 [US4] Start Hermes with Email channel: `docker compose up -d hermes` → verify `hermes gateway status` shows Email platform connected
- [ ] T031 [US4] Send test receipt email to burner inbox (from allowed sender)
- [ ] T032 [US4] Wait for Email poll (15s) → check Hermes logs for email receipt event
- [ ] T033 [US4] Verify Hermes calls expense-tracker MCP tools in correct sequence:
  1. `mcp_expense_tracker_extract_email_content`
  2. `mcp_expense_tracker_fetch_accounts` + `mcp_expense_tracker_fetch_categories`
  3. `mcp_expense_tracker_check_duplicate`
  4. `mcp_expense_tracker_insert_transaction`
  5. `mcp_expense_tracker_mark_email_read`
- [ ] T034 [US4] Verify transaction appears in Actual Budget with correct amount, merchant, account, category
- [ ] T035 [US4] Test duplicate prevention: send same receipt email again → verify dedup check catches it, no double insert
- [ ] T036 [US4] Test ambiguous email: send email from unknown merchant with unclear amount → verify Telegram notification sent, email left unread
- [ ] T037 [US4] Test statement email: send a monthly statement email → verify `record_statement` is called, reconciliation triggers

**Checkpoint**: Full email-to-AB pipeline works. Duplicates detected. Ambiguous emails notified. Statements reconciled.

---

## Phase 6: Self-Debugging Sub-Agent (US5)

**Purpose**: Thinker sub-agent can inspect Docker logs, health endpoints, and diagnose issues. Recommends fixes (does not auto-execute).

- [ ] T038 [US5] Create `gateway/hermes/AGENTS.md` — system prompt with debugging instructions:
  - How to spawn Thinker for debugging: `delegate_task` with `toolsets: ["terminal"]`
  - Docker commands available: `docker ps`, `docker logs`, `docker compose restart`
  - Health check endpoints: `expense-tracker:8080/health`, `actual-api:3000/health`
  - **CRITICAL**: Debugger investigates and recommends, never auto-executes fixes
- [ ] T039 [US5] Test debugger with healthy state: "debug expense-tracker" → Thinker checks Docker + health → reports "all systems operational"
- [ ] T040 [US5] Test debugger with simulated failure: `docker compose stop actual-api` → "debug expense-tracker" → Thinker identifies `actual-api` down → recommends restart
- [ ] T041 [US5] Test approval flow: Thinker recommends restart → user replies "yes" → Hermes runs `docker compose restart actual-api` → confirms health restored
- [ ] T042 [US5] Test approval gate denies dangerous ops: Thinker recommends `docker compose down` (outside allowlist) → Hermes asks for human approval on Telegram
- [ ] T043 [US5] Test debugger with expense-tracker specific issues: simulate MCP tool timeout → Thinker identifies latency, checks expense-tracker logs

**Checkpoint**: Self-debugging works. Thinker investigates safely. Dangerous actions gated behind approval.

---

## Phase 7: Daily Log Audit Cron (US6)

**Purpose**: Automated daily 3 AM cron job inspects logs, checks health, reports anomalies via Telegram.

- [ ] T044 [US6] Set up daily audit cron via Hermes chat:
  `/cron add "every day at 3am" "Inspect Hermes logs for errors in the past 24 hours, check Docker container health (docker ps), check expense-tracker health endpoint (curl expense-tracker:8080/health), check actual-api health (curl actual-api:3000/health). If all healthy, respond with [SILENT]. If issues found, describe each issue and recommend action. Deliver to telegram."`
- [ ] T045 [US6] Verify cron job created: `hermes cron list` shows the audit job
- [ ] T046 [US6] Manually trigger first run: `hermes cron run <job_id>` → verify report saved to `~/.hermes/cron/output/`
- [ ] T047 [US6] Verify `[SILENT]` behavior: with all services healthy, no Telegram message sent
- [ ] T048 [US6] Test anomaly detection: inject a fake error log → trigger cron → verify Telegram notification sent with error details
- [ ] T049 [US6] Verify cron runs in headless mode: `approvals.cron_mode: deny` in config (safe default)

**Checkpoint**: Daily auditor running. Silent when healthy. Alerting when issues detected.

---

## Phase 8: Production Deployment (US1)

**Purpose**: Deploy Hermes to production alongside existing OpenClaw. Parallel run for validation. Cutover when stable.

- [ ] T050 [US1] Backup production: `ssh darren@<prod-host> 'cd ~/friday && git pull && docker compose down'`
- [ ] T051 [US1] `scp -r gateway/hermes/ darren@<prod-host>:~/friday/gateway/hermes/`
- [ ] T052 [US1] `scp gateway/docker-compose.yml darren@<prod-host>:~/friday/gateway/docker-compose.yml`
- [ ] T053 [US1] Build & update expense-tracker with MCP: `scp` updated `modules/expense-tracker/` → `docker compose build expense-tracker`
- [ ] T054 [US1] Start Hermes on production: `ssh darren@<prod-host> 'cd ~/friday/gateway && docker compose up -d hermes expense-tracker'`
- [ ] T055 [US1] Verify Hermes gateway started: `ssh darren@<prod-host> 'docker logs hermes --tail 20'` — confirm "Hermes Agent" banner, platforms connected
- [ ] T056 [US1] Keep OpenClaw running on alternate port (18800) — remove port 18789 mapping to avoid conflict, keep container running as safety net
- [ ] T057 [US1] Verify Telegram: send message to bot → Hermes responds (not OpenClaw). Confirm by checking which container processed it.
- [ ] T058 [US1] Verify Email: send test receipt → Hermes processes it → appears in AB. Confirm in Hermes logs.

**Checkpoint**: Hermes live on production. OpenClaw still running as fallback. Both Telegram and Email verified.

---

## Phase 9: Validation & Monitoring (US4, US5, US6)

**Purpose**: 48-hour validation period. Monitor for errors, regressions, missed emails.

- [ ] T059 Monitor Hermes logs for 24 hours: `docker logs -f hermes` → watch for ERROR/WARN lines
- [ ] T060 Verify all receipt emails processed in first 24h: compare Actual Budget transaction count to expected
- [ ] T061 Verify memory self-learning: check `~/.hermes/memories/MEMORY.md` for new facts added during processing
- [ ] T062 Trigger self-debugger from production Telegram: "debug expense-tracker" → verify it works on production
- [ ] T063 Verify daily auditor ran: check `~/.hermes/cron/output/` for audit report
- [ ] T064 Verify portfolio-tracker, ktmb, image-gen unaffected: `docker compose ps` shows all healthy
- [ ] T065 Verify no duplicated transactions in dedup journal: `sqlite3 modules/expense-tracker/data/dedup.db "SELECT COUNT(*) FROM dedup"` — compare to pre-migration count + new transactions

**Checkpoint**: 48 hours stable. No regressions. Memory learning active. Auditor working.

---

## Phase 10: OpenClaw Decommission (US7)

**Purpose**: Remove OpenClaw after validation confirms Hermes is stable.

- [ ] T066 [US7] Stop OpenClaw container: `docker compose stop openclaw` — verify Hermes still processes emails
- [ ] T067 [US7] Remove OpenClaw service from `gateway/docker-compose.yml`
- [ ] T068 [US7] Archive OpenClaw configs: `mkdir -p gateway/archive/openclaw && mv gateway/openclaw.json gateway/openclaw.json.bk gateway/exec-approvals.json gateway/*.md.template gateway/archive/openclaw/`
- [ ] T069 [US7] Remove OpenClaw plugin: delete `gateway/plugins/expense-tracker-tools/`
- [ ] T070 [US7] Remove OpenClaw Dockerfile and entrypoint: `gateway/Dockerfile`, `gateway/docker-entrypoint.sh`
- [ ] T071 [US7] Remove `openclaw_data` and `openclaw_home` named volumes from `gateway/docker-compose.yml`
- [ ] T072 [US7] `docker compose up -d` — verify only `hermes`, `expense-tracker`, `actual-api` running
- [ ] T073 [US7] Final Telegram verification: send "status" → Hermes confirms operational, lists connected services
- [ ] T074 [US7] Update `DEPLOY.md` — replace OpenClaw deployment steps with Hermes deployment steps
- [ ] T075 [US7] Update `design.md` — update architecture diagrams and descriptions for Hermes migration
- [ ] T076 [US7] Git commit all changes with message: "Migrate expense-tracker from OpenClaw to Hermes Agent"

**Checkpoint**: OpenClaw fully decommissioned. Hermes is the sole agent runtime.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Prep)**: No dependencies — can start immediately
- **Phase 2 (MCP Adapter)**: Depends on Phase 1 (Hermes installed locally for testing)
- **Phase 3 (Docker Config)**: Depends on Phase 2 (MCP server endpoint known for config.yaml)
- **Phase 4 (Memory)**: Depends on Phase 3 (Hermes running in Docker with volume mount)
- **Phase 5 (Email E2E)**: Depends on Phase 3 (Email channel configured) + Phase 4 (memory migrated)
- **Phase 6 (Debugger)**: Depends on Phase 5 (full pipeline working, realistic debugging scenarios)
- **Phase 7 (Auditor)**: Depends on Phase 3 (cron requires Hermes gateway running)
- **Phase 8 (Prod Deploy)**: Depends on Phases 2-7 all passing locally
- **Phase 9 (Validation)**: Depends on Phase 8 (production deployment)
- **Phase 10 (Decommission)**: Depends on Phase 9 (48h stable validation)

### Phase Parallelism

- Phase 6 and Phase 7 can run in parallel after Phase 3 completes (both depend on Docker setup but not on each other)
- Within Phase 2: T007, T008 can run in parallel (different operations)
- Within Phase 3: T016, T017, T018 can run in parallel (different files)

---

## Implementation Strategy

### MVP First (US1 + US2 + US3 + US4 = P1)

1. Complete Phase 1: Local Hermes running
2. Complete Phase 2: expense-tracker MCP adapter
3. Complete Phase 3: Docker Compose with Hermes
4. Complete Phase 4: Memory migration
5. Complete Phase 5: Email E2E working
6. **STOP and VALIDATE**: Full receipt → AB pipeline works
7. Deploy to production (Phase 8)

### Incremental Delivery

1. Phase 1-2 → MCP adapter proven locally
2. Phase 3 → Hermes in Docker, Telegram working
3. Phase 4 → Memory migrated, merchant recognition works
4. Phase 5 → Email → AB pipeline working → **Deploy (MVP!)**
5. Phase 6 → Self-debugging working → Deploy
6. Phase 7 → Daily auditor working → Deploy
7. Phase 9 → 48h validation
8. Phase 10 → OpenClaw decommissioned

---

## Notes

- Hermes is Python-based (not Node.js). All custom code is in expense-tracker (Node.js MCP adapter). Zero Hermes internals changes.
- Email channel uses polling (15s default), not IMAP IDLE. This is acceptable for receipt processing.
- Hermes memory has character limits (2,200 chars MEMORY.md, 1,375 chars USER.md). Consolidate facts during migration.
- Docker socket access requires `HERMES_ALLOW_ROOT_GATEWAY=0` (default) — the container runs as non-root `hermes` user. Docker CLI works because `hermes` user is in `docker` group inside the container.
- Production deployment keeps OpenClaw running as fallback during validation (Phase 9). Only decommission after 48h stable.
- Production server: `<prod-host>`, SSH as `darren`.
- All production commands require explicit approval per project rules.
