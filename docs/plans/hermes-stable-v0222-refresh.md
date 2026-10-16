QUESTIONS
q: Which upstream Hermes release should stable represent? | a: `stable` and `v0.22.2` resolve to the same Docker manifest index digest `sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919`, so target `v0.22.2`.
q: May this work pull or deploy the image on production? | a: No; use registry metadata and upstream source via `gh`, validate locally, then open a PR. CI/CD owns deployment.
q: How should the image build handle Python 2 examples inside the upstream uv cache? | a: Exclude `/uv-cache/` from compileall; those cached sources are not runtime modules and one contains Python 2 tuple-parameter syntax.

# Hermes stable v0.22.2 refresh

## Goal
Update the pinned Hermes `stable` manifest digest to current `v0.22.2`, preserve the build-time patches, and make the new base image build successfully.

## Changes
- Update the `FROM nousresearch/hermes-agent:stable@sha256:...` pin to `sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919`.
- Compare the four patch targets with upstream `v0.22.2`. Refresh verbatim fixtures and minimally rebase patch scripts only where needed; preserve patch behavior.
- Exclude `/uv-cache/` from the Dockerfile's recursive `compileall`; cached package source is not runtime code and includes Python 2 syntax that fails on the image's Python 3 interpreter.
- Add a regression test that exercises the Dockerfile's compileall arguments against valid runtime code and a Python 2-only source file under `uv-cache`, proving the runtime file compiles while the cache source is skipped.
- Update release-specific references where needed. Do not alter stable-digest automation or perform a production pull, build, restart, or deploy.

## Validation
- First run the new regression test and confirm it fails before the Dockerfile fix, then passes.
- Apply the four Hermes-agent build patches to verbatim `v0.22.2` fixtures and run the Hermes patch tests.
- Run `modules.tests.test_hermes_webui_api_mode`, `modules.tests.test_deploy_workflow_router`, and relevant validation for changed files.
- Open/update the PR against current `main`; let CI validate the image build. No production deployment without a separate explicit go after merge.

## TDD
The image-pin refresh has no new runtime behavior; existing fixture tests cover patch compatibility. The required compileall exclusion is a build behavior change exposed by CI: add the regression test first, verify RED, then implement the minimal exclusion and verify GREEN.
