QUESTIONS
q: Should the WebUI run inside the existing hermes container or as a sibling container sharing HERMES_HOME? | a: Inside the hermes container itself. Darren chose the literal reading on 2026-10-07: the WebUI shares the agent source, `/opt/hermes/.venv`, the Hermes tools, and `HERMES_HOME=/opt/data` in-process, so no second writer holds a copy of the agent tree and the upstream #681 limitation (tools triggered from a separate WebUI container run in that container) does not apply.
q: Is the WebUI password-protected? | a: No. Darren chose no password on 2026-10-07. The listener is published on `127.0.0.1` only and reached through Tailscale serve, and `HERMES_WEBUI_PASSWORD` is deliberately not wired.
q: How is the WebUI exposed on the tailnet, given `tailscale serve --https=443` root already proxies to the codex-router caddy front on `127.0.0.1:4100`? | a: Replace the root. Confirmed by the owner 2026-10-07: `https://your-host.your-tailnet.ts.net` serves the WebUI, and the caddy front moves to the path `/router` on the same port, so the router keeps an address. The `--set-path /router` mount strips the prefix before proxying, so the router still sees `/v1/...`. The operator applies this once over SSH because the CI runner user has no tailscale operator rights; the exact commands are recorded in `docs/operations.md`.
q: How does the WebUI locate the agent, when its own launcher would otherwise install one under `~/.hermes/hermes-agent`? | a: `HERMES_WEBUI_AGENT_DIR=/opt/hermes` plus `HERMES_WEBUI_PYTHON=/opt/hermes/.venv/bin/python3`, set by the s6 run script. Verified read-only in the production container on 2026-10-07: that venv already imports PyYAML 6.0.3 and cryptography 50.0.0, which are the WebUI's only two pinned dependencies, so no install step runs and `HERMES_WEBUI_AUTO_INSTALL` stays at its default (off).
q: Does the s6-overlay v3 runtime database accept a new service added at image build time? | a: Yes. Read-only inspection on 2026-10-07 shows `/etc/s6-overlay/s6-rc.d/` holds the service source directories, `/etc/s6-overlay/s6-rc.d/user/contents.d/` lists the enabled services (`dashboard`, `main-hermes`), and `/run/s6/db/` is the compiled database produced at container start, so a service directory plus a `contents.d` entry added in the Dockerfile is compiled on the next boot.
q: Which WebUI revision, and how is drift prevented? | a: Commit `c67fd2dd270a1128c2754200406bca58e9d9a25a` (the commit behind tag `v0.52.113`, read from the upstream annotated tag object on 2026-10-07). `ARG HERMES_WEBUI_REF` defaults to that 40-hex commit, and the build fetches exactly that commit rather than checking out a tag, so a moved or re-pointed tag cannot change what a rebuild produces; a missing commit fails the build instead of silently building another revision. The tag survives only as a comment, and the new test asserts the ref is a 40-hex commit, so a WebUI upgrade is one visible line in review.
q: Is TDD applicable to this change? | a: Yes, and no docs-only exception is claimed. The change is executable behaviour in the Dockerfile, the compose port stanza, and the s6 run script, and the new test `modules/hermes/tests/test-webui-container.sh` pins each of them: it fails at base because the files it reads do not exist, and passes at HEAD.
q: Which address does the WebUI bind inside the container, given compose publishes only `127.0.0.1:8787`? | a: `0.0.0.0`. Docker's published port forwards to the container's interface address, not its loopback, so a `127.0.0.1` listener inside the container is unreachable from the host and the Tailscale route would have no backend while every in-container check passed. The host side stays loopback-only, so the wildcard bind adds no exposure. The run script sets `HERMES_WEBUI_HOST=0.0.0.0` explicitly and the test pins that exact value.
q: How does the new CI image job get a diff base, when `deploy.yml` reaches `test.yml` through `workflow_call` and no pull-request base exists there? | a: `test.yml` triggers on `pull_request` and `workflow_call` only, so there are exactly two cases and the job writes both once. A pull request compares `github.event.pull_request.base.sha` with `HEAD`. A reusable-workflow call carries the ref the deploy job is about to check out (`deploy.yml` passes `github.event.inputs.ref || github.sha`, which is the `ref` input defaulting to `main`), so the image job checks that ref out and treats everything it adds on top of `git merge-base origin/main HEAD` as the change under test: a ref main already contains ships the tree its own pull request tested, and a branch pays for the smoke because its changes are what is about to deploy. When the merge base cannot be computed the smoke runs, because the step cannot name what it compared. The checkout uses `fetch-depth: 0`, and `git cat-file -e` must resolve the checked-out commit before any path filtering, so an unresolvable commit fails the job closed instead of skipping the image evidence. There is no `push` case to write: this workflow is not triggered by a push.
q: How does the CI smoke test reach the chat path with no provider credentials? | a: With a stub agent. The agent venv resolves `run_agent` from its own source binding, so a second WebUI pointed at another `HERMES_WEBUI_AGENT_DIR` still reaches the real agent and its provider (observed in run 37664495432: the smoke chat returned the provider's "didn't respond in time" text). The job therefore asks the image for the module the venv actually resolves (`python3 -c "import sys; sys.path.append('/opt/hermes'); import run_agent; print(run_agent.__file__)"`), `docker cp`s a minimal stub exporting `AIAgent` over that file in the throwaway container, restarts the supervised service with `/command/s6-svc -r /run/service/hermes-webui`, waits for `/health` again, then `POST`s one `/api/session/new` and one `/api/chat` to the published port 8787 and requires the stub's fixed answer. `api/agent_runtime.py:require_ai_agent_class` imports `AIAgent` from `run_agent` on the agent-dir `sys.path`, and its revision guard binds only when the module's directory is a Git checkout (`_read_agent_revision` returns `None` for a plain directory), so the replaced module imports without tripping the guard. Smoking the supervised service also covers the launcher, the port the deploy publishes, and the restart path, which a second process did not. The job separately imports the real class the way the service does before the replacement — `docker exec <container> /opt/hermes/.venv/bin/python3 -c "import sys; sys.path.append('/opt/hermes'); from run_agent import AIAgent"` — so the declared `HERMES_WEBUI_AGENT_DIR`/`HERMES_WEBUI_PYTHON` pair is proven to resolve the real agent. The stub proves the launcher → chat route → agent-import wiring, not Hermes inference: CI has no provider credentials, and the real agent is proven by the operator's first chat after the image deploys.

# Serve Hermes WebUI from inside the hermes container

## Problem

The production host runs Hermes as a single container (`modules-hermes`, compose project
`modules`) with the agent source at `/opt/hermes`, its venv at `/opt/hermes/.venv`, and
`HERMES_HOME=/opt/data`. There is no chat UI: the only faces are Telegram, Slack, and the
gateway API. `nesquena/hermes-webui` is a self-contained Python UI (stdlib HTTP server, no
build step) that drives the agent, and the ask is to run it in that same container and
reach it from the tailnet.

Upstream ships two shapes, both of which the repository is not: a single-container image
that owns the whole container, and a two-container compose where the WebUI runs beside the
agent and shares `hermes-home` plus a copy of the agent source. The second inherits a known
limitation (tools a WebUI-triggered turn runs execute in the WebUI container, not the agent
container) and puts a second writer on the agent source. Running it in the existing
container avoids both, because the agent tree, the venv, the tool environment, and the
state directory are already the ones the gateway uses.

## Approach

1. **Bake the WebUI into the existing hermes image** (`modules/hermes/Dockerfile`): fetch
   `HERMES_WEBUI_REF` (default `c67fd2dd270a1128c2754200406bca58e9d9a25a`, the commit behind
   tag `v0.52.113`, named in a comment) into `/opt/hermes-webui` with `git init` +
   `git remote add origin https://github.com/nesquena/hermes-webui.git` +
   `git fetch --depth 1 origin "$HERMES_WEBUI_REF"` + `git checkout --detach FETCH_HEAD`, so
   the remote is named before the fetch, the build pins a commit rather than a mutable tag,
   and a missing commit fails the build instead of silently building another revision. `git`
   is already in the base image (verified read-only: `/usr/bin/git`, 2.47.3). Then copy the
   service tree in.
2. **Supervise it with s6**, not with a hand-rolled background process: add
   `/etc/s6-overlay/s6-rc.d/hermes-webui/{type,run}` and enable it by touching
   `/etc/s6-overlay/s6-rc.d/user/contents.d/hermes-webui`, so the WebUI restarts with the
   container and its output lands in `docker logs hermes`. The run script uses
   `#!/command/with-contenv sh` (matching `50-seed-defaults`), drops to the `hermes` user
   with `s6-setuidgid`, and sets the launcher's discovery variables explicitly instead of
   relying on `~/.hermes` defaults that do not exist in this image.
3. **Publish loopback only**: `127.0.0.1:8787:8787` on the `hermes` service, alongside the
   existing gateway ports. No password (Darren's decision), and no LAN exposure. The
   container-side listener is `HERMES_WEBUI_HOST=0.0.0.0`, not `127.0.0.1`: the host
   publishes only loopback, so a loopback-only listener inside the container would be
   unreachable through the published port and the Tailscale route would have no backend
   while every health check still passed. The run script sets every launcher variable
   explicitly, so nothing falls back to the launcher's own `127.0.0.1` default
   (`start.sh:84`, `bootstrap.py` `WEBUI_HOST`): `HERMES_WEBUI_AGENT_DIR=/opt/hermes`,
   `HERMES_WEBUI_PYTHON=/opt/hermes/.venv/bin/python3`, `HERMES_WEBUI_HOST=0.0.0.0`,
   `HERMES_WEBUI_PORT=8787`, `HERMES_WEBUI_STATE_DIR=/opt/data/webui`,
   `HERMES_WEBUI_DEFAULT_WORKSPACE=/workspace`, `HERMES_WEBUI_SERVER_CWD=/workspace`, and
   `HERMES_WEBUI_FOREGROUND=1` (without it `bootstrap.py` double-forks, because s6 sets
   none of the supervisor variables it auto-detects).
4. **Gate the deploy on the WebUI answering**: extend the existing hermes block in
   `modules/deploy.sh` with a bounded `/health` poll over `docker exec`, the same shape as
   the gateway `s6-svstat` poll it already runs.
5. **Record the tailnet exposure** in `docs/operations.md` (ports table + the two
   `tailscale serve` commands) so the host-side state is reproducible after a rebuild; the
   operator runs them once, because CI cannot.
6. **Build the image and boot it in CI**, because no test in this repository currently
   builds the Hermes image and every proposed check above is text-only: a new
   `hermes-webui-image` job in `.github/workflows/test.yml` builds `modules/hermes`, starts
   a disposable container from it with a temporary `HERMES_HOME`, asserts the supervised
   service is up (`s6-svstat -o up /run/service/hermes-webui`), that
   `curl -fsS http://127.0.0.1:8787/health` answers from inside the container, and that the
   same route answers from the runner through the published port; then swaps in the stub
   agent described in the QUESTIONS block, restarts the supervised service, and asserts one
   `/api/chat` round trip against it. It prints `docker logs` on failure.
   The job runs only when the image's inputs change. Its first step resolves the diff base
   from the event (`pull_request` → `github.event.pull_request.base.sha`; `workflow_call` →
   the ref the deploy job passed, compared with its merge base with `main`), the checkout
   uses `fetch-depth: 0` and checks out that ref, and the step fails closed with a non-zero
   exit when `git cat-file -e` cannot resolve the checked-out commit — a gate that cannot
   name its base must not report success. The changed-path set is `modules/hermes/`,
   `modules/docker-compose.yml`, and `.github/workflows/test.yml`, so a later edit to the
   port stanza alone still pays for the smoke test that guards it, and an unrelated PR does
   not pay for a base-image pull. The post-deploy health gate stays as defence in depth.
7. **Delete the duplicate operations tables from `README.md`** and point at
   `docs/operations.md` instead: the README repeats the health-endpoint and ports tables and
   both would be stale the moment 8787 exists, so the fix is one pointer rather than a
   second copy to maintain.

## Files

| File | Change |
|---|---|
| `modules/hermes/Dockerfile` | `ARG HERMES_WEBUI_REF`, clone into `/opt/hermes-webui`, install the s6 service and enable it |
| `modules/hermes/webui/s6-rc.d/hermes-webui/type` | `longrun` |
| `modules/hermes/webui/s6-rc.d/hermes-webui/dependencies.d/base` | empty marker: start with the `base` bundle, like `dashboard` |
| `modules/hermes/webui/s6-rc.d/hermes-webui/run` | `with-contenv` shell script that drops to `hermes` and execs the WebUI launcher |
| `modules/docker-compose.yml` | `- "127.0.0.1:8787:8787"` on the `hermes` service |
| `modules/deploy.sh` | bounded WebUI `/health` poll in the existing `should_deploy "hermes"` block |
| `modules/hermes/tests/test-webui-container.sh` | new test (below) |
| `.github/workflows/test.yml` | run the new test in the `hermes-scripts` job; add the input-gated `hermes-webui-image` build + boot + chat smoke job |
| `.github/workflows/deploy.yml` | pass the ref the deploy job will check out (`github.event.inputs.ref || github.sha`) into the reusable test workflow, so the image smoke tests the tree that ships |
| `docs/operations.md` | health-endpoint row, ports row, tailscale serve commands |
| `README.md` | replace the duplicated health-endpoint and ports tables with a pointer to `docs/operations.md` |

## Test

New test id: `modules/hermes/tests/test-webui-container.sh` (bash, run by the
`hermes-scripts` job). It asserts, with no network and no container:

1. the Dockerfile declares `ARG HERMES_WEBUI_REF` with a default matching `^[0-9a-f]{40}$`,
   fetches exactly that value (so a tag cannot substitute for it), names the upstream
   remote URL before fetching, and copies the checkout into `/opt/hermes-webui`;
2. the Dockerfile installs the service tree under `/etc/s6-overlay/s6-rc.d/hermes-webui`
   and enables it in `user/contents.d`;
3. `type` is `longrun` and `run` is executable-with-shebang, uses `with-contenv`, drops to
   `hermes` via `s6-setuidgid`, and sets `HERMES_WEBUI_AGENT_DIR=/opt/hermes`,
   `HERMES_WEBUI_PYTHON=/opt/hermes/.venv/bin/python3`, `HERMES_WEBUI_HOST=0.0.0.0`,
   `HERMES_WEBUI_PORT=8787`, `HERMES_WEBUI_STATE_DIR=/opt/data/webui`,
   `HERMES_WEBUI_DEFAULT_WORKSPACE=/workspace`, `HERMES_WEBUI_SERVER_CWD=/workspace`, and
   `HERMES_WEBUI_FOREGROUND=1`;
4. the compose `hermes` service publishes `127.0.0.1:8787:8787` and does not publish a
   wildcard `8787`;
5. `deploy.sh` polls the WebUI health endpoint inside the `hermes` component block with a
   bounded loop: at most 10 attempts, `curl --max-time 10`, `sleep 6` between attempts, and
   a failed poll increments the same `failed` counter the gateway poll uses, so a WebUI that
   never answers fails the deploy instead of hanging it.

RED/GREEN: at base the test exits non-zero (the Dockerfile arg, the service tree, the port
stanza, and the deploy poll are all absent); at HEAD it exits 0.

The CI smoke job is the pre-merge execution evidence for the same files: it builds the
image and boots it, which is the only check that can catch an unreachable commit, a wrong
launcher path, a wrong `COPY` destination, or a run script that exits immediately. It has
no repository-test RED state of its own — it fails closed on the base image only after the
service tree exists — so the RED/GREEN pair lives in the bash test above.

## Validation

- `bash modules/hermes/tests/test-webui-container.sh`
- `shellcheck modules/hermes/webui/s6-rc.d/hermes-webui/run modules/hermes/50-seed-defaults modules/hermes/scripts/*.sh`
- `python3 -c "import yaml,sys; yaml.safe_load(open('modules/docker-compose.yml'))"` locally;
  `docker compose -f modules/docker-compose.yml config -q` runs in CI's `compose-config` job
  (no Docker daemon on the authoring host).
- Existing Hermes script tests stay green: `bash modules/hermes/tests/test-deploy.sh`,
  `test-docker-compose-env.sh`, `test-50-seed-defaults.sh`.
- Pre-merge image evidence (CI owns it): the `hermes-webui-image` job builds the image at
  the pinned commit, boots a disposable container, and requires
  `docker exec <container> /package/admin/s6/command/s6-svstat -o up /run/service/hermes-webui`
  plus `docker exec <container> curl -fsS http://127.0.0.1:8787/health` to succeed. The
  container is started from the image's own entrypoint with no provider credentials, so
  only the WebUI service and its health route are asserted; a crash-looping gateway service
  is not part of the gate. The job also proves the bind: it publishes the container port on
  the runner's loopback (`docker run -p 127.0.0.1:8787:8787`) and curls
  `http://127.0.0.1:8787/health` from the runner, so a run script that binds the container's
  own loopback fails the job while the in-container probe still passes. It then proves the
  chat path: `docker exec` imports `run_agent.AIAgent` through the declared
  `/opt/hermes/.venv/bin/python3` and `HERMES_WEBUI_AGENT_DIR`; then the stub agent replaces
  that resolved module, the supervised service restarts, and one `/api/chat` POST through
  the published port answers with the stub's fixed text. The stub is the documented limit of
  this check: it proves wiring, not Hermes inference, because CI holds no provider
  credentials.
- Post-deploy evidence (CI owns it): `deploy.sh` fails if `curl 127.0.0.1:8787/health` does
  not answer inside the container, and `docker exec hermes curl -fsS
  http://127.0.0.1:8787/health` is the manual equivalent recorded in `docs/operations.md`.

## Not in scope

- No `API_SERVER_ENABLED` / `API_SERVER_KEY`. The WebUI's gateway/cron health pill may show
  the gateway as unreachable even though chat runs the agent in-process; enabling the
  gateway HTTP API is a separate change with its own secret.
- No separate `hermes-webui` container, no `hermes-agent-src` volume, no ghcr image.
- No Tailscale certificates, funnel, or a path-prefixed mount for the WebUI.
- No password or other auth in front of the WebUI.

## Risks

- **Shared `HERMES_HOME` with the gateway.** The WebUI writes sessions under
  `/opt/data/webui` and reads the same config the gateway reads. This is the upstream
  two-container layout's own assumption, and the reason the change is a single container is
  that it removes the second agent-source writer; the residual risk is concurrent file
  writes to unrelated subdirectories of `/opt/data`.
- **Rebuild drift.** `HERMES_WEBUI_REF` is an immutable commit, so the WebUI only changes
  when the pin does, and a tag moved upstream cannot change an unchanged Dockerfile.
- **CI cost and a credential-less boot.** The `hermes-webui-image` job pulls the
  `nousresearch/hermes-agent` base image and builds, so it runs only when its inputs change
  (`modules/hermes/`, `modules/docker-compose.yml`, or the workflow itself) and fails closed
  when it cannot resolve the diff base. The boot smoke test runs with no provider
  credentials: it asserts the WebUI service, its `/health` route from inside the container
  and through the published port, and one chat round trip against a stub agent, so a gateway
  or agent that cannot authenticate does not fail the gate. The real agent is proven after
  deployment by the operator's first chat, which is the only check that can use credentials.
- **Path-prefix move for the router.** Any client that hardcodes
  `https://your-host.your-tailnet.ts.net/v1` must move to `/router/v1`. No repository file
  references that hostname (checked), so the exposure is only external clients the operator
  points at it.
- **A loopback-only listener would pass every check and still be unreachable.** The
  container must bind `0.0.0.0` because compose publishes `127.0.0.1:8787` on the host; a
  listener on the container's own loopback is not reachable through the published port, so
  the tailnet route would have no backend while the in-container health checks all pass. The
  plan pins `HERMES_WEBUI_HOST=0.0.0.0` in the run script, the test asserts that value, and the
  CI smoke job curls the published host port from the runner, which is the only check that
  exercises the bind the operator actually uses.
