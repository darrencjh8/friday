QUESTIONS
q: Should refresh scheduling run inside the Docker container rather than host cron? | a: Yes; use Hermes cron with a script-only job because Hermes cron state is persisted under /opt/data and the scheduler runs in the container.
q: Should App credentials take precedence over FRIDAY_PAT at boot? | a: Yes; when all three GH_APP_* variables are present, App auth is authoritative; FRIDAY_PAT is fallback only when App configuration is incomplete.
q: Should a stale existing gh credential block App refresh? | a: No; boot and refresh must replace the gh credential after successfully minting a new installation token.
q: Which repositories should the installation cover? | a: All repositories in Darren's account, including the archived KTMB repository; GitHub may still enforce archived-repository write restrictions.

# Plan: Transparent GitHub App auth for `gh`

## Goal

Make GitHub CLI authentication inside the Hermes container transparently use the
`friday-coder-bot` GitHub App installation wherever the App credentials are
configured, while preserving the existing PAT only for the separate legacy
codex-router checkout refresh. Keep all changes reviewable and deployable through
PR and CI/CD.

## Questions and decisions

- App tokens are installation-scoped and cannot enumerate `/user/repos`; all CLI
  calls must remain repository-explicit.
- Installation tokens are short-lived; GitHub caps their lifetime, so Hermes
  refreshes them through a 15-minute no-agent cron job.
- Archived repositories are in scope. Installation access is verified against
  each explicitly named repository, including `openclaw-module-ktmb`.
- The legacy codex-router checkout refresh remains PAT-backed, but the PAT is
  scoped to that one boot command rather than exported as `GH_TOKEN` for every
  Hermes process.

## Implementation

1. Refactor the existing helper around one safe refresh path:
   - define App configuration as complete only when `GH_APP_ID` and `GH_APP_INSTALLATION_ID` are non-empty decimal integers and `GH_APP_PRIVATE_KEY` is non-empty and cryptographically parseable by `openssl pkey`; empty, non-numeric, header-only, or otherwise malformed values are incomplete and use the PAT fallback when available;
   - use that same complete-configuration predicate in boot selection and the helper, so an invalid App never suppresses the documented PAT fallback;
   - exit 0 with a skip log and no alert when App configuration is incomplete and no PAT is present; return non-zero only after a valid App configuration is selected and mint/auth/parse fails;
   - validate all required App variables before making a request;
   - mint a JWT with the configured App ID and private key;
   - request an installation token by sending the JWT as the HTTP authorization bearer credential on the wire (redact the JWT value only in log output) and parse `token` plus `expires_at` from the response;
   - authenticate the `hermes` user via `su -s /bin/sh hermes -c "gh auth login --with-token"`, never log the token, and keep gh-managed `hosts.yml` mode `0600` and hermes-owned;
   - do not retain `/opt/data/.gh_token`: remove any stale legacy file at helper entry and again in an unconditional exit/signal cleanup trap; feed the minted token only through the protected stdin login path, never create a replacement file, and ensure failure at mint, parse, or login leaves the file absent; no caller reads that file;
   - never hand-edit gh-managed `hosts.yml` and never use an in-place credential rewrite.
2. Make boot initialization idempotent and precedence-aware:
   - valid complete App configuration: run the App helper and do not invoke PAT login;
   - incomplete or invalid App configuration with non-empty `FRIDAY_PAT`: retain the PAT fallback, delivered through a boot-only secret file mounted at `/run/secrets/friday_pat` (mode `0400`, readable only by root), consumed by `50-seed-defaults` for the fallback login and codex-router refresh, and never exported in the Hermes service environment or inherited by the gateway/cron children;
   - remove any stale `/opt/data/.gh_token` before either App or PAT auth branching, and leave it absent on every branch;
   - neither usable: leave existing credentials untouched and emit a safe warning.
3. Seed a Hermes cron job named `github-app-auth-refresh`:
   - every 15 minutes;
   - `no_agent: true`, `script: github-auth.sh`, `deliver: local`;
   - update in place following the existing portfolio-job migration pattern, so the schedule and script cannot drift after redeploy;
   - rewrite the stale hardcoded `github-auth-refresh`/50m insert-only snippet in `test-50-seed-defaults.sh` to the new name/interval plus migration assertions;
   - do not include a prompt or token output.
4. Inventory the scoped GitHub CLI call sites before implementation. For every `gh` invocation in `modules/hermes/scripts/`, `modules/hermes/50-seed-defaults`, and related tests, either require an explicit `--repo`/`-R owner/repository` or document why it is local authentication plumbing rather than a repository operation. Ban `/user`, `/user/repos`, `gh repo list`, and current-directory repository inference for installation-token paths. Add fake-`gh` assertions for each repository operation, including `darrencjh8/codex-router`, `darrencjh8/friday-memory`, and archived `darrencjh8/openclaw-module-ktmb` where applicable.
5. Prevent credential precedence regressions and ambient PAT use:
   - remove `GH_TOKEN=${FRIDAY_PAT}` and the broad `FRIDAY_PAT=${FRIDAY_PAT}` export from the Hermes service environment because gh gives ambient credentials precedence over stored App credentials and the memory scripts must not inherit the PAT;
   - remove the `FRIDAY_PAT` fallback branches from `memory-backup.sh` and `memory-restore.sh`; those scripts use stored `gh` App credentials only and skip safely when no gh token is available;
   - read the boot-only `/run/secrets/friday_pat` file only inside `50-seed-defaults`, pass its value to the one-shot fallback `gh auth login` and codex-router refresh commands, then clear shell variables and remove any temporary stdin file before boot continues;
   - pin the auth helper to `HOME=/opt/data/home` and its matching `GH_CONFIG_DIR`, then explicitly switch gh to the App login after `gh auth login --with-token`.

6. Deliver the fallback secret without making it ambient:
   - use the exact host path `/home/runner/data/hermes/friday_pat.secret`, prepare it in `modules/deploy.sh` before any `docker compose config`, `up`, or recreate call, and bind-mount that file read-only to `/run/secrets/friday_pat` in the Hermes service;
   - always leave that path as a regular file: never delete it. When `FRIDAY_PAT` is non-empty, write it to a same-directory temporary file created with `umask 077`, set mode `0400` and root ownership, then atomically rename it over the exact host path; when `FRIDAY_PAT` is unset or empty, materialize an empty root-owned mode-`0400` regular file at the same path so no stale credential remains and the bind source is always present;
   - if the path exists but is not a regular file (for example a directory left by an earlier missing-source mount), replace it with a regular file before writing, so the rotation from empty to set cannot fail;
   - the boot hook requires a regular readable non-empty file (test `-f` and `-s`) before consuming it, and skips PAT fallback with a safe warning when the file is absent, a directory, or empty;
   - remove the Compose environment entry for `FRIDAY_PAT`; keep `FRIDAY_PAT` in the deploy process only long enough to create the mounted secret and never pass it through `environment:`.

## Verification

- RED control mapping, each required to fail at base and pass at HEAD: `T-precedence` = `test_app_config_validation_and_pat_fallback` plus `test_app_account_selected` in `modules/hermes/tests/test-github-auth.sh`; `T-atomic-replace` = `test_atomic_credential_install` in that same harness; `T-no-secret-output` = `test_token_never_appears_in_output` there; `T-invalid-pem-fallback` = `test_invalid_pem_uses_pat_without_app_request`; `T-stale-token-cleanup` = `test_stale_token_removed_on_all_auth_paths`; `T-secret-file-delivery` = `test_pat_secret_file_lifecycle` in `modules/tests/test_deploy_workflow_router.py`, asserting the exact host path `/home/runner/data/hermes/friday_pat.secret`, root ownership, mode `0400`, atomic temp-then-rename rotation, an empty `0400` regular file (never an absent path or directory) when `FRIDAY_PAT` is empty, directory-to-file repair before rewriting, preparation ordering before `docker compose` preflight, the read-only `/run/secrets/friday_pat` bind target, and absence of `FRIDAY_PAT` from the rendered Compose service environment; `T-pat-secret-delivery` = `test_pat_secret_not_in_compose_environment` in `modules/hermes/tests/test-docker-compose-env.sh`; `T-memory-no-pat` = `test_memory_scripts_do_not_read_pat` in that same harness. The command is `bash modules/hermes/tests/test-github-auth.sh`; expected exit is non-zero at base and zero at HEAD. Also run `bash modules/hermes/tests/test-50-seed-defaults.sh`, `python3 modules/hermes/tests/test-seed-app-cron.py`, `bash modules/hermes/tests/test-docker-compose-env.sh`, `bash modules/hermes/tests/test-refresh-codex-router-checkout.sh`, and `python3 modules/tests/test_deploy_workflow_router.py` at HEAD. Run `bash -n` on every changed shell file and pin the shellcheck version printed by `shellcheck --version` in the evidence.
- Verify Compose exports neither ambient `GH_TOKEN` nor broad `FRIDAY_PAT`, the host secret path is always a regular root-owned `0400` file (empty when `FRIDAY_PAT` is unset, rotated atomically when set, and repaired if it was a directory), the `/run/secrets/friday_pat` bind is read-only, memory backup/restore have no PAT fallback, the boot fallback and codex-router refresh consume only a readable non-empty regular file, the helper selects the App account, invalid App values take the PAT fallback, and no `.gh_token` file is retained after success or failure.
- Verify malformed PEM input fails the shared App-completeness predicate and selects the PAT fallback without making an App request; verify stale `.gh_token` cleanup before both auth branches and after mint, parse, login, and signal failure paths.
- Verify every inventory entry from step 4 with fake-`gh` argument capture; repository operations must carry an explicit owner/repository target and no captured operation may use `/user` or `/user/repos`.
- Advisory only (not CI evidence): one live run of the helper with the configured App in the isolated worktree/container environment, verifying the installation endpoint and one repository-scoped `gh` command without printing token material.
- Inspect the final diff for credentials, unsafe permissions, PAT-overwrite regressions, and stale `.gh_token` consumers; repository search must show no remaining `FRIDAY_PAT` read in memory backup/restore and no broad Compose export.

## Non-goals

- Do not create a long-lived GitHub access token; installation tokens remain GitHub-capped short-lived credentials.
- Do not change GitHub branch protection or author identity behavior.
- Do not deploy or restart production manually; CI/CD remains the deployment path.
