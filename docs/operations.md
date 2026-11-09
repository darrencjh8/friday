# Operations

## Health endpoints

| Service | Check |
|---|---|
| expense-tracker | `curl http://localhost:8080/health` |
| portfolio-tracker | `curl http://localhost:8081/health` |
| actual-api | `curl http://localhost:3000/health` |
| codex-router | `curl http://localhost:4100/health/liveliness` |
| hermes | `docker exec hermes /package/admin/s6/command/s6-svstat -o up /run/hermes-service/gateway-default` |

`deploy.sh` performs these checks itself after `compose up` and exits non-zero if any fails. The Hermes dashboard and the Hermes WebUI are not run (removed in #157 to save memory). The v0.23 browser Webapp (full Desktop workspace served by the gateway, port 9120) is run instead. After a successful deploy the script also runs `hermes mcp test expense-tracker` and `hermes mcp test portfolio-tracker` to confirm the MCP connections.

## Deploys happen through CI, not by hand

Production deploys are performed by `.github/workflows/deploy.yml` on a **self-hosted runner**:

1. Triggers on push to `main`, or manually via `workflow_dispatch` (which can force all components or name them explicitly).
2. Checks out this repo and the separate `darrencjh8/codex-router` repo into `modules/codex-router`.
3. Auto-detects which components changed from the pushed commit; anything unclear, or a change to `docker-compose.yml` / `deploy.sh` / a root `Dockerfile`, falls back to `all`.
4. Runs `modules/build.sh` for those components.
5. Runs `modules/deploy.sh --component ... --non-interactive --skip-build` with secrets and variables injected as environment.
6. Records the deployed codex-router revision as a workflow artifact.

**Do not deploy or restart production by hand.** Merge to `main` and let CI do it. Manual `workflow_dispatch` runs are the intended escape hatch for component-specific or forced deployments.

Other workflows:

- `.github/workflows/test.yml` — unit tests on pull requests: expense-tracker, actual-api, portfolio-tracker, the Java `pp-cli`, Python compose/host tests, Hermes script lint/tests, and image-gen. `deploy.yml` also calls it for non-push events before deploying.
- `.github/workflows/sync-codex-router.yml` — every five minutes, compares `codex-router` `main` against the last deployed revision and triggers a deploy when they differ.
- `.github/workflows/recover-codex-router-auth.yml` — manual recovery for a codex-router account slot.
- `.github/workflows/codex-router-ci.yml` — runs the separate `darrencjh8/codex-router` unit suite against a named, reviewed commit SHA. It fires on `workflow_dispatch` with a `router_ref` input, or on a `codex-router-ci` `repository_dispatch` from that repository.
- `.github/workflows/secrets-scan.yml` and `.gitleaks.toml` — secret scanning.

## Ports

| Service | Host binding | Container port | Purpose |
|---|---|---|---|
| expense-tracker | `127.0.0.1:8080` | 8080 | REST `/tools/*`, MCP `/mcp`, `/health` |
| portfolio-tracker | `127.0.0.1:8081` | 8081 | REST `/tools/*` (plus `GET /tools`), MCP `/mcp`, `/health` |
| actual-api | `127.0.0.1:3000` | 3000 | Actual Budget proxy, `/health` |
| dots-web | `127.0.0.1:8789` | 8789 | Dots web app and its pairing relay |
| codex-router | `0.0.0.0:4100` | 4100 | caddy front for the two router colours: OpenAI-compatible `/v1`, `/health/liveliness` |
| hermes | `127.0.0.1:8642`, `127.0.0.1:8788`, `127.0.0.1:9120`, `127.0.0.1:8300`, `127.0.0.1:8299`, `0.0.0.0:8644` | same | Hermes gateway ports; 8788 is the Dots phone app gateway; 8642 is the API server (Conduit), bound to `0.0.0.0` inside the container by `API_SERVER_HOST` and published on loopback only; 9120 is the v0.23 browser Webapp (Desktop workspace), bound to `0.0.0.0` inside the container by `webapp.host` and published on loopback only; 8300 is the reminders dashboard; 8299 is the Google Tasks OAuth callback listener; the webhook platform listens on 8644 (`NOTIFY_URL` target) |
| whisper | — (no published port) | — | Speech-to-text for Hermes; reachable only on the Compose network |

`expense-tracker`, `portfolio-tracker`, `actual-api`, and hermes `8642` publish to `127.0.0.1` only. `codex-router` binds `0.0.0.0:4100` so the `hermes_shared` network and external clients can reach it, and hermes publishes only `8644` on all interfaces (no host IP in `docker-compose.yml`). The front sits in front of two interchangeable router colours (`codex-router-a`, `codex-router-b`), which publish no ports of their own; a deploy rolls one colour at a time, so `4100` never goes dark. The Webapp publishes to `127.0.0.1` only for the same reason; Tailscale serve terminates TLS on the tailnet.

## Tailnet exposure (Tailscale serve)

Tailscale terminates TLS and proxies to host loopback, so nothing here is published to the LAN.
The tailnet host is `your-host.your-tailnet.ts.net`:

- `https://your-host.your-tailnet.ts.net:8642` — Hermes API server (`127.0.0.1:8642`), the endpoint
  mobile clients such as Conduit use; requests need `Authorization: Bearer <API_SERVER_KEY>`
- `https://your-host.your-tailnet.ts.net:9120` — Hermes browser Webapp
  (`127.0.0.1:9120`), the full Desktop workspace in a browser tab; sign-in is
  the dashboard basic-auth pair (trusted tailnet only)
- `https://your-host.your-tailnet.ts.net/router/v1` — codex-router OpenAI-compatible API
  (`127.0.0.1:4100`); `--set-path /router` strips the prefix, so the router still sees
  `/v1/...`

The API key lives in the container's `/opt/data/.env` as `API_SERVER_KEY`, not in compose or
GitHub secrets. To read it for a client, run `docker exec hermes sh -c '. /opt/data/.env; echo $API_SERVER_KEY'`
on the production host and move it over a safe channel.

The API server listens on `127.0.0.1` inside the container unless `API_SERVER_HOST` says
otherwise. Compose sets it to `0.0.0.0`, because Docker's published port forwards to the
container's interface address and cannot reach a container-loopback listener.

These are host state, not container state, so a rebuild does not restore them. Run them once
on the production host as a user with Tailscale operator rights (the CI runner user has
none, so `deploy.sh` never touches `tailscale`):

A host set up before #157 also has `--https=8443` (WebUI) and `--https=9119` (dashboard)
entries; remove them with `tailscale serve --https=8443 off` and `tailscale serve --https=9119 off`.

```sh
tailscale serve --bg --https=443 --set-path /router http://127.0.0.1:4100
tailscale serve --bg --https=8642 http://127.0.0.1:8642
tailscale serve --bg --https=8788 http://127.0.0.1:8788
tailscale serve --bg --https=8789 http://127.0.0.1:8789
tailscale serve --bg --https=9120 http://127.0.0.1:9120
tailscale serve --bg --https=443 --set-path /reminders http://127.0.0.1:8300
```

Dots web app: the deploy secret `DOTS_WEB_ORIGINS` must be exactly
`https://your-host.your-tailnet.ts.net:8789`, or the gateway refuses it. Pair from the phone app
with *Connect a browser*. Both devices need to be on the tailnet.

Reminders dashboard: stdlib page over the structured snapshot
(`wiki-reminder-tasks.py --snapshot-out /opt/data/reminders/reminders.json`,
written by the daily job) plus authenticated editing of the Daily
candidates table in `daily-habits.md`. No account data beyond your own
task titles; tailnet-only. Verify with `tailscale serve status`.

Editing daily habits from the page requires the edit token. Generate it
once and store it as a GitHub secret (deploy.yml passes it into the
container; an empty/unset token disables editing):

```sh
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
gh secret set REMINDERS_EDIT_TOKEN
```

Edits rewrite the wiki table atomically and take effect from the next
08:15 cron run. Removing a habit stops future task creation only —
already-created Google Tasks are never deleted; clear them in Google
Tasks. Titles/notes may not contain `|`, backticks, or newlines.

Google OAuth (`google login`, one token for gtasks plus read-only gmail and
gcal) uses a loopback redirect (`http://localhost:9090/callback`,
exempt from Google's own-your-domain redirect policy, which rejects
tailnet-host redirects with a 400 policy page). There is deliberately no
serve mount for it: the browser device reaches the container listener on
`127.0.0.1:8299` via `ssh -L 9090:localhost:8299`, or the code comes back
through `google login --manual`. Verify with `tailscale serve status`.

Verify with `tailscale serve status`. Any client that hardcoded
`https://your-host.your-tailnet.ts.net/v1` moves to `https://your-host.your-tailnet.ts.net/router/v1`.
