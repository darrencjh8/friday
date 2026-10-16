QUESTIONS
q: Is disk-cleanup enabled through Hermes config? | a: Official Hermes built-in plugin docs specify `plugins.enabled` in `config.yaml`.
q: Where should enablement live to survive redeploys? | a: `modules/hermes/config.yaml` is baked into the image and merged into `/opt/data/config.yaml` at boot, with baked keys taking precedence.
q: Does plugin tracking state need separate seeding? | assumption: No; Hermes stores it under `$HERMES_HOME/disk-cleanup/`, and this deployment's `/opt/data` is persistent. Do not add a separate state seed or volume.

# Hermes disk-cleanup seed

## Goal
Keep `disk-cleanup` enabled after container restarts and redeploys without changing its cleanup policy or state location.

## Change
- Add `plugins.enabled: [disk-cleanup]` to the baked Hermes config at `modules/hermes/config.yaml`.
- Extend the existing seeded-config test to parse the merged config and assert that `plugins.enabled` contains `disk-cleanup`.

## Verification
- Run the focused Hermes seed test and YAML parse validation in the worktree; do not inspect or alter production.
- Review the diff and rely on CI before any deployment.

## Scope
No plugin code, cleanup thresholds, state migration, runtime config mutation, or deployment operation.
