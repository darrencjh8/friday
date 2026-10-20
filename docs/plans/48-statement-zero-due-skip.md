QUESTIONS
q: Which code path produced the "transactions are in a linked image" reply? | a: The intake journal shows the email dispatched as `statement` to the expense-tracker, which returned `action: completed` with the LLM's text. That is `StatementProcessor.processStatement` in `modules/expense-tracker/src/statement/orchestrator.js`; the user-facing Telegram text comes only from `notify_user` messages (`intake/notify.py` `result_text`).
q: Should the zero-due case send nothing, or a short notice? | a: A short notice. The user chose "just inform the statement arrived with 0.00", so every statement still leaves a visible trace.
q: Is this specific to one issuer? | a: No. It is generic across issuers; no sender-specific code.
q: How is "no PDF attachment" detected? | assumption: By scanning the raw email for `application/pdf` or a `.pdf` filename. A false "has PDF" only falls back to the existing LLM flow, so the check is deliberately conservative.
q: Which "zero due" phrasings count? | assumption: Conservative, all-or-nothing. The helper collects every amount that follows a `due` or `balance` label within a few non-digit characters (labels followed by `date`, such as `Due Date`, are not amounts). It returns a summary only when (a) at least one label is a total-type label (`Total Due`, `Total Amount Due`, `Amount Due`, `Total Payment Due`, `Statement Balance`, `New Balance`, `Outstanding Balance`), and (b) every collected amount is exactly zero (`0`, `0.00`, `0,00`, with an optional currency marker such as `RM`, `SGD`, `S$`, `$`). Any non-zero due or balance amount anywhere (for example `Past Due: RM0.00 ... Total Due: RM1,500.00`) means no summary and the existing LLM flow runs. Multiple matches are therefore resolved by requiring all of them to be zero.
q: What if the notice cannot be delivered? | a: Same as the existing failure paths: the email is not marked read and the result is `{ action: "error" }` so it is not journaled as a success and the caller can retry.

## Problem

A statement email whose body is only a summary (zero amount due, a due date) and carries no PDF still goes through LLM reconciliation. With nothing to reconcile, the model asks the user to upload statement details, which is noise. Issue #48.

## Change surface

- `modules/expense-tracker/src/statement/orchestrator.js`: a small exported helper `zeroDueSummary(raw, text)` that returns `{ amount, dueDate }` when the raw email has no PDF and the extracted text declares a zero amount due, otherwise `null`. In `processStatement`, after content extraction and before the LLM loop: when it returns a summary, call `notify_user` with one line (`Statement email arrived: <amount> due[, due date <date>]. No PDF attached, nothing to reconcile.`), and never call the LLM. When the notice was delivered: mark the email read and return `{ action: "completed", details: <notice> }`. When it was not: do not mark read and return `{ action: "error", details: "zero-due statement notice not delivered" }`, matching the existing failure paths.
- `modules/expense-tracker/tests/statement/orchestrator.test.js`: new tests below.

Everything else is unchanged: statements with a PDF, a non-zero amount, encrypted PDFs, and the LLM loop itself.

## Test command and scope

Run in a throwaway `node:22-slim` container (the host has no npm), from the worktree root:

`docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/w -v <installed node_modules>:/w/modules/expense-tracker/node_modules -w /w/modules/expense-tracker node:22-slim npx vitest run tests/statement/orchestrator.test.js`

New tests (in a `describe("zero-due statements")` block), red at base because `zeroDueSummary` does not exist and the LLM is still called:
- `skips the LLM and notifies when no PDF and total due is zero`: text `Total Due: RM0.00 Due Date: 24/10/2026`, raw email with no PDF part → LLM `chat` never called, `notify_user` called once with a message containing `RM0.00` and `24/10/2026`, `mark_email_read` called, result action `completed`.
- `omits the due date clause when none is present`: `Total Amount Due: SGD 0.00` → notice has no `due date` clause.
- `does not mark read and returns error when the notice fails`: `notify_user` returns false → `mark_email_read` not called, action `error`, LLM not called.
- `uses the LLM when a PDF is attached`: same text, raw email with an `application/pdf` part → LLM called; also a part with `application/octet-stream` and `filename="statement.pdf"` → LLM called.
- Table-driven `zeroDueSummary` cases returning `null` (LLM path): `Total Due: RM0.50`, `Total Due: RM10.00`, `Total Due: RM1,000.00`, `Total Due: RM0.001`, `Past Due: RM0.00 Total Due: RM1,500.00`, `Minimum Due: RM0.00 Total Due: RM250.00`, `Minimum Due: RM0.00` alone (no total-type label), and text with no due label at all.
- Table-driven cases returning a summary: `Total Due: RM0.00`, `Amount Due: $0`, `Statement Balance: 0,00`, `Total Due: RM0.00 Minimum Due: RM0.00 Due Date: 24/10/2026`.

Full expense-tracker suite runs once at the tests gate for regressions.

## Constraints

- Public repository: fixtures use synthetic data only (no names or account numbers).
- No change to classification, intake, or prompts.
