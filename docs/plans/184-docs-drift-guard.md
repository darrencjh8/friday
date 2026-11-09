QUESTIONS
q: Which docs count as live and must be fixed, vs historical records? | a: Live docs are README.md, SETUP.md, DEPLOY.md, AGENTS.md, design.md, SPECKIT.md, .specify/memory/constitution.md, docs/*.md except docs/plans/, module READMEs, modules/hermes/SLACK.md, specs/*/spec.md, specs/030-spec-drift/audit.md, .agents/skills/full-deploy/SKILL.md, .agents/dev-loop-plan.md. docs/plans/* are historical records and are left alone, except items 39-40 where a plan presents an expired premise as current — those get a short header note, not a rewrite.
q: What is the scope of the fix? | a: All 43 confirmed drift items from the 2026-11-09 scan (verified both sides: doc claim vs code/config/workflow). Docs and the new guard only — no behaviour change. One apparent code issue found during the scan (OPENCLAW_GATEWAY_URL default still in portfolio-tracker config.js/tools.js) is NOT fixed here; it is noted as a follow-up, since the issue says docs only unless a doc fix requires a code change, and no doc fix here requires it.
q: What does the drift guard check, and where does it run? | a: New script scripts/check-docs-drift.sh, wired as a gating `docs-drift` job in .github/workflows/test.yml (runs on pull_request, same as the other jobs). It verifies mechanically checkable facts: compose service list/count/ports/mem_limit vs the docs that list them; skills/ and profiles/ directory listings vs doc lists; seeded cron jobs in 50-seed-defaults vs the cron tables; expense-tracker REST toolNames count and MCP server.tool count, portfolio-tracker MCP count; test.yml job names vs docs/testing.md; deploy.sh component list vs doc lists; deploy.yml detection mapping and mkdir line vs DEPLOY.md/SETUP.md; and absence of retired strings (commandcode in config/deploy, `.speckit/` paths, `db.sqlite`, OpenClaw-gateway claims). If a check cannot resolve what it compares, it fails closed.
q: Which drift cannot be checked automatically? | a: The constitution rewrite (OpenClaw-era prose to Hermes — needs human reading, guarded only by the absence check for gateway claims); the seed-merge semantics wording (item 21 — the seed header documents it, the doc must match it, checked by hand); the manual-deploy prohibition in full-deploy/SKILL.md (a policy statement, not a countable fact); plan records whose premises expired (items 39-40 — header notes, not checkable); and the 15 suspicious items that cannot be verified from the repo alone (host state, binary behaviour, cross-repo refs) — those are left as-is and listed in the plan as not fixed, with reasons.
q: How is the guard itself tested? | a: modules/tests/test_issue_184.py pins 5 concrete drift cases (README service count, AGENTS.md db.sqlite, troubleshooting COMMANDCODE, design.md Hermes mem_limit, SETUP.md memory-compact schedule): fails at base, passes at HEAD. The guard script is also run in CI, and its own failure modes are probed by mutation: each documented value is temporarily changed in a temp copy and the guard must fail.

# Plan: update outdated docs/specs and add a drift guard (issue #184)

## Goal

Fix friday #184: documentation and specs have drifted from the code, config
and workflows. Update every outdated live doc to match the code as it is now,
and add an automated CI check so docs cannot silently drift again.

## Evidence

- Reproduction recorded with dev-loop (`loop.py repro`, phase REPRODUCED):
  command `python3 -m unittest modules.tests.test_issue_184 -v`, test id
  `modules.tests.test_issue_184.TestIssue184.test_docs_match_code`. At base
  it fails on all 5 pinned cases.
- Full scan done 2026-11-09 (read-only, every item verified both sides):
  43 confirmed drift items, 15 suspicious/unconfirmed. The confirmed items
  are listed below by file. The prior specs/030-spec-drift audit is itself
  item 38: it was verified at commit f22135d and its counts have since moved.

## Changes

### A. Service / layout inventories (items 3, 4, 5, 17, 18, 22, 23, 24)
- Compose defines 9 services: expense-tracker, actual-api, portfolio-tracker,
  dots-web, codex-router, codex-router-a, codex-router-b, hermes, whisper.
- README.md, design.md §2, docs/repository-layout.md: say nine, list all
  nine (dots-web and whisper were missing).
- Skills: 10 dirs in modules/hermes/skills/ (expense-tracker, gcal-readonly,
  gmail-readonly, goals, google-login, gtasks-cli, hermes-troubleshooting,
  image-gen, skill-merge-approval, spec-auditor). README.md, docs/README.md,
  docs/repository-layout.md: list all ten.
- Profiles: only code-reviewer exists in modules/hermes/profiles/; the seed
  retires static-analyst, qa-engineer, quality-assurance, architect,
  project-manager, spec-auditor. README.md, design.md §2, DEPLOY.md: say so.
- Ports: hermes also publishes 127.0.0.1:9120, 8300, 8299; dots-web 8789;
  whisper has no published port (state what compose says). SETUP.md,
  docs/operations.md: complete the tables.
- Deployable components include whisper (deploy.sh usage). README.md,
  DEPLOY.md, SETUP.md, docs/setup.md: add it to every component list.

### B. Resource / cron facts (items 6, 11, 12)
- design.md §4: Hermes mem_limit 4g (not ~4 GB/3g); expense-tracker has no
  mem_limit — 512m is portfolio-tracker's.
- Cron: 50-seed-defaults seeds 15 jobs; design.md §6.4 and SETUP.md tables
  list all 15 with current exprs, including gtasks-clear-completed,
  notion-monthly-bills-reset, actual-backup, proactive-tick; memory-compact
  is daily `30 7 * * *`, not Sundays. Both tables use the seed's
  schedule_display wording verbatim ("every 15m", "every 360m"), not
  paraphrases like "Every 15 min".

### C. Tool-surface counts (items 7, 8, 29, 30, 31, 35, 36)
- Expense-tracker: registry 39; MCP 27 with learning on / 28 off;
  REST 32 with learning on / 33 off; neither-surface 3
  (check_schedule_collision, fetch_schedules, submit_decision).
  design.md §5.1/§5.5, modules/expense-tracker/docs/design.md: correct the
  counts (REST was 31, missing match_broker_deposit).
- docs/glossary.md: the MCP list is a swap, not an addition — search_wiki
  in, confirm_learning out, learning-on count stays 27. MCP-only stays
  six (compact_facts, fetch_context, list_inbox_emails,
  process_transaction, read_inbox_email, search_facts); search_wiki is on
  the REST surface (index.js:140), so it is not MCP-only. REST-only is
  eleven, not ten (add match_broker_deposit); portfolio executeTool line
  numbers updated to current file.
- specs/002-expense-tracking/spec.md: primary LLM is auto-thinking via
  codex-router with DeepSeek fallback (not DeepSeek-only); REST 32/33,
  MCP 27/28.
- specs/003-portfolio-tracker/CONTEXT.md: 12 MCP tools, not 6 (its own
  line 26 already says 12).

### D. Retired things still documented (items 1, 2, 9, 15, 27, 33, 34, 37, 41, 43)
- SPECKIT.md: feature numbering is sequential and the next number is 031
  (latest spec dir is specs/030-spec-drift/), not 014.
- .specify/memory/constitution.md: rewrite the OpenClaw-gateway framing to
  the Hermes runtime (hermes-agent image, `gateway run`, Node.js 22
  trackers, no openclaw service, no port 18789, no tools_api.py, Java 21).
- design.md §11 and modules/expense-tracker/docs/design.md: `.speckit/`
  does not exist; constitution is .specify/memory/constitution.md, specs
  are specs/<NNN-name>/; webhook is Hermes :8644 (deliver: dots/Telegram),
  not :18800/email.
- docs/troubleshooting.md: delete the COMMANDCODE_API_KEY paragraph — the
  provider is retired (no commandcode in config.yaml or deploy.sh; the
  test suite asserts no commandcode primaries).
- modules/onedrive-sync/README.md: the rclone container is retired; sync
  is via Microsoft Graph in portfolio-tracker/src/onedrive.js; remove the
  `docker compose up -d onedrive-sync`, `python sync.py` and 5-minute
  instructions.
- specs/001-gateway/spec.md: ktmb-booking is retired; MCP transport is
  Streamable HTTP, not SSE.
- specs/003-portfolio-tracker/spec.md: no apscheduler anywhere in the code;
  the only scheduler is the Hermes cron job finance-portfolio-sync.
- .agents/skills/full-deploy/SKILL.md: the skill instructs the forbidden
  manual-deploy flow (SSH, git pull on production, scp .env). Rewrite
  Phases 0/3/4 to the CI-only shipping path (merge to main; deploy.yml
  owns deployment), fix the service count to 9 and the health-endpoint
  count inconsistency (3 checked vs "4" reported), and add the hermes
  gateway s6-svstat check the deploy.sh note omits. Doc change only.
- AGENTS.md: remove the "Initialized with README…" status and "Remaining
  files to push locally" lines (repo long populated); replace
  `modules/expense-tracker/db.sqlite` with the real dedup journal
  `modules/expense-tracker/data/dedup.db` (+ statement.db).

### E. Workflow / deploy facts (items 19, 20, 21, 25, 26, 28)
- DEPLOY.md step 3: compose/deploy.sh changes map to `all`, not
  codex-router (deploy.yml:110 overrides); there is no root Dockerfile or
  root deploy.sh; document the fetch-claude-usage.py → codex-router rule.
- DEPLOY.md step 4 / SETUP.md: deploy.yml also creates
  `expense-tracker/state` (and codex-router dir).
- DEPLOY.md seed-merge section: describe the per-server mcp_servers merge
  (baked wins per server, live-only carried, retired removed) as of #177,
  not only the old wholesale top-level merge.
- docs/testing.md: add the dots-web and whisper jobs; correct the unwired
  list (test-mnemosyne-vacuum.sh IS wired; the other three are not).
- docs/email-intake-cutover.md: quote the exact log strings. The adapter
  logs "[email-intake] live mode started (interval 300s)"
  (adapter.py:72, mode=live); the dispatch wait line is
  "email-intake live dispatch waits: old_watcher_running"
  (intake/dispatch.py:269). The doc's bare "[email-intake] live mode
  started" and "live dispatch waits: old_watcher_running" are both
  missing their prefixes/suffixes.

### F. Internal contradictions and stale statuses (items 10, 13, 14, 16, 38, 39, 40)
- design.md §5A.2: StatementProcessor uses the shared LLMClient; default
  model auto-thinking via codex-router, deepseek-flash only for the
  deepseek provider.
- design.md §7.1: tool loop caps TOOL_MAX_ROUNDS=3, TOOL_MAX_CALLS=6;
  dedup cooldown 12h (RETRY_COOLDOWN_MINUTES=12*60), not 60 min.
- design.md §3.2/§7.1: notify_user goes to the Hermes webhook relayed to
  Telegram/Dots; there is no email delivery path.
- design.md §1/§13: statement-reconciliation is implemented
  (modules/expense-tracker/src/statement/ exists); remove the
  "Implementation Pending" status and the stale roadmap item.
- specs/030-spec-drift/audit.md: add a header note that it was verified at
  f22135d and its counts have since moved; point at the new guard script
  as the current check.
- .agents/dev-loop-plan.md and docs/incoming-credit-booking-680.md: add a
  header note that the described defect is fixed (incoming arm exists,
  regression test committed) and the files are historical records.
- docs/loan-sync-147-plan.md: add a header note that loan sync is
  implemented (tests committed) and the plan's premise no longer holds.
- specs/004-statement-reconciliation/spec.md status line becomes
  "Implemented (expense-tracker); no portfolio-tracker side in scope":
  the PT module has statement parsing only for IBKR/broker deposits
  (ibkr_flex.js, broker_deposits.js), not a reconciliation pipeline
  against Actual Budget, and design.md §5A.4 already marks the spec
  implemented.

### G. Drift guard (new)
- New script `scripts/check-docs-drift.sh` (bash, style: `fail() { echo
  "FAIL: $1"; status=1; }`, non-zero exit on any FAIL, named FAIL lines
  that name the doc and the fact, `set -u`, no writes to the repo).
  Checks, each against the live code/config:
  1. Compose service list/count vs README.md, design.md §2,
     docs/repository-layout.md. Names are matched exactly (anchored,
     word-boundary): `codex-router` must not match `codex-router-a` or
     `codex-router-b`.
  2. Compose mem_limit per service vs design.md §4 table.
  3. Compose published ports per service vs SETUP.md and
     docs/operations.md tables.
  4. skills/ and profiles/ listings vs the doc lists.
  5. Seeded cron jobs vs the design.md/SETUP.md tables, extracted
     per shape: 11 jobs carry an `expr` field (compare expr); 2 interval
     jobs (ops-github-token-refresh every 15m, memory-backup every 360m)
     carry no expr and are compared by schedule_display; 2 jobs live in
     the SEEDS dict in 50-seed-defaults (notion-monthly-bills-reset and
     actual-backup, both `0 0 1 * *`) and are compared by that dict's
     expr. 9 of the 11 expr-carrying jobs define their expr inside
     per-job DEFAULTS dicts spread into the job via **DEFAULTS, so
     extraction must associate each expr with its job through its
     DEFAULTS block — a bare `"expr"` grep miscounts. The guard reads
     all three shapes; a job present in the seed but missing from the
     tables fails, and vice versa.
  6. Tool counts, both raw and learning-on: raw MCP server.tool count
     is 28 and raw REST toolNames count is 33; the learning-on counts
     are 27 and 32 (the single conditional confirm_learning in
     mcp-server.js:208 and index.js:202-204). The guard parses the two
     gating conditionals and compares the raw counts against the raw
     figures and the learning-on counts against the doc figures
     (design.md, glossary.md, specs/002, specs/003). Portfolio MCP
     count is 12 raw.
  7. test.yml job names vs docs/testing.md table.
  8. deploy.sh component list vs the doc component lists. The source is
     the union of the usage comment (deploy.sh:10: all, hermes,
     portfolio-tracker, expense-tracker, actual-api, image-gen, whisper)
     and the component echo block (deploy.sh:39-40, which adds
     codex-router). Names matched exactly, as in check 1.
  9. deploy.yml detection: assert the file contains the specific grep
     lines for the documented rules — the codex-router rule for
     `.github/workflows/deploy.yml` changes (line 109), the override to
     `all` for root Dockerfile/deploy.sh or
     modules/docker-compose.yml|deploy.sh paths (lines 110-112, which
     fire only for those paths), and the fetch-claude-usage.py →
     codex-router rule (line 107) — plus the mkdir line that also
     creates expense-tracker/state (line 119), vs DEPLOY.md/SETUP.md.
  10. Absence of retired strings, scoped to named live files only:
      `commandcode` in modules/hermes/config.yaml and modules/deploy.sh,
      and `COMMANDCODE_API_KEY` in docs/troubleshooting.md (the doc must
      not reintroduce the retired provider);
      `.speckit/` presented as an existing location (in design.md §11
      and modules/expense-tracker/docs/design.md — a true denial such as
      "There is no `.speckit/` directory" is allowed, as are mentions
      in docs/plans/, historical specs, and test fixtures);
      `db.sqlite` in AGENTS.md; OpenClaw-gateway claims in
      .specify/memory/constitution.md (no `openclaw` service, no port
      18789, no tools_api.py).
  11. SPECKIT.md's stated next spec number equals max specs/NNN number
      + 1 (currently 031).
- Wire it as a gating `docs-drift` job in .github/workflows/test.yml
  (runs on pull_request; also add the script run to the hermes-scripts
  job so a local `bash scripts/check-docs-drift.sh` and CI agree).
- Guard failure modes probed by mutation in the repro test run: each
  documented value changed in a temp copy must fail the guard.

## Out of scope
- No behaviour change. No code change except the guard script and its CI
  wiring (and the test control). No deploy, no restart, no live service.
- The OPENCLAW_GATEWAY_URL default surviving in
  modules/portfolio-tracker/src/config.js:105 and src/tools.js:805
  (suspicious item S12) is a code matter, not a doc fix; noted here as a
  follow-up, not fixed in this PR.
- 13 of the 15 suspicious items that cannot be verified from the repo
  alone (host state, Hermes-binary behaviour, cross-repo refs,
  point-in-time figures, historical claims) are left as-is; the guard
  does not assert them. S8 (operations.md mcp-test qualifier) is fixed
  as part of item E because it is verifiable in deploy.sh, and S9
  (spec 004 PT side) is resolved in F.
- docs/plans/* are not rewritten; only the header notes in F above.

## Verification
- `python3 -m unittest modules.tests.test_issue_184 -v` passes at HEAD
  (fails at base on all 5 pinned cases). The test file also invokes
  `scripts/check-docs-drift.sh` directly and fails with "drift guard
  missing" if the script is absent, so the control is green only when
  the guard itself is green.
- `bash scripts/check-docs-drift.sh` passes on the unmutated tree.
- Mutation probes, executed by `modules/tests/test_issue_184.py`
  (method `test_guard_mutations`): it copies the tree to a temp dir
  (excluding .git) once per probe and asserts the guard exits non-zero
  with a named FAIL line. One probe per guard check, plus learning-on/off
  variants for check 6: (1) remove a service from the doc list, (2)
  change a mem_limit in the doc, (3) drop a port from a doc table,
  (4) remove a skill from a doc list, (5a) change a cron expr in a doc
  table, (5b) change an interval job's display, (5c) drop a SEEDS-dict
  job from a doc table, (6a) change the raw MCP count in a doc,
  (6b) change the learning-on REST count in a doc, (7) drop a test.yml
  job from docs/testing.md, (8) drop whisper from a doc component list,
  (9) narrow the override grep pattern in deploy.yml so it no longer
  covers modules/deploy.sh, (10a) re-add a `.speckit/` path as an
  existing location in design.md, (10b) append a COMMANDCODE_API_KEY
  sentence to docs/troubleshooting.md, (11) change SPECKIT.md's stated
  next number back to 014.
- Local validation commands, run exactly: `shellcheck
  scripts/check-docs-drift.sh`, `bash scripts/check-docs-drift.sh`,
  `python3 -m unittest modules.tests.test_issue_184 -v`.
- Dev-loop review round, then push branch and create PR, no merge by
  the agent.

## Appendix: scan item list (2026-11-09, verified both sides)
Confirmed drift (43): 1 SPECKIT.md next spec number 014 vs 031. 2
constitution.md OpenClaw-gateway framing vs Hermes runtime. 3 README.md
"five runtime services" vs 9. 4 design.md §2 service list missing
dots-web/whisper. 5 docs/repository-layout.md "seven runtime services"
vs 9. 6 design.md §4 mem_limit (Hermes 3g vs 4g; expense-tracker 512m
is portfolio-tracker's). 7 design.md §5.1/§5.5 REST 31 vs 32/33. 8
expense-tracker docs/design.md REST 31 vs 32/33. 9 expense-tracker
docs/design.md `.speckit/` paths and :18800 webhook vs :8644. 10
design.md §5A.2 deepseek-flash vs shared LLMClient/auto-thinking. 11
design.md §6.4 cron table: 11 rows vs 15 seeded (4 missing),
memory-compact weekly vs daily. 12 SETUP.md cron table: same. 13 design.md §7.1 tool loop max
5 vs 3 rounds/6 calls; dedup 60 min vs 12h. 14 design.md §3.2/§7.1
notify_user email vs Telegram/Dots webhook. 15 design.md §11
`.speckit/` hierarchy vs .specify/specs. 16 design.md §1/§13
statement-reconciliation "pending" vs implemented. 17 skills listed as
4 vs 10. 18 profiles listed as 4 (architect, code-reviewer,
project-manager, spec-auditor) vs only code-reviewer. 19 DEPLOY.md step
3 mapping (docker-compose.yml/deploy.sh → all, not codex-router; no
root Dockerfile/deploy.sh; fetch-claude-usage.py rule undocumented).
20 DEPLOY.md/SETUP.md mkdir list omits expense-tracker/state (and
codex-router in SETUP.md). 21 DEPLOY.md seed-merge wording vs per-server
merge since #177. 22 SETUP.md Hermes ports missing 9120/8300/8299 and
dots-web/whisper rows. 23 docs/operations.md ports missing 8300/8299.
24 component lists missing whisper. 25 docs/testing.md missing dots-web
and whisper jobs. 26 docs/testing.md unwired list wrong about
test-mnemosyne-vacuum.sh (it IS wired). 27 docs/troubleshooting.md
COMMANDCODE paragraph (provider retired). 28
docs/email-intake-cutover.md log lines imprecise. 29 docs/glossary.md
MCP list swap (search_wiki in, confirm_learning out). 30 glossary
MCP-only six, not seven (search_wiki is on REST). 31 glossary REST-only
eleven, not ten (match_broker_deposit). 32 glossary portfolio
executeTool line numbers stale. 33 modules/onedrive-sync/README.md
retired rclone instructions. 34 specs/001-gateway/spec.md ktmb-booking
retired, SSE vs Streamable HTTP. 35 specs/002-expense-tracking/spec.md
DeepSeek-only vs auto-thinking, REST 28 vs 32/33, MCP 24 vs 27/28. 36
specs/003-portfolio-tracker/CONTEXT.md "6 MCP tools" vs 12. 37
specs/003-portfolio-tracker/spec.md apscheduler vs Hermes cron only.
38 specs/030-spec-drift/audit.md pinned to f22135d, counts moved. 39
.agents/dev-loop-plan.md and docs/incoming-credit-booking-680.md present
a fixed defect as current. 40 docs/loan-sync-147-plan.md premise
expired (loan sync implemented). 41 .agents/skills/full-deploy/SKILL.md
instructs the forbidden manual-deploy flow. 42 full-deploy SKILL.md "7
services" vs 9, 3 vs "4" health endpoints, missing hermes s6-svstat
check. 43 AGENTS.md "Initialized…" status and db.sqlite path.
Suspicious (15): 13 left as-is; S8 fixed in E; S9 resolved in F. S1/S2 Telegram /sync commands (no handler
in repo; may live in the Hermes binary). S3 WARP status (host state).
S4 cost model (OpenClaw-era framing, no current figures in repo). S5
AGENTS.md dev-loop policy.json cross-repo ref. S6 friday-memory one-way
sync claim. S7 SETUP.md "Docker 26.1.5" (host state). S8 operations.md
mcp-test qualifier — fixed as part of E (verifiable in deploy.sh).
S9 spec 004 PT side — resolved in F (no PT pipeline in scope). S10
spec 001 Thinker sub-agent / reports cron (no implementation in repo;
aspirational text, left). S11 full-deploy SKILL.md chrome-daemon
ports 9222/9223 (host state). S12 OPENCLAW_GATEWAY_URL default in
portfolio-tracker code — follow-up, not fixed here. S13
portfolio-tracker README test counts (point-in-time figures, left).
S14 email-intake-cutover go/no-go and merged-PR claims (not verifiable
from repo). S15 DEPLOY.md caddy 2.11.6 behaviour claim (historical,
pin itself verified).
