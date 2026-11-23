QUESTIONS
q: How is the server stack stopped and its data copied during the cutover, given that manual stop/restart on production is not allowed? | assumption: a one-off `workflow_dispatch` workflow (`migrate-host.yml`) running on the server runner does the stop, archive and copy, so the cutover goes through CI like every other production change. The alternative, a one-time manual run with Darren's explicit approval for that window, is listed under "Open decisions".
q: Should the laptop take over the `darren` tailnet name so phone, Dots and desktop clients keep their URLs? | assumption: yes. Rename the server node to `darren-server` and the laptop node to `darren`, then re-create the same `tailscale serve` mappings on the laptop. No client or `WEBAPP_PUBLIC_URL` change is needed.
q: Which host-level cron jobs on the server move with the stack? | assumption: only `fetch-claude-usage.py` (it feeds `/home/runner/data/codex-router`, which codex-router mounts). The other entries are owner tooling for the server's Claude/opencode sessions and stay. The `trigger-worker` entry posts to `localhost:8082`, where nothing listens today, so it is dead and is not ported.

# Move the Friday runtime from the server to the laptop

The production stack runs on a Celeron J3455 (4 cores, 8 GB, max 8 GB RAM) and is slow between model calls: Python request handling, the 2.3 GB `state.db`, tool runs and startup all run on a 2016 low-power CPU. Darren's laptop (Intel Core Ultra, 22 threads, 32 GB) is far faster. This plan moves the whole Docker Compose stack to a dedicated WSL2 distro on the laptop, keeps "merge to main, CI deploys" as the only shipping path, and keeps the server as a standby that can take the stack back.

Automatic failover is out of scope. While the laptop is off, asleep or away, Friday is down until it returns or the stack is moved back by hand (see Rollback).

## Decisions already made

- **Docker Compose, not k3s.** One machine, one copy of Hermes, a SQLite state file and a Compose-based deploy. k3s plus replicated storage (Piraeus/DRBD, Mayastor) needs three nodes, custom WSL kernels and synchronous writes over Wi-Fi; it is reconsidered only with three always-on wired nodes.
- **Docker Desktop with WSL integration** provides the engine inside the distro. Compose files are unchanged.
- **The whole stack moves**, not Hermes alone. Hermes reaches `codex-router`, `whisper` and the modules by compose service name; splitting machines would mean rewiring all of them.
- **Deploy target is a repository variable.** The deploy job's `runs-on` reads `vars.DEPLOY_RUNNER_LABEL`, defaulting to `self-hosted` (the server). Cutover and rollback are a variable change, not a code change.

## Current state (server, 2026-11-23)

- Runner: self-hosted on the server, default labels (`self-hosted`, `Linux`, `X64`). `deploy.yml` job `deploy` uses `runs-on: self-hosted` and environment `darren-prod`.
- Data on the host, all under `/home/runner/data`: `hermes/` (about 1.1 GB visible plus `hermes/data`, which includes `state.db`), `expense-tracker/`, `portfolio-tracker/` (including `onedrive_token`, `google-service-account.json`), `codex-router/`, plus secret files `hermes/friday_pat.secret` and `hermes/dots_fcm_service_account.json`.
- Named volumes the compose file uses: `modules_codex_router_state`, `modules_onedrive_data`, `modules_whisper_models` (models only; re-downloads, not copied). Other `modules_*` and `gateway_*` volumes are left over from retired services and are not copied.
- Published ports: most bind to `127.0.0.1` and are exposed on the tailnet with `tailscale serve` on `darren.taila8e105.ts.net`: `/router` → 4100, `/reminders` → 8300, and ports 8642, 8788, 8789, 9120, 10000 → 4096. `hermes` also binds `0.0.0.0:8644`, `codex-router` binds `0.0.0.0:4100`.
- Hermes mounts `/var/run/docker.sock`.
- Host cron entries: `fetch-claude-usage.py` every 5 minutes; others are server tooling (see Questions).

## Target state (laptop)

- WSL2 distro `Debian` (Debian 13), 16 GB memory, mirrored networking, drive automount and Windows interop off, systemd on.
- Docker Desktop (engine 29.0.1, Compose v2.40) via WSL integration; starts at sign-in.
- Runner `friday-laptop` with only the label `friday-laptop`, already registered as a systemd service. It takes no job until the variable points at it.
- Same `/home/runner/data` layout, owned by `darren` (the laptop runner's user).
- Tailscale inside the distro, node name `darren` after cutover, with the same `tailscale serve` mappings.
- SSH on port 2222, key-only, accepting only `darren@<prod-host>`, for server-to-laptop copy and maintenance.

## Changes in this repository

1. `.github/workflows/deploy.yml`: `runs-on: ${{ vars.DEPLOY_RUNNER_LABEL || 'self-hosted' }}`. No other change; behaviour is identical until the variable is set.
2. `.github/workflows/migrate-host.yml` (new, `workflow_dispatch` only, environment `darren-prod`, runs on the server runner):
   - `docker compose stop` for the modules project (data left in place).
   - Archive `/home/runner/data` and the two named volumes (`docker run --rm -v <vol>:/v alpine tar`).
   - Copy the archives to the laptop over the LAN with `rsync -e "ssh -p 2222"` using a deploy key held in the `darren-prod` environment, then verify checksums on both ends.
   - Never deletes anything on the server.
3. Port `fetch-claude-usage.py`'s cron to the laptop (a systemd timer created by the deploy, or a documented one-time step).

## Cutover runbook

Preparation (no downtime):
1. Tailscale in the laptop distro; disable key expiry for the node.
2. Docker Desktop "Start when you sign in"; Windows auto-login with the lock screen; critical battery action "Hibernate"; BIOS power-on with AC if available.
3. `mkdir -p /home/runner/data` on the laptop, owned by `darren`.
4. Merge change 1 (no-op) and change 2.
5. Dry run: `migrate-host.yml` with a `dry_run` input that archives and copies without stopping, to time the copy and confirm the laptop can restore it.

Window (Friday offline, estimate 15 to 30 minutes):
1. Pause merges to `main`.
2. Run `migrate-host.yml` (stops the server stack, archives, copies, verifies).
3. On the laptop, extract into `/home/runner/data` and restore the two volumes.
4. Set `DEPLOY_RUNNER_LABEL=friday-laptop`, then run `deploy.yml` with `force_all=true`.
5. Tailscale: rename the server node to `darren-server`, the laptop node to `darren`; re-create the `tailscale serve` mappings on the laptop.
6. Verify (below), then resume merges.

## Verification

- The deploy's own health checks pass on the laptop (`:4100/health/liveliness`, gateway `s6-svstat`).
- Telegram: a message gets a reply; a voice note is transcribed.
- Dots app and the desktop bar connect at the unchanged tailnet URLs.
- A cron job fires on schedule (next proactive tick).
- `state.db` row counts and the latest session match the server's copy at stop time.
- Server stack is stopped and stays stopped (no duplicate Telegram polling: no `409 Conflict` in either log).

## Rollback

1. Stop the laptop stack (workflow or by hand on the laptop).
2. Copy the laptop's `/home/runner/data` and volumes back to the server (reverse of `migrate-host.yml`).
3. Set `DEPLOY_RUNNER_LABEL=self-hosted`, run `deploy.yml` with `force_all=true`.
4. Swap the Tailscale node names back.

Skipping step 2 loses everything Friday did on the laptop since cutover.

## Known effects

- **Production inspection moves.** Claude sessions on the server inspect production through the local `docker.sock` today, and `hermes-wiki-sync.sh` copies the wiki out of the `hermes` container. Both need to go through SSH to the laptop after cutover.
- **Docker socket reach.** Hermes mounts `docker.sock`; under Docker Desktop that socket can start containers that mount the Windows C: drive. Accepted for now; the alternative is Docker Engine installed inside the distro.
- **Availability.** Laptop sleep, Windows updates and travel take Friday offline.
- **Parakeet.** The laptop already serves Parakeet speech-to-text on `127.0.0.1:8765` (CPU, about 1x real time on a 2.5 s clip). Wiring Hermes's `stt` command to it is a separate follow-up; the stack's own Whisper keeps working after the move.

## Open decisions

- Cutover mechanism: `migrate-host.yml` (recommended, through CI) or a one-time manual stop and copy on the server with Darren's explicit approval for that window.
- Cutover time.
