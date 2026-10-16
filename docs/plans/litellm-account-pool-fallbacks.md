# LiteLLM Account-Pool Fallback Rollout

## Status: historical

The pooled GPT aliases below are no longer referenced by any Hermes slot. Current
routing lives in `docs/plans/hermes-deepseek-flash-routing.md`; this document records
how the account pools were introduced. The Terra and Luna aliases are retired repo-wide:
no Hermes slot and no `expense-tracker` default (#694) references them any more;
the only remaining mentions are retirement notes and test fixtures.

## Goal

Route Hermes primary model calls through the Docker-hosted LiteLLM router while using ordered OpenAI subscription account pools. Use direct `deepseek-flash` only after the relevant LiteLLM pool is exhausted or unavailable. (At the time, `auxiliary.vision` was the exception: it called `deepseek-flash` directly with no pool route and no fallback. It now routes through codex-router like every other slot.)

## Required routing

> Historical: the section below describes the pool rollout as it was planned. No
> Hermes slot uses these aliases today, and `auxiliary.vision` is no longer
> direct-only. See `hermes-deepseek-flash-routing.md` for the live contract.

### Terra pool

```text
gpt-5.6-terra (router selects account 3 -> 2 -> 1)
```

Use for Hermes main chat, approval, and the `code-reviewer` profile. (Vision no longer uses this pool: it routes through codex-router on the Command Code DeepSeek Flash model. The `code-reviewer` profile no longer uses it as a primary either — it runs the Command Code route and reaches this pool only as a fallback.)

### Luna pool

```text
gpt-5.6-luna (router selects account 3 -> 2 -> 1)
```

Use for compression, delegation, triage specification, profile description, and the Project Manager profile.

### Sol

```text
gpt-5.6-sol
```

Use for the Architect profile. Its fallback is direct `deepseek-flash`.

### Direct fallback

```text
deepseek-flash
```

DeepSeek is the final direct fallback after the applicable LiteLLM route fails.

## Phase 1: codex-router

1. Inspect the router's generated LiteLLM configuration path.
2. Add LiteLLM `router_settings.fallbacks`:
   - Terra-3 -> Terra-2 -> Terra-1
   - Luna-3 -> Luna-2 -> Luna-1
3. Keep account-specific models individually addressable.
4. Add regression tests for generated fallback configuration and ordering.
5. Validate generated configuration and test each pool through the router's OpenAI-compatible endpoint.

## Phase 2: friday

> Historical: steps 2-3 describe the pool rollout as it was planned and no longer
> match the live config. Steps 1 and 4-6 (the router endpoint, the `code-reviewer`
> profile, the kanban assignee, and the `.codex/` ignore rule) still hold.

1. Keep Hermes primary roles pointed at `http://codex-router:4100/v1`.
2. Use transparent pooled aliases (`gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6-sol`) so LiteLLM selects the account and handles intra-pool fallback; keep exactly one direct `deepseek-flash` fallback per primary/profile route, except `auxiliary.vision`, which is direct-only.
3. Configure `auxiliary.compression.fallback_chain` to direct `deepseek-flash` after LiteLLM Luna-pool exhaustion.
4. Replace `static-analyst` with persistent `code-reviewer`; remove `qa-engineer` and `quality-assurance` from source and startup runtime state.
5. Keep `kanban.default_assignee` set to `code-reviewer`.
6. Keep generated `.codex/` metadata ignored.

## Verification

1. Router health endpoint succeeds.
2. Router model catalog includes all Terra/Luna account models.
3. Router tests prove ordered fallback configuration.
4. Hermes YAML and startup shell tests pass.
5. No direct production restart, rebuild, pull, Docker Compose command, or deployment is performed. Deployment occurs only through a reviewed PR and GitHub Actions.

## 2026-08-31 Responses transport rollout

Codex Router PR #17 marks every dynamically discovered ChatGPT model as LiteLLM `mode: responses` at the account-proxy, account-alias, and transparent pool-alias layers. This prevents unknown GPT-5.6 slugs from defaulting to the Cloudflare-blocked Chat Completions endpoint. The router repository's 42-test suite and skills-only installation test passed before merge. This documentation update intentionally drives the normal `friday` GitHub Actions deployment so the merged router revision is built and verified without direct production intervention.
