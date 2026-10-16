QUESTIONS
q: Does the live router still accept Chat Completions for auto-thinking? | a: No. A live probe returned 400 unsupported_endpoint_for_model; it is served on /v1/responses only (the deployed codex-router build, router/surfaces.py SHIM_SURFACES, plus the live probe).
q: Does direct DeepSeek (final fallback) support Responses? | assumption: No; api.deepseek.com/v1 stays on chat.completions, so only non-deepseek routes move to Responses.
q: Is portfolio-tracker affected too? | a: Yes, modules/portfolio-tracker/src/orchestrator.js:37 uses chat.completions. Out of scope here; follow-up issue #695.
q: What about uid 1069 already in the 12h cooldown? | assumption: After the CI deploy, the operator deletes that single processed_uids row (or waits for the cooldown to end at about 09:32 UTC); no production edit is made by this change.
q: Should an LLM outage notify the user on every retry? | assumption: No. One notice per uid per process run; later retries log only.

# Plan: expense-tracker LLM client on Responses, retryable LLM outage (#694)

Tracking issue: #694. Kind: bug.

## Root causes
1. `LLMClient.chat` and `classify.js` call `chat.completions.create` against `auto-thinking`, which the router now serves on Responses only (400 on every call).
2. `_runPhase1` turns every provider error into `null`, reported as "Couldn't understand".
3. `imap.js` calls `recordProcessed(uid)` for every callback result, so an unread email enters the 12h `RETRY_COOLDOWN_MINUTES` (#592) after an outage and cannot recover.
4. The retired `gpt-5.6-terra` fallback is still the default (`config.js`, `docker-compose.yml`, `deploy.yml`), and `chat()` keeps only the last route's error.

## Change
- `src/llm-responses.js` (new, small): `toResponsesInput(messages)`, `toResponsesTools(tools, toolChoice)`, `fromResponses(response)` mapping to and from the chat-completion shape the orchestrator already consumes, so no caller changes.
- `orchestrator.js` `LLMClient.chat`: routes with `provider !== "deepseek"` call `client.responses.create` (`reasoning: { effort }`, no temperature); the DeepSeek route is unchanged. Request mapping details: effort comes from `this._reasoningEffort` and the `reasoning` field is omitted when `opts.reasoning === "disabled"`, as on the chat path; `function_call` items carry `call_id` only (no item `id`) and `function_call_output` reuses it; `tool_calls[].id` is set from `call_id`. `fromResponses` sets `finish_reason` to `tool_calls` when the output holds a function call, `length` when `status` is `incomplete`, otherwise `stop`, so the existing truncation check still applies. When every route fails, `chat()` throws one error naming each route, model and error. Discriminator, by mechanism: the truncated, incomplete, empty-output and mapping errors are tagged `deterministic = true` at their throw sites. The error is an `LLMUnavailableError` only when at least one route's error is untagged and is outage-shaped: a numeric `err.status` (the OpenAI SDK `APIError`, including 400/402/429/5xx), `err instanceof OpenAI.APIConnectionError` (which covers `APIConnectionTimeoutError`), or the local `Error("timeout")`. Every other error, including a `TypeError` from `fromResponses`, is non-outage and keeps today's null result and 12h cooldown. Tests: one per shape (status 402, `APIConnectionError`, local timeout, truncated response, mapping `TypeError`) and a mixed truncated-plus-402 case classified as outage.
- `classify.js` uses the same helpers, caps output with `max_output_tokens: 16` (a 5-token cap can be consumed by reasoning) and moves the DeepSeek final-fallback route out of the `llmFallbackModel` guard to mirror `LLMClient`, so an empty fallback model never removes it.
- `LLMUnavailableError` is the only discriminator. The Phase-1 attempt-loop catch and `_llmExtractMovement` rethrow it immediately with no retry; every other error (tool exception, validation) keeps today's behaviour and still yields `null`. `_processEmailInternal` catches it, notifies once per uid per process, and returns `{ action: "llm_unavailable" }`. To bound a deterministic 4xx poison email (for example an oversized body rejected by every route), the orchestrator counts consecutive `llm_unavailable` results per uid in memory; after 12 it returns the ordinary `notified` result so the 12h cooldown applies. A test pins that cap. `processText` (Telegram) and the `process_email_error` path keep reporting an error to the user, as today.
- `dedup.js` `recordProcessed(uid, retryAfterMinutes)` back-dates the row so the existing cooldown ends after `retryAfterMinutes`; `imap.js` passes 5 for `llm_unavailable` and never marks the message read or booked.
- Config: `LLM_FALLBACK_MODEL` defaults to empty (route skipped); drop `gpt-5.6-terra` from `docker-compose.yml` and `deploy.yml`.
- Docs: `README.md` diagram label and `docs/architecture.md` state the expense tracker uses Responses to the router; `modules/expense-tracker/docs/design.md` LLM section.

## Tests
`tests/llm-responses-outage-694.test.js` (already written, RED at base): Responses transport, tool mapping, DeepSeek fallback stays on chat, terra default removed, aggregated errors, `llm_unavailable` result, short retry cooldown, IMAP loop uses it. Added cases: a tool exception still yields `null` (not `llm_unavailable`), an all-routes-truncated failure yields `null` (not `llm_unavailable`), the `finish_reason` mapping, and the classify fallback with an empty fallback model. Existing tests updated for the new transport and default: `tests/gpt56-router-contract.test.js`, `tests/config.test.js:52`, `tests/classify.test.js` (mocks `responses.create` for the router route), `modules/tests/test_deploy_workflow_router.py:58,76`. `.env.example:52` drops the terra value. Run vitest in a throwaway `node:22-slim` container.

## Not in scope
portfolio-tracker (#695), the statement path (`src/statement/orchestrator.js:102`, `src/tools.js:1994`; both only gain the new error type, caught by their existing general catches, and keep the 12h cooldown), router changes, any production edit.
