# Implementation Tasks: Telegram Link Preview Disable

**Feature:** telegram-link-preview  
**Tasks Version:** 1.0.0  
**Status:** Complete
**Constitution Hash:** v4.0.0  

---

## Task Dependency Graph

```
Phase 1: Test (RED)
  T1.1 — Write config schema validation test

Phase 2: Implement (GREEN)
  T2.1 — Add linkPreview: false to openclaw.json
  T2.2 — Run validation test (must pass)

Phase 3: Verify
  T3.1 — docker compose config check
  T3.2 — Audit drift: spec vs implementation
```

---

## Phase 1: Test (RED)

### T1.1 — Write Config Schema Validation Test

**Priority:** P0 (blocker)  
**Estimate:** 10 minutes  

Create `gateway/tests/config.schema.test.js` (or inline in a test runner command) that:

1. Reads and parses `gateway/openclaw.json`
2. Asserts `config.channels.telegram.linkPreview` exists and is `false`
3. Asserts other telegram keys (`enabled`, `botToken`, `dmPolicy`, `allowFrom`) are still present
4. Asserts JSON parses without SyntaxError

**Validation:** Test fails before implementation (RED phase).

- [x] Done

---

## Phase 2: Implement (GREEN)

### T2.1 — Add linkPreview to openclaw.json

- [x] Done

### T2.2 — Run Validation Test

- [x] Done

---

## Phase 3: Verify

### T3.1 — Docker Compose Config Check

- [x] Done (Docker unavailable in dev WSL; verified config parses via JSON test instead)

### T3.2 — Drift Audit

- [x] Done — sub-agent review found brittle exact-keys test; fixed to subset check

---

## Execution Sequence

| Order | Task | Phase | Can Parallelize With |
|-------|------|-------|---------------------|
| 1 | T1.1 — Write test | Test | - |
| 2 | T2.1 — Add linkPreview | Implement | - |
| 3 | T2.2 — Run test | Implement | - |
| 4 | T3.1 — Compose check | Verify | - |
| 5 | T3.2 — Drift audit | Verify | - |

**Total Estimated Effort:** ~25 minutes
