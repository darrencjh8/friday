QUESTIONS
q: Which source controls the wire protocol for a configured named custom provider? | a: Its matching providers.<name>.transport is explicit; honor the active session profile's value before resolver inference, retaining the runtime mode only when no configured transport matches.

# Hermes WebUI API-Mode Routing Fix

## Goal
Make WebUI-created Hermes agents use the wire protocol declared by the active profile's matching custom provider. The live profile declares `codex_responses`, but the failing WebUI turn reached `/v1/chat/completions`.

## Change
- Add a build-time, fail-closed patch for the pinned WebUI `api/streaming.py`. At the WebUI agent-construction boundary, resolve `get_custom_provider_api_mode()` against the active profile config and effective provider URL; prefer that configured mode and retain `_rt.api_mode` only when no matching transport exists.
- Install and apply the patch in the Hermes Dockerfile after the pinned WebUI checkout.
- Add a behavioral regression test that applies the patch to a fixture containing the pinned upstream agent-construction snippet, executes that patched snippet with a capturing fake `AIAgent`, and asserts the selected mode is passed as the constructor's `api_mode` for both a matching profile transport and a no-match runtime fallback. Also verify the Docker build installs the patch. Keep existing Hermes transport tests green.

## Validation
- Demonstrate the regression test fails at the base revision and passes after the patch; it must exercise the patched agent-construction boundary for both mode-selection cases, not only the helper or Dockerfile text.
- Run the focused WebUI, seed, and routing tests plus `modules/tests`.
- Build and validate the Hermes image in PR CI; review the unchanged final HEAD; merge only after required checks pass.
- After CI/CD deploys, send one cold WebUI message and a second warm message in the same session only if the cold request completes. Confirm both route through Responses before reporting latency.

## Risks
- Upstream WebUI source drift could break the patch; the patch must fail the image build if its anchor changes.
- The explicit transport must be selected only for a provider entry whose normalized endpoint matches the active route; otherwise keep the runtime resolver's mode.
