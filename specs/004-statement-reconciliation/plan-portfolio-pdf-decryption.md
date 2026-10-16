# Delta Plan: Portfolio-Tracker Encrypted-PDF Statement Pipeline

**Parent Plan:** `004-statement-reconciliation/plan.md`
**Spec:** `delta-portfolio-pdf-decryption.md`
**Issue:** #88   **Module:** `modules/portfolio-tracker`
**Worktree:** `../friday-portfolio-pdf` (branch `feat/portfolio-pdf-decryption`)
**Method:** strict TDD (RED → GREEN → REFACTOR), one task at a time.

All paths below are relative to `modules/portfolio-tracker/`.
Run tests with: `cd modules/portfolio-tracker && npm test` (vitest).

---

## Task 0 — Baseline (no code change)
- [ ] `npm test` in `modules/portfolio-tracker` → record current green baseline.
- [ ] Confirm fixture `../../test-protected.pdf` (pw `Test@123`) is readable from tests.
- **Gate:** baseline green before any change.

## Task 1 — FactsMemory store with embeddings (FR-3, OQ-2)  `src/memory_facts.js` (NEW)
- [ ] Add dep `@xenova/transformers@2.17.2` to `package.json`.
- [ ] RED: `tests/memory_facts.test.js` — **mock `@xenova`** (deterministic bigram embeddings, mirror `expense-tracker/tests/memory.test.js`): semantic search ranking, add+dedup, persistence to temp `MEMORY.md`, independence from `mappings.json`, substring fallback when model fails.
- [ ] GREEN: port expense `src/memory.js` as `memory_facts.js`, exporting class `FactsMemory` (semantic cosine via `@xenova`, substring fallback retained). Configure `env.cacheDir = TRANSFORMERS_CACHE || '/app/.models'`, `allowRemoteModels = true`. Drop expense-specific migration helpers not needed.
- [ ] Wire `PORTFOLIO_MEMORY_PATH` (default `data/MEMORY.md`) into `src/config.js`.
- **AC:** FR-3. **Regression:** existing `memory.js`/`learn_mapping` untouched.

## Task 2 — PDF extractor rewrite (FR-1)  `src/pdf_extractor.js`
- [ ] RED: `tests/pdf_extractor.test.js` — unencrypted → text via pdftotext; `Test@123` → text; wrong pw → `[PDF_ENCRYPTED]`; no-text unencrypted → OCR fallback marker; temp cleanup.
- [ ] GREEN: implement `extractPdfText(bytes, password=null)`:
  - write temp `.pdf`; if `password` → `execFile("qpdf", ["--password="+pw, "--decrypt", in, dec])` then `execFile("pdftotext", ["-layout", dec, out])`.
  - else `pdftotext -layout`; on empty → OCR fallback (existing pdf2pic/tesseract).
  - classify qpdf password errors → `[PDF_ENCRYPTED]`; other → `[PDF_EXTRACTION_ERROR]`.
  - always `unlink` temp files.
- [ ] Keep `extractPdfTextFromFile` working.
- **AC:** FR-1.

## Task 3 — Email handler password + sentinels (FR-2)  `src/email_handler.js`
- [ ] RED: `tests/email_handler.test.js` — build encrypted-PDF email (port `buildEncryptedEmail`); no pw → contains `[PDF_ENCRYPTED]`; correct pw → no sentinel; non-PDF + unencrypted unchanged.
- [ ] GREEN: `extractEmailContent(raw, password=null)`; pass `password` to `extractPdfText`; **remove** the `!pdfText.startsWith("[PDF_OCR_")` suppression (line ~69) so sentinels surface.
- **AC:** FR-2. **Regression:** orchestrator's password-less call now surfaces sentinel for LLM (intended).

## Task 4 — Tools: memory + password passthrough + redaction (FR-4, FR-6 redaction)  `src/tools.js`
- [ ] RED: `tests/tools.test.js` — `search_memory`/`learn_fact` dispatch over FactsMemory; `extract_pdf_text`/`extract_email_content` accept+forward `password`; log output redacts password.
- [ ] GREEN:
  - constructor: accept `factsMemory`; store on registry.
  - schemas: add `search_memory`, `learn_fact`; add optional `password` to `extract_email_content` + `extract_pdf_text`.
  - dispatch: `case "search_memory"` → `{results: await factsMemory.search(query)}`; `case "learn_fact"` → `factsMemory.add(fact)`; pass `password` into extractors.
  - redact `password` in any tool-exec logging.
- **AC:** FR-4, FR-6(redaction).

## Task 5 — Prompt workflow (FR-5)  `src/prompts.js`
- [ ] RED: `tests/prompts.test.js` (or extend) — `SYSTEM_PROMPT` includes encrypted-PDF rule, `search_memory`, `learn_fact`, single-keyword guidance.
- [ ] GREEN: add PASSWORD-PROTECTED PDF section (adapted from expense `statement/prompts.js`), emphasizing single-keyword queries (broker name / "password") due to substring search; keep existing rules + few-shot.
- **AC:** FR-5.

## Task 6 — Wiring (FR-3/FR-4)  `src/index.js`, `src/mcp-server.js`
- [ ] GREEN: `index.js` instantiate `FactsMemory(cfg.portfolioMemoryPath)`; pass to `ToolRegistry`.
- [ ] GREEN (OQ-1, if approved): `mcp-server.js` register `search_memory`/`learn_fact` (descriptions say "portfolio"); add HTTP routes if matching existing pattern.
- **AC:** FR-3/FR-4. **Regression:** registry constructor change is backward-default-safe.

## Task 7 — Image + env (FR-6, OQ-2)  `docker/Dockerfile`, `.env.example`
- [ ] GREEN: add `qpdf` to `apt-get install` line (next to `poppler-utils`).
- [ ] GREEN: bake the embedding model into the image — set `ENV TRANSFORMERS_CACHE=/app/.models` and pre-download `Xenova/all-MiniLM-L6-v2` during build (node one-liner after `npm install`) for offline-safe runtime.
- [ ] Document `PORTFOLIO_MEMORY_PATH` + `TRANSFORMERS_CACHE` in `.env.example`; ensure `data/MEMORY.md` is git-ignored.
- **AC:** FR-6(image).

## Task 8 — Verify (NFR-1)
- [ ] `npm test` full suite green (new + existing).
- [ ] Manual: simulate `extractEmailContent(encEmail)` → `[PDF_ENCRYPTED]`; with `Test@123` → text (validates qpdf+pdftotext locally — requires qpdf installed in the test/dev env or run in container).
- [ ] Self-review diff for accidental comment removal / scope creep.

---

## Sequencing & checkpoints
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Review checkpoint after **Task 3** (decryption + sentinels working) and after **Task 6** (tools+prompt wired). No push without approval (Rule 5). No `Chart.yaml` in repo → Rule 8 N/A.

## Risks
- Local/dev test env lacks `qpdf` (confirmed) → decryption integration tests must run where qpdf exists (container or installed dev dep). Unit/logic tests run anywhere.
- Substring memory brittleness → mitigated by prompt (single-keyword) + tests asserting the guidance.
