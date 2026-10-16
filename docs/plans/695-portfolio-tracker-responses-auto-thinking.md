QUESTIONS
q: Does the router still reject Chat Completions for auto-thinking? | a: Yes. #694 probed it live: 400 unsupported_endpoint_for_model; it is served on /v1/responses only.
q: Does portfolio-tracker reach the router today? | a: No. `DeepSeekClient` (modules/portfolio-tracker/src/orchestrator.js) calls api.deepseek.com/v1 directly with `deepseek-flash`; the compose block has only DEEPSEEK_API_KEY. Issue #695 said it already called the router; it does not. The owner confirmed the intent: it must use auto-thinking, so this change moves it there.
q: Does direct DeepSeek support Responses? | assumption: No; it stays on chat.completions as the final fallback, same as expense-tracker (#694).
q: Can portfolio-tracker import the expense-tracker mapping? | a: No. Each module builds from its own Docker context (modules/docker-compose.yml), so the small mapping file is copied rather than shared.
q: Is the LLM API key available to the container? | a: Yes. deploy.yml already exports LLM_PROVIDER, LLM_BASE_URL, LLM_MODEL, LLM_API_KEY and LLM_REASONING_EFFORT to the compose environment for expense-tracker; portfolio-tracker's compose block just does not forward them.
q: Is a production edit needed? | assumption: No. Ship by PR and the CI deploy only.

# Plan: portfolio-tracker LLM client on the router's Responses API (#695)

Tracking issue: #695. Kind: bug.

## Root cause
The tracker's only LLM client, `DeepSeekClient`, is hard-wired to direct DeepSeek on Chat Completions. It never uses auto-thinking, so it ignores the router, and its sole route has no fallback: a DeepSeek failure (for example the 402 Insufficient Balance seen in the expense tracker during #694) fails the whole email.

## Change
- `src/llm-responses.js` (new): `toResponsesInput`, `toResponsesTools`, `toResponsesToolChoice`, `fromResponses`, copied from `modules/expense-tracker/src/llm-responses.js` (separate Docker contexts). Truncated or empty answers throw, so the next route is tried.
- `src/orchestrator.js`: rename `DeepSeekClient` to `LLMClient`. Routes: the router (`llmBaseUrl`, `llmModel`, key `llmApiKey || deepseekApiKey`) via `client.responses.create` with `reasoning: { effort }`, then direct DeepSeek (`deepseek-flash`) via `chat.completions` with the existing `thinking`/temperature kwargs. The existing per-route retry and 60 s timeout stay (router 3 tries, DeepSeek 1 try). When every route fails, one error names each route and its message.
- `src/config.js`: `llmBaseUrl` (default `http://codex-router:4100/v1`), `llmModel` (`auto-thinking`), `llmApiKey`, `llmReasoningEffort` (`low`). `DEEPSEEK_API_KEY` stays required as the fallback key.
- `modules/docker-compose.yml`: forward `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_REASONING_EFFORT` to portfolio-tracker with the same defaults expense-tracker uses.
- Docs: `modules/portfolio-tracker/README.md` and the root `README.md` / `docs/architecture.md` LLM labels say the orchestrator uses the router, with DeepSeek as fallback.

## Tests
`tests/llm-responses-695.test.js` (written, RED at base): config defaults, Responses transport for the router, tool mapping both ways, DeepSeek fallback on chat, truncated router answer falls through, aggregated error. `tests/orchestrator.test.js` is updated for the rename (`LLMClient`) and the new transport. Node tests run in a throwaway `node:22-slim` container.

## Not in scope
Outage retry/cooldown semantics (the portfolio IMAP path already notifies the user on an `error` result), router changes, any production edit.
