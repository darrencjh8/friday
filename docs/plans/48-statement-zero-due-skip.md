QUESTIONS
q: Which code path produced the "transactions are in a linked image" reply? | a: The intake journal shows the email dispatched as `statement` to the expense-tracker, which returned `action: completed` with the LLM's text. That is `StatementProcessor.processStatement` in `modules/expense-tracker/src/statement/orchestrator.js`; the user-facing Telegram text comes only from `notify_user` messages (`intake/notify.py` `result_text`).
q: Should the zero-due case send nothing, or a short notice? | a: A short notice. The user chose "just inform the statement arrived with 0.00", so every statement still leaves a visible trace.
q: Is this specific to one issuer? | a: No. It is generic across issuers; no sender-specific code.
q: How is "no PDF attachment" detected? | assumption: By scanning the raw email for `application/pdf` or a `.pdf` filename. A false "has PDF" only falls back to the existing LLM flow, so the check is deliberately conservative.
q: Which "zero due" phrasings count? | assumption: A label containing `due` (for example `Total Due`, `Total Amount Due`, `Payment Due`, `Minimum Due`) followed within a few characters by an optional currency marker and an amount that is exactly zero (`0`, `0.00`). `0.50` or `10.00` must not match. Any other phrasing falls back to the LLM flow, which is today's behaviour.

## Problem

A statement email whose body is only a summary (zero amount due, a due date) and carries no PDF still goes through LLM reconciliation. With nothing to reconcile, the model asks the user to upload statement details, which is noise. Issue #48.

## Change surface

- `modules/expense-tracker/src/statement/orchestrator.js`: a small exported helper `zeroDueSummary(raw, text)` that returns `{ amount, dueDate }` when the raw email has no PDF and the extracted text declares a zero amount due, otherwise `null`. In `processStatement`, after content extraction and before the LLM loop: when it returns a summary, call `notify_user` with one line (`Statement email arrived: <amount> due[, due date <date>]. No PDF attached, nothing to reconcile.`), mark the email read only when the notice was delivered (same rule as the existing error paths), and return `{ action: "completed", details: <notice> }` without calling the LLM.
- `modules/expense-tracker/tests/statement/orchestrator.test.js`: new tests below.

Everything else is unchanged: statements with a PDF, a non-zero amount, encrypted PDFs, and the LLM loop itself.

## Test command and scope

Run in a throwaway `node:22-slim` container (the host has no npm), from the worktree root:

`docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/w -v <installed node_modules>:/w/modules/expense-tracker/node_modules -w /w/modules/expense-tracker node:22-slim npx vitest run tests/statement/orchestrator.test.js`

New tests (in a `describe("zero-due statements")` block), red at base because `zeroDueSummary` does not exist and the LLM is still called:
- `skips the LLM and notifies when no PDF and total due is zero`: text `Total Due: RM0.00 Due Date: 24/10/2026`, raw email with no PDF part → LLM `chat` never called, `notify_user` called once with a message containing `RM0.00` and `24/10/2026`, `mark_email_read` called, result action `completed`.
- `uses the LLM when a PDF is attached`: same text, raw email with an `application/pdf` part → LLM called.
- `uses the LLM when the amount due is not zero`: `Total Due: RM0.50` and `Total Due: RM10.00` → LLM called.
- `does not mark read when the notice fails`: `notify_user` returns false → `mark_email_read` not called.

Full expense-tracker suite runs once at the tests gate for regressions.

## Constraints

- Public repository: fixtures use synthetic data only (no names or account numbers).
- No change to classification, intake, or prompts.
