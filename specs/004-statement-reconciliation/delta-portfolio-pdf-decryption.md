# Delta Spec: Portfolio-Tracker Encrypted-PDF Statement Pipeline

**Parent Spec:** `004-statement-reconciliation/spec.md` (v3.0.0 — "PT pending")
**Delta Version:** 1.0.0
**Status:** Specifying (awaiting approval)
**GitHub Issue:** #88 (encrypted PDF statement processing pipeline)
**Module:** `modules/portfolio-tracker`
**Branch / Worktree:** `feat/portfolio-pdf-decryption` @ `../friday-portfolio-pdf`

---

## 1. Background & Motivation

The expense-tracker already decrypts and reconciles password-protected PDF statements
(`qpdf --decrypt` → `pdftotext`, password sourced from a semantic `MEMORY.md` fact store
via `search_memory`/`learn_fact`). The portfolio-tracker has **none** of this:

| Capability | expense-tracker | portfolio-tracker (today) |
|---|---|---|
| PDF text extraction | `pdftotext -layout` (machine-accurate) | OCR only (pdf2pic + tesseract.js) |
| Encrypted PDF decrypt | `qpdf --password=… --decrypt` | ✗ none, no `qpdf` in image |
| `[PDF_*]` sentinels surfaced to LLM | yes | ✗ suppressed (`email_handler.js:69`) |
| Password lookup | `search_memory` over `MEMORY.md` | ✗ no facts store, only `mappings.json` |
| Encrypted-PDF prompt workflow | yes (`statement/prompts.js`) | ✗ none |

### Verified facts (research + POC)
- **Decryption toolchain proven in prod**: expense container runs `qpdf 11.3.0` + `pdftotext 22.12.0`; prod logs show the identical `execFile` pipeline decrypting a real SC PDF. Portfolio container has `pdftotext` but **`NO_QPDF`**.
- **Memory search is substring in prod**: `@xenova/transformers` is NOT installed (prod or local), so `MemoryStore.search()` silently degrades to `_substringSearch`. POC confirmed: `search("IBKR")` and `search("password")` match a password fact; multi-word `search("ibkr estatement password")` returns 0 hits → **prompt must use single-keyword queries**.
- **Hermes namespacing**: MCP tools register as `mcp_<server>_<tool>`. Portfolio's `learn_fact`/`search_memory` become `mcp_portfolio_tracker_*`, distinct from `mcp_expense_tracker_*` → **no name collision**.
- **#110 is redundant**: `ibkr_flex.js` + `ibkr_parser.js` already ingest Trades / Dividends / Withholding Tax / Fees / Interest / CorporateActions via the Flex Web Service API (prod logs: `ibkr-flex-import trades_imported:1`). Structured IBKR **PDF** parsers add no coverage. **#110 dropped.**

### Scope note
IBKR data arrives via the Flex API; portfolio IMAP is currently **disabled** in prod. This pipeline therefore targets **non-IBKR brokers that email (often encrypted) PDF statements** (e.g. POEMS / CDP / CPF / bank brokerage), and brings the portfolio-tracker to capability parity with the expense-tracker for when IMAP is enabled or PDFs are handed to it (Telegram / MCP).

---

## 2. Goals / Non-Goals

### Goals
- G1: Portfolio-tracker can extract text from machine-generated PDFs accurately (`pdftotext`), not garbled OCR.
- G2: Portfolio-tracker can decrypt password-protected PDFs (`qpdf`), with the password sourced from a **separate** portfolio memory store.
- G3: The LLM is instructed how to operate the encrypted-PDF workflow (find password → retry → remember).
- G4: Zero regression to existing portfolio flows (IBKR Flex, PP sync, `learn_mapping`/`mappings.json`, MCP tools).

### Non-Goals
- N1: Structured IBKR PDF parsers (#110) — redundant, dropped.
- N3: Enabling portfolio IMAP in prod — config decision, out of scope of this code change.
- N4: Migrating the existing `mappings.json` store — left untouched (additive design).
- N5: Sharing/merging memory with expense-tracker — explicitly a **separate** store.

---

## 3. Functional Requirements

### FR-1 — `pdftotext`-primary extraction with `qpdf` decryption
`pdf_extractor.js` MUST extract text via `pdftotext -layout` as the primary path. When a
`password` is supplied it MUST first run `qpdf --password=<pw> --decrypt` on a temp file,
then `pdftotext` on the decrypted output. OCR (pdf2pic + tesseract.js) is retained only as
a last-resort fallback when `pdftotext` yields empty text on an unencrypted PDF.

**AC:**
- [ ] `extractPdfText(bytes)` (no password) returns machine-accurate text for an unencrypted PDF via `pdftotext`.
- [ ] `extractPdfText(bytes, password)` decrypts via `qpdf` then extracts via `pdftotext`.
- [ ] Wrong/missing password on an encrypted PDF rejects/returns a `[PDF_ENCRYPTED]` sentinel (never silent empty).
- [ ] Unencrypted PDF with no extractable text falls back to OCR; if OCR unavailable → `[PDF_OCR_UNAVAILABLE]`.
- [ ] Temp files (`*.pdf`, `*-dec.pdf`, `*.txt`) are always cleaned up, success or failure.
- [ ] Backward compatible: existing single-arg callers keep working.

### FR-2 — Password passthrough in email + PDF extraction, sentinels surfaced
`email_handler.js` `extractEmailContent(raw, password=null)` MUST accept an optional
password and pass it to the PDF extractor, and MUST **stop suppressing** `[PDF_*]`
sentinels so the LLM can react.

**AC:**
- [ ] `extractEmailContent(raw)` on an encrypted-PDF email returns text containing `[PDF_ENCRYPTED]`.
- [ ] `extractEmailContent(raw, correctPassword)` returns decrypted text with **no** `[PDF_ENCRYPTED]`.
- [ ] `[PDF_ENCRYPTED]` / `[PDF_EXTRACTION_ERROR]` / `[PDF_OCR_UNAVAILABLE]` are surfaced, not dropped (removes the `email_handler.js:69` suppression).
- [ ] Non-PDF emails and unencrypted-PDF emails behave exactly as before (regression guard).

### FR-3 — Separate portfolio facts/password memory store
Add a `FactsMemory` (ported from expense `memory.js`, `MEMORY.md`-backed, substring
fallback) **alongside** the existing `mappings.json` `MemoryStore`. New path
`PORTFOLIO_MEMORY_PATH` (default `data/MEMORY.md`). The existing `learn_mapping`/`recall`
flow is **unchanged**.

**AC:**
- [ ] New store reads/writes `data/MEMORY.md`; independent of `data/mappings.json`.
- [ ] `search(query)` returns matching facts (substring when `@xenova` absent, like prod).
- [ ] `add(fact)` persists and dedups; re-querying returns the new fact.
- [ ] Existing `learn_mapping`/`recall` against `mappings.json` continues to pass all current tests.

### FR-4 — New tools `search_memory` and `learn_fact`
Register two tools in the portfolio `ToolRegistry` (+ schemas, + dispatch) that operate on
the FactsMemory store, with descriptions clearly scoped to "portfolio".

**AC:**
- [ ] `search_memory({query})` → `{ results: [...] }` from FactsMemory.
- [ ] `learn_fact({fact})` → persists to `MEMORY.md`, returns `{added|skipped}`.
- [ ] Tool descriptions say "portfolio" to disambiguate from `mcp_expense_tracker_*` in Hermes.
- [ ] `extract_email_content` / `extract_pdf_text` schemas gain an optional `password` property; dispatch passes it through.

### FR-5 — Encrypted-PDF prompt workflow
Extend `prompts.js` `SYSTEM_PROMPT` with a PASSWORD-PROTECTED PDF rule mirroring expense,
adapted for substring search (single-keyword queries).

**AC:**
- [ ] Prompt instructs: on `[PDF_ENCRYPTED]` → `search_memory` with a **single keyword** (broker name, e.g. "POEMS", or "password") → retry `extract_pdf_text`/`extract_email_content` with password → scan email body for `password is X` → ask user → `learn_fact` on success.
- [ ] Prompt warns against multi-word memory queries (substring limitation).
- [ ] Existing prompt rules/few-shot examples remain intact.

### FR-6 — Image + redaction
`docker/Dockerfile` MUST install `qpdf`. Passwords MUST be redacted from tool-execution logs.

**AC:**
- [ ] Portfolio image contains `qpdf` (parity with expense).
- [ ] Tool logs never print the `password` argument value (redacted).

---

## 4. Non-Functional Requirements

- NFR-1 (No regression): all existing portfolio-tracker tests pass unchanged; IBKR Flex, PP sync, OneDrive, MCP, `learn_mapping` untouched.
- NFR-2 (Parity): decryption + memory behavior matches expense-tracker (proven prod code), minimizing novel risk.
- NFR-3 (Security): plaintext passwords confined to the portfolio `MEMORY.md` (separate blast radius from expense); redacted from logs; `MEMORY.md` git-ignored if it isn't already.
- NFR-4 (Deps): no mandatory new npm deps (`@xenova` stays optional); only system `qpdf` added.
- NFR-5 (Dormant-safe): with IMAP disabled, the change is inert at runtime until invoked via email/Telegram/MCP.

---

## 5. Impact / Regression Audit (files touched)

| File | Change | Regression risk | Mitigation |
|---|---|---|---|
| `src/pdf_extractor.js` | rewrite: pdftotext+qpdf primary, OCR fallback, `password` | extraction text differs vs OCR | new tests; OCR fallback kept |
| `src/email_handler.js` | `password` param; surface sentinels | sentinel now visible downstream | tests for non-PDF/unencrypted unchanged |
| `src/memory_facts.js` (NEW) | ported FactsMemory (`MEMORY.md`) | none (new file) | unit tests |
| `src/memory.js` | untouched | none | — |
| `src/tools.js` | +2 tools, +`password` schema/dispatch, log redaction | new switch cases only | tests; existing cases untouched |
| `src/prompts.js` | +encrypted-PDF rule | longer prompt | existing rules retained |
| `src/index.js` | instantiate FactsMemory, pass to registry | constructor arg add | default-safe |
| `src/mcp-server.js` | expose `search_memory`/`learn_fact` (optional) | new MCP tools | namespaced, no collision |
| `docker/Dockerfile` | `apt-get install qpdf` | image build | parity w/ expense |
| `tests/*` | new tests + fixture reuse (`test-protected.pdf`/`Test@123`) | — | — |
| `.env.example` | document `PORTFOLIO_MEMORY_PATH` | — | — |

**Untouched (verified safe):** `ibkr_flex.js`, `ibkr_parser.js`, `java_bridge.js`, `onedrive*.js`, `sheets_client.js`, `classify.js`, `dedup.js`, `orchestrator.js` (uses `extractEmailContent` — still works, password-less call surfaces sentinels which the LLM then handles).

---

## 6. Test Strategy (TDD)

Reuse the repo fixture `test-protected.pdf` (password `Test@123`) and expense's
`buildEncryptedEmail` helper pattern.

1. `tests/pdf_extractor.test.js` — unencrypted pdftotext; encrypted+correct pw; wrong pw → `[PDF_ENCRYPTED]`; OCR fallback path; temp cleanup.
2. `tests/email_handler.test.js` — `[PDF_ENCRYPTED]` surfaced without pw; decrypted with pw; sentinel no longer suppressed; non-PDF unchanged.
3. `tests/memory_facts.test.js` — search (substring), add/dedup, persistence, separation from `mappings.json`.
4. `tests/tools.test.js` — `search_memory`/`learn_fact` dispatch; `password` passthrough; log redaction.
5. Regression: run full `vitest run` — existing suites green.

---

## 7. Resolved Decisions

- **OQ-1 → Expose over MCP.** `search_memory`/`learn_fact` are registered in `mcp-server.js` as `mcp_portfolio_tracker_*` with descriptions scoped to "portfolio" (disambiguated from `mcp_expense_tracker_*`).
- **OQ-2 → Add real `@xenova` embeddings.** Portfolio FactsMemory uses `@xenova/transformers@2.17.2` (`Xenova/all-MiniLM-L6-v2`) for true semantic cosine search, with the substring path retained as fallback when the model can't load. This **diverges from prod expense** (which runs substring) and adds image weight (onnxruntime-web WASM + `sharp` + ~90MB model). Consequences:
  - Unit tests **mock** `@xenova` (deterministic bigram embeddings, like `expense-tracker/tests/memory.test.js`) → fast, offline.
  - The model is **baked into the Docker image** at build time (cached under `TRANSFORMERS_CACHE=/app/.models`) for offline-safe, deterministic runtime; remote download remains allowed as fallback.
  - Single-keyword prompt guidance becomes a soft hint (semantic search handles phrases), but is retained for the fallback path.
- **OQ-3 → Target use confirmed**: non-IBKR broker PDFs / Telegram / future IMAP (IBKR fully covered by Flex API).
