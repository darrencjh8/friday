QUESTIONS
q: Does upstream v0.21.7 already include the local lifecycle, webhook-reap, Slack fallback, and session-cap behavior? | a: No. The inspected source retains synchronous unclean-exit quick_check, omits webhook from the stale-open allowlist and both Slack fallback cases; the local session-cap patch still applies and is not upstreamed.
q: May targeted tests run on this host? | a: Yes. The user explicitly approved tests isolated to the worktree; do not touch the Hermes service or build/deploy locally.
q: How will upstream Hermes stable updates reach this repository? | a: A scheduled workflow reads the multi-architecture `stable` manifest digest and opens a PR updating the digest pinned in the Dockerfile. Merge triggers the existing Hermes build/deploy path. A tag change alone does not trigger deployment.
q: Why does WebUI startup need a separate PyYAML path on Hermes v0.21.7? | a: The v0.21.7 base excludes PyYAML; the WebUI bootstrap imports `yaml` and otherwise attempts to create a writable local venv. Install pinned PyYAML into an isolated image path and add only that path to the WebUI service's `PYTHONPATH`.
q: How does the v0.21.7 base expose its internally managed uv binary? | a: It is not on PATH or an application package; `pm.uv_launcher("uv")` is the supported accessor for its verified binary.
q: How will the new image reach production? | a: Only through the repository PR and GitHub Actions CI/CD after approval and merge.

# Hermes v0.21.7 Upgrade Plan

## Goal

Upgrade the Hermes image base from `v2026.9.24` to Docker Hub's `stable` image, currently Hermes `v0.21.7`; pin its multi-architecture digest and automate reviewable updates without losing the repository's four build-time patches or bytecode bake.

## Scope

- `modules/hermes/Dockerfile`: pin `nousresearch/hermes-agent:stable` by its multi-architecture manifest digest; resolve uv through `pm.uv_launcher("uv")`; install pinned PyYAML into an isolated WebUI dependency directory because the upstream base excludes it; retain local patches and `compileall`.
- `modules/hermes/webui/s6-rc.d/hermes-webui/run`: expose only the isolated WebUI dependency directory to its Python process.
- `modules/hermes/tests/test-webui-container.sh`: assert the isolated dependency install and service path are configured.
- `.github/workflows/hermes-stable-update.yml`: weekly/manual digest check; open or update a PR only when Docker Hub's `stable` manifest digest changes.
- `modules/build.sh`: use `docker-compose build --pull hermes` when Hermes is among selected build services; leave other services unchanged.
- `modules/tests/test_codex_router_rolling_update.py`: verify Hermes builds force a base metadata check while non-Hermes builds retain existing behavior.
- `modules/hermes/patches/patch-lifecycle-ledger.py`, `patch-stale-open-webhook.py`, `patch-slack-send-fallback.py`, and `patch-session-caps.py`: verify exact anchors against v0.21.7; update anchors where needed while preserving fail-closed drift detection and existing behavior.
- All four corresponding patch tests and upstream-source fixtures: pin tests to verbatim v0.21.7 files and retain regression coverage for each patch.

Do not edit or vendor Mnemosyne or other upstream code. Do not build, deploy, or inspect production services. The updater only opens a PR; it never merges or deploys.

## Steps

1. Add verbatim fixtures for the four relevant upstream v0.21.7 files and point the existing tests at them. Confirm the three drifted patches fail before patch changes and the session-cap patch applies to candidate source.
2. Make the smallest patch-script updates for the three drifted anchors while retaining idempotence and loud failure on unexpected upstream drift.
3. Verify each patched source compiles and behavior tests cover the background integrity check, webhook-only stale-open reaping, both Slack retry cases, and count/size session caps.
4. Pin the current Docker Hub `stable` multi-architecture manifest digest in the Dockerfile and retain the `pm.uv_launcher("uv")` build path, bytecode compilation, and all four patch invocations.
5. Install only the WebUI's missing pinned PyYAML dependency into `/opt/hermes-webui-deps` and add that directory to the WebUI service `PYTHONPATH`; do not modify the sealed Hermes venv or make the WebUI checkout writable.
6. Add a weekly and manually dispatchable workflow that reads the current registry manifest digest, compares it with the Dockerfile pin, and creates/updates a PR when they differ. Grant only `contents: write` and `pull-requests: write`; never merge or deploy from this workflow.
7. Make selected Hermes builds run `$COMPOSE build --pull hermes`; keep non-Hermes builds unchanged. Test build-service routing.
8. Run all four targeted Python unittest modules, `python -m unittest discover -s modules/tests -p 'test_*.py'`, the three existing Hermes shell tests, and the updater workflow validation. GitHub Actions must build and validate the candidate image; no local image build on this host.
9. Open/update the upgrade PR linked to issue #814, require green CI and approval on unchanged HEAD, then let existing CI/CD deploy after merge. Measure startup and streaming latency only with separate explicit approval.

## Acceptance

- Candidate fixtures match upstream tag `v0.21.7` and prove all four build-time patches apply.
- Targeted behavior tests pass; local patching remains idempotent and rejects unrecognized source drift.
- Dockerfile pins the current `stable` multi-architecture digest; scheduled/manual checks open a PR on digest change, never auto-merge or deploy.
- The WebUI imports pinned PyYAML from an isolated path without modifying the sealed Hermes venv or writing under its source checkout.
- Hermes builds force a registry check with `--pull`; unrelated service builds are unchanged.
- PR CI, including image build and updater checks, is green before merge; no direct production build/deploy occurs.
