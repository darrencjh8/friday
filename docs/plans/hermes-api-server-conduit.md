QUESTIONS
q: Is the Hermes API server already enabled in production? | a: Yes. Read-only inspection on 2026-10-11 shows `API_SERVER_KEY` set in `/opt/data/.env`, `/health` answering 200, and `/v1/models` answering 401 without the key and 200 with it, all from inside the container. No feature flag needs adding.
q: Why can the host not reach port 8642 today? | a: The listener is `127.0.0.1:8642` inside the container (`/proc/net/tcp`), and Docker's published port forwards to the container interface address, so a container-loopback listener is unreachable. `curl 127.0.0.1:8642` on the host fails to connect. `gateway/platforms/api_server.py` reads `API_SERVER_HOST` (default `127.0.0.1`), so the fix is `API_SERVER_HOST=0.0.0.0`.
q: Does widening the bind expose the API to the LAN? | a: No. The compose publish changes from `8642:8642` (all host interfaces) to `127.0.0.1:8642:8642`, matching the WebUI. Tailscale serve is the only way in, and the API still demands `API_SERVER_KEY`.
q: Where does the API key live, and does CI need a new secret? | a: In the container's `/opt/data/.env`, already present. Compose must not carry it, and the new test pins that. No GitHub secret is added.
q: Can anything else depend on host port 8642 being published on the LAN? | a: No. The port has been unreachable from the host until now, because of the loopback listener. Container-to-container traffic uses the container port on the compose network and is unaffected by the host publish.
q: How is it exposed on the tailnet? | a: `tailscale serve --bg --https=8642 http://127.0.0.1:8642`, run by the operator, because the CI runner user has no Tailscale operator rights. This is host state and not part of the change; `docs/operations.md` records the command.
q: Is TDD applicable? | a: Yes for the compose behaviour: a test in `modules/hermes/tests/test_slack_platform.py` asserts `API_SERVER_HOST=0.0.0.0`, the loopback-only publish, and no `API_SERVER_KEY` in compose. It fails at base and passes at HEAD. The `docs/operations.md` edit is prose and is validated by reading it against `tailscale serve status`.

# Hermes API server for Conduit

## Change

1. `modules/docker-compose.yml`, `hermes` service: add `API_SERVER_HOST=0.0.0.0` to `environment`, and change the port `8642:8642` to `127.0.0.1:8642:8642`.
2. `modules/hermes/tests/test_slack_platform.py`: add `test_api_server_is_reachable_through_a_loopback_only_publish`.
3. `docs/operations.md`: the ports table, and the Tailnet exposure section. The existing text says the WebUI is on the 443 root, but `tailscale serve status` shows it on `:8443` and only `/router` on 443. Add the `:8642` mapping and where the API key lives.

## Out of scope

Enabling the API server (already on), adding secrets, running `tailscale serve` (operator action), removing `hermes-webui`.

## Validation

`python -m unittest modules.hermes.tests.test_slack_platform` fails the new test at base and passes at HEAD. After CI deploys, the operator runs the `tailscale serve` command and checks `curl -s -H "Authorization: Bearer $KEY" https://your-host.your-tailnet.ts.net:8642/v1/models` from a tailnet device.
