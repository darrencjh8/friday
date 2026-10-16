# Operations

## Health endpoints

| Service | Check |
|---|---|
| expense-tracker | `curl http://localhost:8080/health` |
| portfolio-tracker | `curl http://localhost:8081/health` |
| actual-api | `curl http://localhost:3000/health` |
| codex-router | `curl http://localhost:4100/health/liveliness` |
| hermes | `docker exec hermes /package/admin/s6/command/s6-svstat -o up /run/service/gateway-default` |
| hermes-webui | `docker exec hermes curl -fsS http://127.0.0.1:8787/health` |

`deploy.sh` performs these checks itself after `compose up` and exits non-zero if any fails. The Hermes dashboard is enabled (`HERMES_DASHBOARD=1`) with basic auth on port 9119, LAN-only (no Tailscale serve). After a successful deploy the script also runs `hermes mcp test expense-tracker` and `hermes mcp test portfolio-tracker` to confirm the MCP connections.

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
| codex-router | `0.0.0.0:4100` | 4100 | caddy front for the two router colours: OpenAI-compatible `/v1`, `/health/liveliness` |
| hermes | `127.0.0.1:8642`, `0.0.0.0:9119`, `0.0.0.0:8644` | same | Hermes gateway ports; 8642 is the API server (Conduit), bound to `0.0.0.0` inside the container by `API_SERVER_HOST` and published on loopback only; 9119 is published on all interfaces; the webhook platform listens on 8644 (`NOTIFY_URL` target) |
| hermes-webui | `127.0.0.1:8787` | 8787 | Hermes WebUI; the s6 service inside the `hermes` container binds `0.0.0.0:8787` |

`expense-tracker`, `portfolio-tracker`, `actual-api`, hermes `8642`, and hermes-webui `8787` publish to `127.0.0.1` only. `codex-router` binds `0.0.0.0:4100` so the `hermes_shared` network and external clients can reach it, and hermes publishes `9119` and `8644` on all interfaces (no host IP in `docker-compose.yml`). The front sits in front of two interchangeable router colours (`codex-router-a`, `codex-router-b`), which publish no ports of their own; a deploy rolls one colour at a time, so `4100` never goes dark.

## Tailnet exposure (Tailscale serve)

Tailscale terminates TLS and proxies to host loopback, so nothing here is published to the LAN.
The tailnet host is `your-host.your-tailnet.ts.net`:

- `https://your-host.your-tailnet.ts.net:8443` — Hermes WebUI (`127.0.0.1:8787`)
- `https://your-host.your-tailnet.ts.net:8642` — Hermes API server (`127.0.0.1:8642`), the endpoint
  mobile clients such as Conduit use; requests need `Authorization: Bearer <API_SERVER_KEY>`
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

```sh
tailscale serve --bg --https=443 --set-path /router http://127.0.0.1:4100
tailscale serve --bg --https=8443 http://127.0.0.1:8787
tailscale serve --bg --https=8642 http://127.0.0.1:8642
tailscale serve --bg --https=443 --set-path /reminders http://127.0.0.1:8300
```

Reminders dashboard: read-only stdlib page over the structured snapshot
(`wiki-reminder-tasks.py --snapshot-out /opt/data/reminders/reminders.json`,
written by the daily job). No account data beyond your own task titles;
tailnet-only. Verify with `tailscale serve status`.

Google Tasks OAuth uses a loopback redirect (`http://localhost:9090/callback`,
exempt from Google's own-your-domain redirect policy, which rejects
tailnet-host redirects with a 400 policy page). There is deliberately no
serve mount for it: the browser device reaches the container listener on
`127.0.0.1:8299` via `ssh -L 9090:localhost:8299`, or the code comes back
through `gtasks login --manual`. Verify with `tailscale serve status`.

Verify with `tailscale serve status`. Any client that hardcoded
`https://your-host.your-tailnet.ts.net/v1` moves to `https://your-host.your-tailnet.ts.net/router/v1`.
