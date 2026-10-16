# Glossary

The names used across these pages. Tool names are the MCP tool identifiers the
agent calls, so they are written exactly as they appear in code.

## Systems and platforms

| Term | Meaning |
|---|---|
| **Friday** | The agent itself — this repository's product. Runs on Hermes Agent. |
| **Hermes** | [Hermes Agent](https://github.com/NousResearch/hermes-agent), the runtime that hosts Friday: the gateway, the chat platforms, the MCP client, the memory tiers, and the cron scheduler. |
| **Actual Budget** | The self-hosted budgeting app. Friday's system of record for *expenses*. `actual-api` is the Node proxy in front of it. |
| **Portfolio Performance** | The self-hosted portfolio tracker. The system of record for *holdings and balances*. Its data is a single XML file, synced through OneDrive. |
| **IBKR** | Interactive Brokers. Flex Queries (XML) and PDF trade confirmations are the inbound portfolio formats. |
| **LiteLLM** | The proxy library the `codex-router` service runs on, which multiplexes several provider accounts behind one OpenAI-compatible endpoint. |
| **codex-router** | A **separate repository**, `darrencjh8/codex-router`, checked out into `modules/codex-router` at deploy time. It is not part of this repository and is absent from a plain clone. In compose it runs as two interchangeable colours, `codex-router-a` and `codex-router-b`, behind the `codex-router` front (`modules/codex-router-front/`), which owns `:4100`; a deploy rolls one colour at a time. |
| **MCP** | Model Context Protocol. Both trackers expose a Streamable HTTP MCP server at `/mcp` alongside their REST `/tools/*` endpoints. **The two surfaces are not interchangeable** — portfolio-tracker publishes 22 REST tools but only 12 MCP tools with wholly different, `portfolio_`-prefixed names, and expense-tracker's read-only lookups are REST-only. Each tracker also has a third surface its own code drives — the orchestrator's internal LLM calls — which is on neither. See [the tool surfaces below](#tool-surfaces-rest-vs-mcp) before calling a tool by name. |
| **Spec-Kit** | The scaffolding in `.specify/` that produces the `specs/NNN-name/` layout: `spec.md`, `plan.md`, `tasks.md`. |

## Email pipeline

| Term | Meaning |
|---|---|
| **statement** | A periodic account or card summary. Routed to the reconciliation pipeline rather than booked as a transaction. |
| **transaction alert** | A single-transaction notification from a bank or broker. This is what gets booked. |
| **three-phase pipeline** | How a non-statement message is processed, all inside `orchestrator.js`. **Phase 1** — a low-reasoning LLM call that reads live accounts, categories and payees with `fetch_context`. **Phase 2** — code-driven resolution of the blanks it could not fill, through memory and `resolve_merchant`. **Phase 3** — the booking itself. |
| **card suffix fact** | A remembered mapping such as "card ending *NNN* belongs to *<card name>*". It beats an LLM's guess when an alert gives only the last four digits. Managed with `search_facts`, `learn_fact`, `update_fact`, and `cleanup_facts`. |
| **own-account transfer** | Money moving between the operator's own accounts. Must book as a linked transfer *pair*, not as two unclassified expenses. |
| **reference number** | The bank's own transfer reference, which is what pairs the two legs. |

## Tool surfaces: REST vs MCP

The two trackers expose **two different tool surfaces**, and they are not the
same set. This distinction is the one most easily got wrong, so it is stated
first:

- **REST** — the HTTP tool endpoints on `/tools/*`. **This is the widest surface**,
  but the path is *not* uniform across the two trackers, so never derive a URL
  from a tool name. `expense-tracker` builds it mechanically from the tool name
  with underscores turned into hyphens (`fetch_context` → `/tools/fetch-context`)
  — but only for tools in its route table, and that table is **not** the same set
  as the MCP surface: `fetch_context` is MCP-only and has no such route.
  `portfolio-tracker`
  uses a hand-written table, and 10 of its 22 routes have a path that is not
  just the tool name with hyphens — `/tools/ibkr-import-xml` runs
  `parse_ibkr_flex_query`, `/tools/pp-accounts` runs `fetch_pp_accounts`,
  `/tools/gs-update-sheet` runs `update_google_sheet`. Read the table in
  `modules/portfolio-tracker/src/index.js` before calling one.
- **MCP** — a smaller, separately registered set at `/mcp`. **This is what the
  agent actually calls** when Hermes connects the trackers as MCP servers, so
  it is the surface that matters when you are reasoning about what Friday can
  do in a chat turn. It is not a separate implementation: each registered tool
  dispatches into the same internal registry the HTTP routes use, so the two
  surfaces are different *entry points*, not different back ends.

Where the two differ, both are listed below. `fetch_context` is the case to
remember: it **is** on the MCP surface, so Hermes can call it from a chat turn,
but it has no HTTP route — and it doubles as an input to the orchestrator's own
Phase 1 LLM call, which is a third, separate surface.

### expense-tracker — MCP surface (27 tools)

This is the set Hermes calls.

`fetch_context` · `fetch_budgets` · `fetch_budget_month` ·
`fetch_recent_transactions` · `fetch_unreconciled_transactions` ·
`insert_transaction` · `process_transaction` · `update_transaction` ·
`reconcile_transaction` · `unclear_transaction` · `resolve_merchant` ·
`extract_email_content` · `extract_inbox_pdf` · `extract_pdf_text` ·
`list_inbox_emails` · `read_inbox_email` · `mark_email_read` ·
`learn_fact` · `search_facts` · `list_facts` · `update_fact` · `delete_fact` ·
`compact_facts` · `cleanup_facts` · `list_pending_learning` ·
`confirm_learning` · `decline_learning`

### expense-tracker — REST-only tools

On the HTTP surface at `POST /tools/<name>` but **not** registered on the MCP
server, so Hermes cannot call them as tools — reach them over REST or through a
quick command instead. These ten, exactly:

`check_duplicate` · `check_statement_duplicate` · `fetch_accounts` ·
`fetch_categories` · `fetch_payees` · `fetch_statement_history` ·
`log_decision` · `notify_user` · `record_statement` · `search_memory`

Six more are MCP-only, with no HTTP route at all: `fetch_context`,
`list_inbox_emails`, `process_transaction`, `read_inbox_email`, `search_facts`,
and `compact_facts`.

`search_memory` and `search_facts` are two names for **one** implementation: the
MCP tool dispatches straight into the `search_memory` handler
(`mcp-server.js`), and `search_facts` has no entry of its own in
`src/tools.js`. They differ only in surface — the registry name is on the REST
side, the MCP name is not. That is exactly the trap the two lists above exist to
prevent, which is why the lists are the authority rather than the tool names in
`src/tools.js`: a name taken from one surface will not necessarily resolve on
the other.

A third surface exists and is easy to mistake for either of these: the
orchestrator's own LLM calls. `getPhase1ToolSchemas()` hands the internal model a
set built from `fetch_context` and `search_memory`, and the statement pipeline
likewise calls handlers such as `fetch_schedules`, `check_schedule_collision`,
and `submit_decision` which are **neither** an HTTP route nor an MCP tool. They
are reachable only by the code that drives them, so an agent will not find them
on any surface it can call.

`reconcile_transaction` clears Actual Budget transactions (`cleared=true`, with
an optional statement reference appended to the notes); `unclear_transaction`
reverses it. `update_transaction` edits a transaction's fields, validating payee
and category against the live lists — and when a transfer payee and a plain
payee share a name, a bare `payee_name` selects the *transfer* payee, so pass
`payee_id` to be explicit. `submit_decision` submits the final structured
decision for an email once every required field is filled.

### portfolio-tracker — MCP surface (12 tools)

The MCP names are **`portfolio_`-prefixed** and are a completely different set
from the REST tool names — the same job has a different identifier on each
surface. All twelve:

`portfolio_sync` · `portfolio_get_all` · `portfolio_insert_transaction` ·
`portfolio_query_security` · `portfolio_taxonomy` · `portfolio_search_memory` ·
`portfolio_learn_fact` · `portfolio_onedrive_status` ·
`portfolio_onedrive_pull` · `portfolio_onedrive_push` ·
`portfolio_onedrive_auth_url` · `portfolio_onedrive_auth_complete`

How they map to the REST names:

| MCP tool | REST equivalent |
|---|---|
| `portfolio_sync` | the `pp-sync-all` endpoint |
| `portfolio_get_all` | the `fetch_pp_*` reads, combined |
| `portfolio_insert_transaction` | `insert_pp_transaction` |
| `portfolio_query_security` | `query_pp_security` |
| `portfolio_taxonomy` | `query_pp_taxonomies` |
| `portfolio_onedrive_pull` / `portfolio_onedrive_push` | `pp-pull` / `pp-push` |
| `portfolio_onedrive_status` | OneDrive authorisation state |
| `portfolio_onedrive_auth_url` / `portfolio_onedrive_auth_complete` | the device-auth pair |
| `portfolio_search_memory` / `portfolio_learn_fact` | the tracker's memory tools |

### portfolio-tracker — REST tools (all 22)

All **twenty-two** of these, exactly. The two surfaces share no **name**: none of
the 12 MCP tool names is also a REST route name. They do share six
**handlers** — every name the six dispatch sites pass to
`registry.executeTool` (`mcp-server.js:223, 255, 266, 280, 291, 298`) is
itself one of the 22 routes below: `insert_pp_transaction`, `fetch_pp_portfolio`,
`query_pp_security`, `query_pp_taxonomies`, `search_memory`, and `learn_fact`.
So six of the names listed here are reachable through MCP too, just under a
different tool name — `insert_pp_transaction` as `portfolio_insert_transaction`,
`fetch_pp_portfolio` as `portfolio_get_all`, and so on. See the mapping table
above.

`parse_ibkr_flex_query` · `extract_pdf_text` · `extract_email_content` ·
`fetch_pp_accounts` · `fetch_pp_securities` · `fetch_pp_portfolio` ·
`query_pp_security` · `query_pp_taxonomies` · `insert_pp_transaction` ·
`update_pp_balance` · `update_google_sheet` · `check_duplicate` ·
`ask_user_confirmation` · `log_decision` · `notify_user` · `learn_mapping` ·
`learn_fact` · `search_memory` · `get_pp_status` · `pp-pull` · `pp-push` ·
`pp-sync-all`

## Portfolio terms

- **pp-cli** — the Java CLI in `modules/portfolio-tracker/pp-cli/` that performs
  every Portfolio Performance write, built against the Portfolio Performance
  model JAR so edits use its own model classes. Nothing mutates the XML except
  through it.
- **pp-pull / pp-push** — the OneDrive sync of the Portfolio XML, through the
  Microsoft Graph API. There is no rclone or `onedrive-sync` container in the
  runtime stack.
- **Flex Query** — IBKR's XML activity report; the other inbound format
  alongside PDF trade confirmations.
- **taxonomy** — Portfolio Performance's categorisation tree, exportable to
  Google Sheets.

## Runtime and deploy

| Term | Meaning |
|---|---|
| **`actual-api`** | Node.js on `:3000`. A proxy in front of the Actual Budget server that holds the connection credentials so the trackers do not each need them. Note it is **not** a pure credential boundary: compose also passes `ACTUAL_BUDGET_PASSWORD` straight into `expense-tracker`, `portfolio-tracker`, and `actual-api` itself (see `modules/docker-compose.yml`). |
| **pluggable module** | A module under `modules/` that declares itself in `modules/<name>/module.env` (`MODULE_NAME`, `MODULE_REQUIRED_VARS`). `deploy.sh` discovers these automatically, so adding one needs no change to the deploy script. `ktmb-booking` is retired and skipped. |
| **`module.env`** | The discovery manifest for a pluggable module. Absent, the module is invisible to the deploy. |
| **`guardEnv` / env validation** | Two different pre-flight checks, and it matters which is which. `deploy.sh` validates declared variables with `check_var` (`deploy.sh`) before anything is built or restarted. `portfolio-tracker/src/index.js` has its own `guardEnv()` that runs at process start and exits if `DEEPSEEK_API_KEY` and friends are missing. |
| **self-hosted runner** | The machine GitHub Actions runs the deploy on; it holds the workspace and the Docker daemon. |
| **quick command** | A shortcut defined in `modules/hermes/config.yaml` that curls a tracker's REST endpoint directly, e.g. `portfolio-sync`. |
| **webhook platform** | The Hermes platform on `:8644` that receives `notify_user` calls and relays them to the chat channel. Only `expense-tracker` uses it, via `NOTIFY_URL` (wired in `docker-compose.yml`); `portfolio-tracker` posts to `OPENCLAW_GATEWAY_URL` `/api/notify` instead (`portfolio-tracker/src/tools.js`) and never reads `NOTIFY_URL`. |
| **s6** | The init system inside the Hermes container. `s6-svstat` on `gateway-default` is how the gateway's health is checked, since the dashboard is disabled and has no port. |
| **`50-seed-defaults`** | The container's init script. On every boot it seeds config, `SOUL.md`, cron jobs, skills, and scripts. For cron it keeps two dicts: `MANAGED` (behaviour-defining fields such as `prompt` and `skills`) is reconciled in place on every boot, while `DEFAULTS` (schedule, enabled flag) is minted once at creation and then left alone, so a dashboard change to the time is not reverted on the next boot. The split is per job rather than uniform — `ops-log-issues` also reconciles `deliver`. |

## Repositories

`darrencjh8/friday` (this one) · `darrencjh8/codex-router` (the router,
checked out at deploy time and also the home of the `dev-loop` skill and its
gates).
