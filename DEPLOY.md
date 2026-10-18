# Friday — Deployment

## Production Server

- **Host:** `<prod-host>` (SSH config alias: `<prod-host>`)
- **User:** `darren` (sudoer)
- **Auth:** SSH key at `~/.ssh/id_ed25519`
- **Project root:** `~/friday`
- **Services:** Docker Compose at `~/friday/modules/docker-compose.yml`

Manual deploys on production are forbidden. Merging to `main` is the only shipping path.

## Repository Layout

```
friday/
├── modules/                       # All services + Compose
│   ├── docker-compose.yml         # expense-tracker, actual-api, portfolio-tracker, codex-router, hermes
│   ├── build.sh                   # Build images (--component, defaults to all)
│   ├── deploy.sh                  # Env validation + compose up (--component required)
│   ├── hermes/                    # Hermes image: config.yaml, skills/, profiles/, scripts/, 50-seed-defaults
│   ├── portfolio-tracker/         # Node.js/ESM service (REST /tools/*, MCP /mcp)
│   ├── expense-tracker/
│   ├── actual-api/
│   ├── image-gen/
│   ├── codex-router/              # Checked out from darrencjh8/codex-router by CI (not tracked here)
│   └── codex-router-front/        # Caddy config for the front that publishes 4100
├── .github/workflows/deploy.yml   # CI/CD entry point
└── specs/                         # Spec-Kit feature specs
```

There is no `gateway/` directory in the repository (`git ls-files gateway` returns nothing). The OpenClaw gateway stack and its `docker-compose.override.yml`, `openclaw.json`, and `workspace/skills/` are retired. Compose lives at `modules/docker-compose.yml`.

## Deployment Flow (CI/CD)

`.github/workflows/deploy.yml` runs on push to `main` on the self-hosted runner:

1. **Trigger:** push to `main`, plus `workflow_dispatch`. Serialized by concurrency group `production-deploy` (`cancel-in-progress: false`).
2. **Checkout:** the repo, then `darrencjh8/codex-router@main` into `modules/codex-router`.
3. **Detect changed modules** (`git diff --name-only HEAD~1 HEAD`):
   - `modules/hermes/`, `gateway/`, `.github/` → `hermes`
   - `modules/expense-tracker/` → `expense-tracker`
   - `modules/portfolio-tracker/` → `portfolio-tracker`
   - `modules/actual-api/` → `actual-api`
   - changes to `.github/workflows/deploy.yml`, `modules/docker-compose.yml`, or `modules/deploy.sh` → `codex-router`
   - changes to `modules/codex-router-front/` → `codex-router`
   - root `Dockerfile` / `deploy.sh` / `modules/docker-compose.yml`, or nothing matched → `all`
   - The `gateway/` rule is a vestige; that directory no longer exists.
4. **Create data dirs:** `mkdir -p /home/runner/data/{expense-tracker/data,portfolio-tracker/data,hermes/{data,workspace},codex-router}`.
5. **Build:** `bash ./modules/build.sh` (all) or `bash ./modules/build.sh --component <c> ...`.
6. **Deploy:** `bash ./modules/deploy.sh --component all --non-interactive --skip-build`, or one `--component <c>` per detected component. `GITHUB_ACTIONS=true` makes `deploy.sh` read secrets from the environment instead of `.env` files.
7. **Record:** the deployed codex-router revision is written to `codex-router-sha.txt` and uploaded as a workflow artifact.

`--skip-build` is essential in CI: without it, `deploy.sh` runs its own `git pull` and image build, bypassing the pipeline's change detection and health gate.

### Rolling codex-router update

codex-router is served by three containers: the caddy front `codex-router`, which owns
`0.0.0.0:4100`, and the two identical router colours `codex-router-a` and `codex-router-b`, which
publish no ports. `modules/build.sh` builds the colours and skips the front, which is a stock
`caddy:2.11.7-alpine` image (pinned: `deploy.sh` never pulls, so a floating tag would keep the
stale local image, and 2.11.6 cut HTTP/1.1 POST streams off 60s after the body was read).
`deploy.sh` never brings the colours up as a group; after the generic
`compose up` it rolls them:

1. Pick the running colour that is not serving, defaulting to `codex-router-a`. A colour counts as
   running only if `docker ps` names it and it answers `/health/liveliness`; if `docker ps` fails and
   the stack's containers cannot be read at all, the roll stops before starting or stopping anything
   and the next scheduled deploy retries from the same state.
2. `compose up -d --force-recreate codex-router-a` (or `-b`) and wait for `/health/liveliness` on that
   colour. The recreate is deliberate: a colour that runs but never answers is the idle colour on
   every roll, and a plain `up -d` is a no-op on an unchanged container, so that candidate would be
   re-selected and the deploy would fail every time.
3. Start the front if it is not running (its first start is the cutover from the pre-roll layout),
   then reload its Caddyfile, retrying a failed reload a bounded three times: `up -d` returns when
   the container starts, not when caddy has bound its admin listener, so the reload on that path can
   land on a booting front. A front that is already running is left alone: it owns the only
   published listener, and `up -d` would recreate it if its stanza or image changed. Because of that,
   a change to the front's own compose stanza (image, memory limit, healthcheck) is applied only by a
   deploy with `force_all=true`.
4. `compose stop -t "$ROUTER_DRAIN_SECONDS" <old colour>` (default 600s) so in-flight streams finish;
   both colours carry `stop_grace_period: 10m` for the same reason.

`deploy.sh` identifies the front by the `modules.role=codex-router-front` label rather than by its
compose service name, because the legacy router container uses that same service name until the
cutover replaces it. That lookup follows the same rule as the colour probe: a failed `docker ps` is
inconclusive, so the front is left exactly as it is rather than started with `up -d` (which would
recreate the one container that owns `0.0.0.0:4100` and drop every in-flight stream), even under
`force_all=true`, and the next scheduled deploy retries from the same state. Only a lookup that
proves the front is absent starts it. The Caddyfile reaches the front as a bind-mounted directory
(`./codex-router-front:/etc/caddy:ro`), not as a single mounted file: a checkout that replaces the
file's inode would otherwise leave the mount pointing at the old one. A colour name is accepted as a
component name (`--component codex-router-a`) and means `codex-router`: `deploy.sh` rewrites it
before the preflight and `build.sh` builds both colours for it.

The front's Caddyfile uses `lb_policy first` with the upstreams written `codex-router-a` then
`codex-router-b`, `lb_try_duration 30s` so a request that lands on a stopping colour is retried, and
`flush_interval -1` so streaming responses are not buffered. If the new colour never becomes ready
the deploy fails without moving the front, and the previously serving colour keeps serving.

### Claude Pro usage snapshot (codex-router admin UI)

`modules/fetch-claude-usage.py` polls the Claude subscription usage endpoint every
5 min and publishes a sanitized JSON file the router colours read through a
read-only **directory** bind mount (`/home/runner/data/codex-router` →
`/claude-usage`, env `CODEX_ROUTER_CLAUDE_USAGE_FILE=/claude-usage/claude-usage.json`).
The directory (not file) bind is load-bearing: the helper publishes via atomic
tmp+rename, and a renamed file orphans a file bind at the old inode — the
container then freezes at the deploy-time snapshot while the host file stays
fresh. The recurring run lives in **darren's** crontab, not
runner's: the Claude CLI rewrites its credentials file with chmod 600 on every
token refresh, which resets the POSIX ACL mask and silently revokes a runner
read grant, so runner cron can never run this reliably. One-time setup as
darren (re-run never needed; deploy keeps the output dir writable):

```
*/5 * * * * /usr/bin/python3 /home/runner/actions-runner/_work/friday/friday/modules/fetch-claude-usage.py >/dev/null 2>&1
```

(`deploy.sh` makes the output dir group-writable via the shared docker group
and adds traverse-only (o+x, no read) on `/home/runner` + `/home/runner/data` —
without it darren's cron cannot reach the leaf, since `/home/runner` is 700 —
and removes any runner-crontab leftover for this helper on every codex-router
deploy.)

Collector failures preserve the last good snapshot and emit one system-log
warning with the prefix `claude-usage: collection failed:`. Only the category
is recorded: `http_<numeric status>`, `network`, `invalid_data`, `filesystem`, or
`unexpected`. Exception messages, response bodies, URLs, paths, and credentials
are never logged. Successful runs remain quiet. An authorized host operator can
search the system journal for that prefix; reading system logs may require
administrator access. Logging failure never changes snapshot preservation or
the collector's nonzero failure exit.

The user-owned cron entry must reference the **current deployed checkout** shown
above. A schedule still pointing at a retired checkout keeps executing its old
helper, even after a successful deployment of this repository. Deploy does not
migrate that user's crontab; schedule changes require a separately approved
operator action. Diagnostics improve evidence for future failures, not the
freshness of a snapshot whose collector has not succeeded.

### How an environment variable reaches the gateway

A deploy variable travels `deploy.yml` job env → `modules/docker-compose.yml`
`environment:` → the container's process environment. That is enough for tools
and CLIs that read `os.environ`, and `deploy.sh` validates the platform
allowlists (`SLACK_ALLOWED_USERS`, `TELEGRAM_ALLOWED_USERS`) so a deploy cannot
start a bot nobody can talk to. It is **not** enough for a hermes authorization
allowlist: hermes authorizes a chat caller through the per-profile secret scope
built from `$HERMES_HOME/.env`, and with `gateway.multiplex_profiles: true` a
value that exists only in the container environment reads back empty — the bot
connects and then rejects every caller as unauthorized.

`modules/hermes/50-seed-defaults` closes that gap on every boot by mirroring
each deployed `*_ALLOWED_USERS` into `$HERMES_HOME/.env` (the environment wins,
an unset variable never deletes a key, and the file is replaced atomically at
mode 600). A new allowlist therefore needs no Dockerfile change and no volume
hand-edit: set the variable — a GitHub variable for GHA, `modules/hermes/.env`
for a local deploy — and redeploy.

## Entry Points

### `modules/build.sh`

Builds Docker images with no downtime. Accepts repeatable `--component <name>`; with no component it defaults to `all`. Runs `docker-compose --project-name modules build <services>`. When `portfolio-tracker` (or `all`) is included it first builds `pp-cli.jar` (installs the vendored `pp-cli/lib/name.abuchen.portfolio-0.84.1.jar` into local Maven, then `mvn package`).

```bash
./modules/build.sh --component hermes --component portfolio-tracker
```

### `modules/deploy.sh`

Validates every component's required env vars, then runs `docker-compose --project-name modules up -d`. On GitHub Actions it reads secrets from the environment; locally it reads each module's `.env`. It also ensures the shared `hermes_shared` Docker network and the Hermes workspace exist, and runs health checks afterwards.

```bash
./modules/deploy.sh --component <name> [--component <name>...] [--non-interactive] [--skip-build]
```

- `--component` is **required**; with none it prints usage and exits 1. Choices printed by the script: `all`, `hermes`, `portfolio-tracker`, `expense-tracker`, `actual-api`, `image-gen`, `codex-router`.
- `--non-interactive` skips the OneDrive auth prompt.
- `--skip-build` skips the built-in `git pull` + `docker-compose build` (used by CI, which builds in a separate step).

## Fresh Install

Prerequisite: Docker and Docker Compose.

```bash
git clone <repo-url> ~/friday
cd ~/friday

# Portfolio Tracker (also supplies Actual Budget credentials to actual-api)
cp modules/portfolio-tracker/.env.example modules/portfolio-tracker/.env
# Edit: required vars are listed by guardEnv() in modules/portfolio-tracker/src/index.js

# Expense Tracker
cp modules/expense-tracker/.env.example modules/expense-tracker/.env
# Edit: LLM_*, ACTUAL_*, IMAP_*, NOTIFY_URL, TELEGRAM/HERMES_* as configured

# Image Gen
cp modules/image-gen/.env.example modules/image-gen/.env
```

Hermes reads its configuration and secrets from the environment (CI injects them as secrets and vars) or from `modules/hermes/.env` locally; there is no `modules/hermes/.env.example`.

Deploy locally (never on production):

```bash
./modules/deploy.sh --component all --non-interactive
```

## Module Registration

A module is a Docker image that:

1. Exposes `/health` (compose health check), REST `/tools/*`, and an MCP endpoint at `/mcp`.
2. Is declared as a service in `modules/docker-compose.yml`.
3. Is registered as an MCP server in `modules/hermes/config.yaml` under `mcp_servers:`:

```yaml
mcp_servers:
    expense-tracker:
        url: http://expense-tracker:8080/mcp
    portfolio-tracker:
        url: http://portfolio-tracker:8081/mcp
```

Compose runs with project name `modules`, so the default container names are `modules-<service>-1` (for example `modules-portfolio-tracker-1`); `hermes` sets `container_name: hermes`.

`deploy.sh` additionally auto-discovers pluggable modules from `modules/*/module.env`. No module currently ships a `module.env`, so this path is unused today.

## Hermes Skills and Profiles

Skills and profiles are baked into the Hermes image and seeded onto the data volume at boot:

- `modules/hermes/Dockerfile` copies `config.yaml`, `SOUL.md.template`, `skills/`, `scripts/`, and `profiles/` into `/opt/hermes-defaults/`, then installs `50-seed-defaults` as `/etc/cont-init.d/50-seed-defaults`.
- On boot, `modules/hermes/50-seed-defaults`:
  - merges `/opt/hermes-defaults/config.yaml` into `/opt/data/config.yaml` (baked keys win; top-level keys the baked config does not define are carried over),
  - seeds `SOUL.md` only if absent,
  - copies `skills/*` into `/opt/data/skills/` and `scripts/*` into `/opt/data/scripts/`,
  - creates `/opt/data/memories/topics/INDEX.md`,
  - seeds each profile into `/opt/data/profiles/<name>/{config.yaml,SOUL.md,profile.yaml}` (only if absent), removes retired profiles (`static-analyst`, `qa-engineer`, `quality-assurance`), and registers each with `hermes profile create <name> --no-alias`.
- `modules/hermes/scripts/sync-codex-router-skills.sh` reconciles codex-router's canonical skills (staged at `/opt/data/.codex-router-skills` by the deploy) into the managed roots `/opt/data/skills`, `/opt/data/.agents/skills`, and `/opt/data/home/.agents/skills`. A skill removed from the canonical source is removed from every root.
- `modules/hermes/scripts/refresh-codex-router-checkout.sh` advances the container's own codex-router checkout at `/workspace/codex-router`, which is where dev-loop sessions execute the driver from (`codex/skills/dev-loop/scripts/loop.py`). The deploy runs it with the revision it checked out; the boot hook runs it with no target so it tracks `origin/main`. It skips a checkout that is dirty, on another branch, or absent, and exits non-zero when a clean checkout cannot reach the target. It never forces, so a checkout that diverged from `origin/main` (after a force-push, say) keeps failing every deploy; the checkout has to exist before it can be advanced (a session creates it by cloning; the script skips an absent path and the deploy says so), and the recovery is run in the hermes container as its `hermes` owner: `docker exec -u hermes hermes sh -c 'git -C /workspace/codex-router -c credential.helper="!gh auth git-credential" fetch origin main && git -C /workspace/codex-router reset --hard origin/main'` (the outer single quotes keep the `!` away from the interactive shell's history expansion, which would otherwise rewrite or refuse the helper) (a helper is required because the container's git has none and the remote is HTTPS: the script itself prefers the PAT its caller exports as `GH_TOKEN` and falls back to gh's helper, which is the one this interactive recipe names because a shell has no exported PAT, and the reset discards whatever the checkout holds — uncommitted changes and any local commit of its own).

## Adding a New Pluggable Module

1. Build a Docker image exposing `/health`, `/tools/*`, and `/mcp`.
2. Add its service to `modules/docker-compose.yml`.
3. Register its MCP server in `modules/hermes/config.yaml` under `mcp_servers:`.
4. If it needs agent-facing instructions, add `modules/hermes/skills/<module>/SKILL.md`; the boot seed copies it into `/opt/data/skills/`.
5. Ship via a merge to `main` — CI detects the changed `modules/<module>/` path and deploys it.

<!-- TODO(verify): confirm whether a module.env pattern in modules/deploy.sh is intended for future pluggable modules; no module currently ships one. -->
