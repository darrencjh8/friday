# Hermes DeepSeek Flash Routing

## Status: historical

This plan proposed splitting DeepSeek fallbacks across tiered model names (a pro tier
for the hard routes, a flash tier for the light ones, and a separate vision model).
That split is retired: every DeepSeek fallback in Hermes uses the single canonical
model id `deepseek-flash`. See darrencjh8/darren-openclaw#428. The primary slots have
since moved again — auxiliary traffic now runs on the router's Command Code DeepSeek
Flash model, except the approval judge which keeps `auto-thinking`, and every profile
shares the `auto-thinking` pool — so the table below,
not the original proposal, is the current contract.

## Routing today

| Role | Primary | Fallback |
| --- | --- | --- |
| Main agent | codex-router / `auto-thinking` (reasoning high) | direct / `deepseek-flash` |
| Delegation | codex-router / `auto-thinking` | none (not supported) |
| Vision | codex-router / `commandcode/deepseek/deepseek-v4.1-flash` | direct / `deepseek-flash` |
| Web extract | codex-router / `commandcode/deepseek/deepseek-v4.1-flash` | direct / `deepseek-flash` |
| Compression | codex-router / `commandcode/deepseek/deepseek-v4.1-flash` | direct / `deepseek-flash` |
| Approval | codex-router / `auto-thinking` | direct / `deepseek-flash` |
| Kanban decomposer | codex-router / `commandcode/deepseek/deepseek-v4.1-flash` | direct / `deepseek-flash` |
| Triage specifier | codex-router / `commandcode/deepseek/deepseek-v4.1-flash` | direct / `deepseek-flash` |
| Profile describer | codex-router / `commandcode/deepseek/deepseek-v4.1-flash` | direct / `deepseek-flash` |
| architect profile | codex-router / `auto-thinking` | direct / `deepseek-flash` |
| code-reviewer profile | codex-router / `commandcode/deepseek/deepseek-v4.1-flash` (reasoning high) | codex-router / `auto-thinking` |
| spec-auditor profile | codex-router / `auto-thinking` | direct / `deepseek-flash` |
| project-manager profile | codex-router / `auto-thinking` | direct / `deepseek-flash` |

Hermes resolves `DEEPSEEK_API_KEY` automatically for the named `deepseek` provider,
which serves every direct fallback. No Hermes DeepSeek *fallback* traffic flows through
codex-router; codex-router still hops to DeepSeek itself inside the `auto-thinking`
pool. The `commandcode/*` primaries require `COMMANDCODE_API_KEY` in the router's
environment and are advertised in its catalog only while that key is present.

The reasoning effort shown for the main agent is the only effort this plan pins. The
profiles set their own: `architect` and `spec-auditor` at `medium`,
`project-manager` at `low`, `code-reviewer` at `high`. All four profiles route through
`auto-thinking` except `code-reviewer`, which pins the Command Code route directly, so
the router's pool also chooses an effort per hop for the slots that use it.

`code-reviewer` is the one slot whose fallback is not the direct `deepseek` provider:
it falls back to `custom:codex-router` / `auto-thinking`. That is an availability
fallback of last resort, not a strength guarantee. The pool chooses its own model per
hop and can itself serve `deepseek-flash`, so a round that falls through to it may run
on a weaker model than the pinned Command Code route. Keep the primary healthy rather
than relying on the fallback to hold a tier.

## Notes

- Codex Router exposes DeepSeek through two distinct families: the native
  `deepseek-flash` route over the Responses transport, and the Command Code models
  published as `commandcode/deepseek/*`. The auxiliary slots use the latter; every
  fallback uses the former on the direct `deepseek` provider.
- The native `deepseek-flash` route is reachable only over the Responses transport.
- `50-seed-defaults` reseeds every config key the baked `config.yaml` defines and
  force-migrates the managed profile routing fields (`providers`, `model`,
  `fallback_providers`) on every boot, so all routing changes must land in the repo
  defaults — runtime edits to those keys under `/opt/data` do not persist. A top-level
  key the baked config does not define (for example the codex-router `hooks:`) is
  preserved across the reseed.
- Deployment is a reviewed pull request followed by GitHub Actions. CI/CD owns the
  rollout; never restart, rebuild, pull, or run Docker Compose on production.
