QUESTIONS
q: Where does the daily error come from? | a: `ToolRegistry._exportTaxonomiesToSheet` in `modules/portfolio-tracker/src/tools.js` pushes `No cell mapping for '<classification>'` for any taxonomy value missing from `TAXONOMY_SHEET_MAPPING`. PP-CLI emits a `Without Classification` residual for unassigned holdings (`PpClient.java:529`), and the live mapping has no cell for it, so the export ends `partial` every day.
q: Classify the holdings in the PP file, or skip the residual? | a: Skip it. The rest of tools.js already treats `Without Classification` as the residual rather than a classification: the summary excludes it (tools.js:1249, 1372), and the MCP tool description says it means illiquid assets. Darren approved "fix the mapping for Without Classification" (nightly decision 2, 2026-10-29).
q: Should the cron also stop reporting `ok` when a step fails? | assumption: out of scope. That is the cron wrapper's status handling, not this export; it stays open on #81 as a follow-up.
q: What is wrong with the mapping docs (#4)? | a: `specs/003-portfolio-tracker/spec.md:378` documents `key1=cell1,key2=cell2`, but `src/config.js` splits each pair on the first colon. The docs are corrected to `key1:cell1,key2:cell2`.

# Plan: skip the Without Classification residual in the taxonomy export (issues #81, #4)

## Change

1. In `_exportTaxonomiesToSheet`, `continue` past a value of `"Without Classification"` before the FX conversion and cell lookup, with a comment naming #81.
2. In `specs/003-portfolio-tracker/spec.md`, change the documented `TAXONOMY_SHEET_MAPPING` format to `key1:cell1,key2:cell2`.

## Tests

New `modules/portfolio-tracker/tests/taxonomy-export.test.js`, with the PP bridge, FX rates and the Sheets write mocked:
- A taxonomy holding `Equity` (mapped) and `Without Classification` ends `completed`, writes only `Equity`, and reports no error. This fails at base.
- An unmapped real classification (`Bonds`) still reports `No cell mapping for 'Bonds'`.

The portfolio-tracker vitest suite runs in a throwaway `node:22-slim` container.
