QUESTIONS
q: Which gtasks release, platform archives, and digests are pinned? | a: Upstream v0.13.0 publishes linux_amd64 and linux_arm64 archives with SHA-256 digests; pin both and verify before installing.
q: Does this release read OAuth credentials from environment variables? | a: Yes. Its config maps GTASKS_CLIENT_ID and GTASKS_CLIENT_SECRET to credentials.
q: Where does gtasks persist OAuth tokens, and how can that survive container replacement? | a: It stores token.json in its XDG config directory when no system keyring is available; set XDG_CONFIG_HOME under the existing /opt/data mount.
q: Should deployment fail if OAuth has not been configured yet? | a: No. Keep client ID and secret optional; task operations require credentials and a one-time user login.

# Google Tasks CLI in Hermes

## Goal
Make the pinned `gtasks` CLI and its Tasks-only usage skill available to Hermes, pass OAuth client credentials only at runtime, and persist the OAuth token across container recreation.

## Implementation
- Download upstream `gtasks` v0.13.0 in `modules/hermes/Dockerfile`, select the Linux archive using Docker's target architecture, verify its published SHA-256, and install only the binary.
- Add a concise Hermes skill under `modules/hermes/skills/gtasks-cli/`; the existing Dockerfile and `50-seed-defaults` already copy and seed Hermes skills into the persistent skill root.
- Add optional `GTASKS_CLIENT_ID` and `GTASKS_CLIENT_SECRET` environment entries to the Hermes service. Set `XDG_CONFIG_HOME=/opt/data/.config` so CLI token/config state stays in the existing persistent data volume.
- Forward `GTASKS_CLIENT_ID` from the GitHub environment variable and `GTASKS_CLIENT_SECRET` from a GitHub Actions secret. Do not put credentials in Docker build arguments or image layers.
- Extend the existing Hermes wiring test to cover Compose credential forwarding, persistent config location, and workflow injection. Keep dev-loop state temp files ignored without modifying the repository's existing `.agents/dev-loop-plan.md`.

## Verification
- Prove the new wiring assertions fail against the base before implementation and pass after implementation.
- Run the Compose config validation, relevant Hermes wiring tests, and the repository's standard CI checks in CI. Image build/boot runs only in CI; never run Docker build, Compose, or deployment commands on production.

## Boundaries
The CLI's OAuth config uses only the Google Tasks scope. No task API calls or login occur in this change. The user creates OAuth credentials and completes one-time Google consent after deployment. The client secret and refresh token remain out of source control.
