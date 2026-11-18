QUESTIONS
q: What did the router actually return on the failing turn after the summary — empty output_text, a reasoning-only output, or status incomplete? | assumption: The fix does not depend on the exact payload. The post-summary handling covers any post-summary LLM failure, and the closing turn after a sent summary is legitimately empty. Build-time check: read the `llm_route_failed` events around 2026-11-17 09:31 UTC from the production log (via the nightly maintenance run, which has log access) and confirm the router returned an empty stop, not a payload the code should have mapped.
q: Does DeepSeek require reasoning_content on every assistant turn in history, or only tool-call turns? | assumption: Preserve it on every rebuilt assistant turn, so the fix holds either way; and disable thinking on the fallback whenever a tool-call turn still lacks it, which covers router-originated history where no reasoning exists at all.
q: Does the DeepSeek fallback accept thinking disabled? | a: Yes. The accepted set (adaptive, enabled, disabled) is quoted from a captured production error in the code comment at modules/expense-tracker/src/orchestrator.js, and `reasoning: "disabled"` is already tested to suppress thinking (tests/orchestrator.test.js, "LLMClient truncation and reasoning-disabled handling").
q: Should a run that already delivered the summary report completed when its closing turn fails? | a: Yes — "delivered the summary" means the `notify_user` call that follows a successful `record_statement` or a `fetch_statement_history` hit (a prior record), the two prompt paths whose notify is the terminal summary. The user's visible outcome is done, the email is marked read either way, and today no retry happens (dispatchEmail in src/classify.js ignores the result), so returning completed with a warning in details is the honest journal record (completed maps to PROCESSED in src/processing.js) and it stops the confusing second message.
q: Is PR #264 merged when the build starts? | assumption: No. Build from current main; rebase onto main at build time if #264 has landed, and keep its redactSensitive() call intact — it touches different lines of the same file, so no conflict is expected.

# Plan: statement run must not fail after the summary was sent (#265)

Tracking issue: #265. Kind: bug.

## Root cause

Two independent defects combined in one run (2026-11-17 09:31 UTC, Affin Bank statement; summary sent via `notify_user` at 09:31:39, then the next LLM turn failed on both routes):

1. **DeepSeek fallback 400.** `StatementProcessor` rebuilds each assistant turn as `{role, content, tool_calls}` (`modules/expense-tracker/src/statement/orchestrator.js`, the loop in `processStatement`) and drops `reasoning_content`. It also pushes two assistant messages when a turn has both content and tool calls. Turns that came from the router (`auto-thinking` via the Responses API) never have reasoning to preserve at all — `fromResponses` (`src/llm-responses.js`) drops reasoning items. The final fallback route (direct DeepSeek, `thinking: {type: "adaptive"}`) then rejects the history with `400 The reasoning_content in the thinking mode must be passed back to the API`.
2. **Post-summary failure reported as failure.** After the summary `notify_user` succeeds, the loop makes one more `chat()` call. When it throws (here: both routes failed — the router returned an empty `stop`, which `LLMClient.chat` throws as truncated), the `catch` in `processStatement` logs `statement_processing_failed`, sends a second `notify_user` ("Failed processing statement..."), and returns `error` — even though reconciliation is done and the user was already told. The email is marked read either way.

## Change

- `modules/expense-tracker/src/statement/orchestrator.js` (`StatementProcessor.processStatement` only):
  - Push a single assistant message per turn — `{role, content, tool_calls, reasoning_content}` with each key present only when the response carried it — instead of the current content-only push plus a second tool-calls push. This preserves `reasoning_content` and removes the duplicated assistant message in one edit of the same lines.
  - Track a `summarySent` flag with a strict discriminator: set it only when a `notify_user` tool call follows a successful `record_statement` (the prompt's step 7 order) or a `fetch_statement_history` hit (a prior record — the already-processed path, prompt rule 4). The password-ask and extraction-error notifies have neither predecessor, so a failure after one of those still takes the error path below — correct, because nothing was reconciled. Capture the summary `args.message` when setting the flag; the completed `details` is that summary text plus the post-summary failure. In the `catch`, when the flag is set: log a warning event, mark the email read, and return `{action: "completed", details: <summary text + post-summary failure>}` — no second notification, no `error`. Apply the same guard to the max-iterations path: if the summary was already sent, return completed with a warning instead of sending the "exceeded maximum iterations" notice. When the flag is not set, both paths behave exactly as today. (The flag does not check the `notify_user` return value: `_handle_notify_user` returns true even when the 1h cooldown suppresses the send, so truthy does not prove delivery — the `record_statement`/history-hit predecessor is the discriminator, not the return.)
- `modules/expense-tracker/src/orchestrator.js` (`LLMClient.chat` only):
  - On a DeepSeek route, when the message history holds an assistant turn with `tool_calls` but no `reasoning_content`, send that call with `thinking: {type: "disabled"}` instead of adaptive. This is the only fix that covers router-originated history, where there is no reasoning to pass back. When the history carries reasoning, thinking stays adaptive, so the direct-DeepSeek primary path keeps its current behaviour. Do not pass `reasoning: "disabled"` from the statement orchestrator — that would also disable thinking on the primary router route, and the statement code cannot know which route `chat()` is on; the route-aware decision belongs in `LLMClient.chat`, which already branches per route.

## Tests

- `modules/expense-tracker/tests/statement/orchestrator-265.test.js` (written, RED at base 3feed05, recorded with `loop.py repro`):
  - `tests.statement.orchestrator-265.post-summary-failure`: turn 1 returns tool_calls [`record_statement` (mock returns `{id, status: "recorded"}`), `notify_user` with the summary]; turn 2 `chat()` rejects with "All LLM routes failed" → exactly one `notify_user`, result `completed`, details contain the summary text, email marked read.
  - `tests.statement.orchestrator-265.mid-run-notify-still-errors` (guard, green at base): turn 1 returns only `notify_user` (password-ask, no `record_statement` or history hit); turn 2 `chat()` rejects → result `error`, two `notify_user` calls (the ask + the failure notice). Pins the H1 distinction: a mid-run notify is not a summary.
  - `tests.statement.orchestrator-265.reasoning-content-preserved`: an assistant turn carrying `reasoning_content` + `tool_calls` → the rebuilt history passed to the next `chat()` carries the same `reasoning_content` on the tool-call turn.
- Add to the same file: max-iterations after a successful summary notify returns completed with no second notice; a content-only assistant turn keeps its `reasoning_content` too.
- Add to `modules/expense-tracker/tests/orchestrator.test.js`, next to the existing "LLMClient truncation and reasoning-disabled handling" tests (mock `chat.completions.create`, two routes configured): fallback sends `thinking: {type: "disabled"}` when history has a tool-call turn without `reasoning_content`, and sends adaptive thinking when the history carries it.
- Run the touched files locally (`npx vitest run` in `modules/expense-tracker`); the full suite runs in CI, which is the test runner here. The `expense-tracker` CI job must be green — the change touches the shared `LLMClient` fallback, so the transaction-pipeline tests in `tests/orchestrator.test.js` staying green is part of the gate.

## Not in scope

- Relaxing the `LLMClient` truncated/empty-response check. It is shared with the transaction pipeline, which relies on the throw for outage classification; the statement-side fix is narrower.
- Surfacing router reasoning items through `fromResponses`. No evidence the empty stop came from a reasoning-only output, and the post-summary handling covers it whatever the payload was.
- Retrying the statement, re-sending the summary, or any production edit or log access from this VM (verification goes through the nightly maintenance run).
- PR #264's redaction (sibling fix, same file). Do not duplicate it; rebase onto main if it lands first and keep its `redactSensitive()` call intact.

## Delivery

Fix branch, PR to `main` with Darren as reviewer, all CI green on the head before presenting. Never merge — Darren merges.
