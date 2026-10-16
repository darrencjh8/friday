# Spec Consolidation Plan

**Status:** EXECUTED
**Goal:** Make the **code-accurate** baseline easy for future agents to consume by consolidating scattered, partly-contradictory specs into one canonical doc per module, and turning historical specs into thin pointers.

---

## Problem

The expense-tracker baseline is defined (and partly contradicted) across:

| Location | Role today | Drift |
|----------|-----------|-------|
| `specs/002-expense-tracking/{spec,plan,tasks}.md` | "baseline" | Python toolchain, 16 tools (code is JS, 26 REST / 22 MCP) |
| `specs/015-merchant-resolver/` | delta | mandates `keywords.js` + gateway plugin that don't exist |
| `specs/020-orchestrator-deterministic-finalize/` | delta (SUPERSEDED) | keyword chain removed by 021 |
| `specs/021-three-phase-refactor/` | delta (current pipeline) | the authoritative pipeline shape |
| `modules/expense-tracker/docs/design.md` | module design | Python filenames, 16 endpoints, mappings.json |
| `modules/hermes/skills/expense-tracker/SKILL.md` | agent runtime guide | 4-phase + V2/V3 gates (code is 3-phase) |

A future agent reading 002 first gets a Python, 4-phase, keyword-based mental model — none of which matches the code.

---

## Approach (two options for the baseline)

### Option A — Consolidate into `specs/002-expense-tracking/spec.md` (recommended, matches user request)
1. Rewrite `002/spec.md` as the **canonical current baseline** (Node.js, 3-phase pipeline, 26 REST / 22 MCP tools, memory→web→fallback resolution, MEMORY.md storage, IMAP inbox tools).
2. Add a "Consolidated from" header listing 015/020/021 + design.md + SKILL.md.
3. Convert `002/plan.md` Python sections to Node.js, or mark plan.md as **historical (v1)** with a banner pointing to the new spec.md.
4. Trim `015`, `020`, `021` to short **delta** notes that reference 002 as the baseline (keep history, remove contradictions: e.g. 015 FR-005 keyword table marked "removed per 021").
5. `modules/expense-tracker/docs/design.md` → update to JS + correct counts (or replace its baseline parts with a pointer to 002).
6. `SKILL.md` → rewrite to 3-phase to match `orchestrator.js`.

### Option B — Keep 002 as historical, create a fresh `specs/0NN-expense-tracker-baseline/`
- Less churn in 002, but adds another folder. Not what the user asked for.

> **User picked the spirit of Option A** ("baseline expense tracker specs should go to specs/002-expense-tracking/"). Pending confirmation of exact treatment of plan.md (rewrite vs historical banner).

---

## Portfolio-tracker (parallel consolidation)
- Canonical baseline = `specs/003-portfolio-tracker/spec.md` (already mostly code-accurate).
- Fix internal contradictions (SSE wrapper wording, 19 vs 20 REST, 6 vs 10 MCP tools, token_path, AB→PP wording, budget_id, response shape).
- `CONTEXT.md` → align transport (Streamable HTTP) and tool count (10).
- `README.md` / spec.md → reconcile `GOOGLE_SERVICE_ACCOUNT_JSON` optional-vs-required. **Resolved: the docs already said required; no #261 change (verified).**

---

## Code fixes vs doc fixes

Most rows are **doc fixes** (code is source of truth). A few need a **code decision** because the code looks wrong/dead:

| Item | Options |
|------|---------|
| Dead `_abClient` (158) | (a) remove field, (b) build AB-write path — **resolved: dead `abClient` plumbing removed (#261)** |
| Dead `classifyEmail()` (216) | (a) remove, (b) wire into dispatch — **removed** |
| Dead config `BALANCE_SYNC_MODEL`/`LOG_LEVEL` (217), category vars (211) | (a) remove from config, (b) implement — **removed** |
| `GOOGLE_SERVICE_ACCOUNT_JSON` fail-fast vs optional (218) | (a) make guard conditional, (b) doc as required — **docs say required; guard unchanged** (resolved in #261) |
| Stale `index.js:195` SSE comment (220) | trivial code comment fix — **already fixed** |

The dead-config and dead-code items (211, 216, 217) were removed in the docs + stale-code-removal pass. See `code-notes.md` for the current status of every item.

---

## Proposed execution order (after approval)
1. Root `design.md` quick fixes (Java 21, cron).
2. Portfolio docs (spec.md/CONTEXT.md/README/plan.md) drift fixes.
3. Expense docs (SKILL.md 3-phase, design.md JS+counts, 015/020/021 deltas).
4. Consolidate 002 baseline.
5. Per-issue: comment on / close GitHub issues with resolution (optional, with approval).
