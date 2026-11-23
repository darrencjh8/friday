QUESTIONS
q: How does the email-intake plugin keep deduplicating against `dedup.db` once Hermes no longer shares a disk with expense-tracker? | assumption: a one-way sync copies expense-tracker's `data/` (including `dedup.db` and `wiki-proposals.jsonl`) from the server to the laptop every minute, read-only on the laptop as today. The build confirms that expense-tracker also rejects a duplicate booking on its own side, so a snapshot up to a minute old cannot double-book; if it does not, the plugin reads booked UIDs from an expense-tracker endpoint instead.
q: How do the module ports get reached from the laptop without opening them to the whole LAN? | assumption: the server binds `expense-tracker` (8080), `portfolio-tracker` (8081) and `whisper` (8000) to its LAN address in addition to `127.0.0.1`, and a `DOCKER-USER` iptables rule accepts those ports, plus `codex-router` (4100), only from the laptop's reserved address. Laptop address and server address come from repository variables, never literals in the repo.
q: How does the Hermes container reach Parakeet, which runs as a systemd service in the WSL distro on 127.0.0.1:8765? | assumption: through `host.docker.internal:8765`, which Docker Desktop routes to the Windows host and mirrored networking shares with the distro. The build checks this from inside the container first; if it does not answer, Parakeet's port is also bound to the laptop's LAN address and Hermes uses that.
q: Do clients (phone, Dots, desktop bar) need new URLs? | assumption: no. The server keeps the `darren` tailnet name and its `tailscale serve` entries; the entries that point at Hermes ports (8642, 8788, 9120, 8300) are re-pointed from `127.0.0.1` to the laptop's LAN address.

# Move Hermes to the laptop; keep the modules on the server

The server is a Celeron J3455 (4 cores, 8 GB, 8 GB maximum). Hermes is slow between model calls because its Python work, the 2.3 GB `state.db`, tool runs and startup all run on that CPU. Darren's laptop (Intel Core Ultra, 22 threads, 32 GB) is mostly unused and far faster.

This plan moves only the `hermes` service to a Linux container on the laptop (WSL2 plus Docker Compose). `codex-router`, `expense-tracker`, `actual-api`, `portfolio-tracker`, `dots-web` and `whisper` stay on the server. Hermes keeps the same image, seed and config, and "merge to main, CI deploys" stays the only shipping path for both machines.

Automatic failover is out of scope. While the laptop is off, Friday is down; the modules keep running on the server. Rollback moves Hermes back (see Rollback).

This replaces the earlier version of this plan, which moved the whole stack.

## Decisions already made

- **Hermes runs as the same Linux container**, not a native Windows install. A Windows install would be stock Hermes without Friday's seed, skills, scripts, plugins, cron jobs and CI-injected secrets, and merged PRs would no longer reach it.
- **No Swarm or k3s.** Hermes already calls the modules by compose service name (`codex-router:4100`, `expense-tracker:8080`, `portfolio-tracker:8081`, `whisper:8000`). On the laptop, `extra_hosts` maps those names to the server's LAN address, so no Hermes config or code changes. An overlay network would need Docker Engine instead of Docker Desktop and a deploy rewrite.
- **Docker Desktop with WSL integration** runs the laptop's container.
- **Deploy target per service.** The deploy job's runner comes from `vars.DEPLOY_RUNNER_LABEL` (default `self-hosted`, the server). A second job deploys `hermes` to the runner named by `vars.HERMES_RUNNER_LABEL` when it is set; when it is unset, `hermes` deploys to the server exactly as today.

## Current state (server, 2026-11-23)

- Runner on the server with default labels; `deploy.yml` job `deploy` on `runs-on: self-hosted`, environment `darren-prod`, running `modules/deploy.sh --component ...`.
- Hermes mounts `/home/runner/data/hermes/{data,workspace,sysstat}`, two secret files, `/var/run/docker.sock`, and `/home/runner/data/expense-tracker/data` read-only at `/opt/data/expense-tracker-data` (`dedup.db` for email intake, `wiki-proposals.jsonl` for the wiki refresh job).
- `expense-tracker` and `portfolio-tracker` mount Hermes's `data/home/wiki/entities/accounts` read-only at `/wiki/accounts` (mappings and `portfolio-sync-targets.md`).
- Hermes ports: `127.0.0.1` 8642, 8299, 8300, 8788, 9120 and `0.0.0.0:8644`. Tailnet entries on `darren.taila8e105.ts.net`: 8642, 8788, 9120, `/reminders` → 8300, `/router` → 4100, 8789 (dots-web), 10000 → 4096.
- Hermes's scripts use the Docker CLI for its own container and the module containers (`log-issue-triage-snapshot.sh`, `deploy-gateway-stop.sh`, `slack-manifest.sh`, `tuya.py` and skills).

## Target state

Laptop (`Debian` WSL2 distro, 16 GB, mirrored networking, automount and interop off):
- `hermes` container only, same image and mounts under `/home/runner/data/hermes`.
- `extra_hosts`: `codex-router`, `expense-tracker`, `portfolio-tracker`, `whisper` → server LAN address.
- Hermes ports bound to the laptop's LAN address (plus `127.0.0.1`), allowed through the Hyper-V firewall from the server only.
- Runner `friday-laptop` (label `friday-laptop` only), already registered.
- Synced copies: `/home/runner/data/expense-tracker/data` (server → laptop, read-only use).
- Speech-to-text: Parakeet (NVIDIA Parakeet TDT 0.6B v2, ONNX on CPU, the same server as the Friday desktop app) as a systemd service, already installed and verified on a test clip.

Server:
- All modules as today. `expense-tracker`, `portfolio-tracker`, `whisper` also published on the server's LAN address; `codex-router` already is.
- `DOCKER-USER` rule: those four ports accept the laptop's address only.
- Synced copy: `/home/runner/data/hermes/data/home/wiki/entities/accounts` (laptop → server, read-only use).
- `tailscale serve` Hermes entries point at the laptop.

## Changes in this repository

1. `deploy.yml`: `deploy` job `runs-on: ${{ vars.DEPLOY_RUNNER_LABEL || 'self-hosted' }}` and excludes `hermes` from its component list when `vars.HERMES_RUNNER_LABEL` is set. New `deploy-hermes` job on `runs-on: ${{ vars.HERMES_RUNNER_LABEL }}`, `if: vars.HERMES_RUNNER_LABEL != ''`, running `deploy.sh --component hermes` with the same secrets and variables. With the variable unset, behaviour is unchanged.
2. `modules/docker-compose.laptop.yml` (override, used only by `deploy-hermes`): `extra_hosts` from `vars.SERVER_LAN_HOST`, Hermes ports also bound to `vars.LAPTOP_LAN_HOST`.
3. `modules/docker-compose.yml` (server): `expense-tracker`, `portfolio-tracker`, `whisper` also published on `${SERVER_LAN_HOST}` when set; unset keeps today's bindings.
4. Folder sync, both directions over the existing laptop SSH (port 2222, key restricted to the server): a systemd timer on the server, every minute, `rsync` of `expense-tracker/data` to the laptop and of the laptop's `wiki/entities/accounts` back to the server. Installed by the deploy, logged, and alerting through the existing notify webhook after 10 failed minutes.
5. Remote Docker for module containers: Hermes's scripts that target `modules-*` containers use `DOCKER_HOST=ssh://<user>@<server>` with a dedicated key; commands that target the `hermes` container itself stay local. Each script is updated and tested individually.
6. `modules/hermes/config.yaml` `stt` command: convert the voice note to 16 kHz mono WAV with `ffmpeg`, send it to Parakeet's `/transcribe` with a 2 s connect timeout, and fall back to `whisper:8000/transcribe` on the server if Parakeet does not answer or errors. Tested with Parakeet up and with it stopped.
7. `.github/workflows/migrate-hermes.yml` (`workflow_dispatch`, server runner, `dry_run` input defaulting to `true`): archive `/home/runner/data/hermes` (via a root `alpine` container, since `data/` is container-owned), copy to the laptop with `rsync -e "ssh -p 2222"` using a deploy key in the `darren-prod` environment, verify checksums. With `dry_run=false` it stops only the server's `hermes` container first. It never deletes anything.

## Cutover runbook

Preparation (no downtime):
1. Router reservation for the laptop (done by Darren); Docker Desktop starts at sign-in; Windows auto-login with lock; critical battery action Hibernate.
2. Merge changes 1 to 7 with the new variables unset: production is unchanged.
3. Set `SERVER_LAN_HOST`, `LAPTOP_LAN_HOST`; deploy the server so the module ports and firewall rule are in place. From the laptop, `curl` each module health endpoint; from any other LAN device, confirm they are refused.
4. Dry run `migrate-hermes.yml` to time the copy.

Window (Friday offline, estimate 10 to 20 minutes):
1. Pause merges.
2. `migrate-hermes.yml` with `dry_run=false`: stops server `hermes`, archives, copies, verifies.
3. Extract on the laptop into `/home/runner/data/hermes`.
4. Set `HERMES_RUNNER_LABEL=friday-laptop`; run `deploy.yml` with `force_all=true`. The server job skips `hermes`; `deploy-hermes` starts it on the laptop.
5. Enable the sync timer; re-point the `tailscale serve` Hermes entries on the server to the laptop.
6. Verify, then resume merges.

## Verification

- `deploy-hermes` health checks pass on the laptop (gateway `s6-svstat`); the server deploy's checks pass for the modules.
- From inside the laptop's `hermes` container: `codex-router:4100/health/liveliness`, `expense-tracker:8080`, `portfolio-tracker:8081`, `whisper:8000/health` all answer.
- Telegram reply; a voice note is transcribed by Parakeet (Parakeet log line) and, with Parakeet stopped, by the server's Whisper; Dots and the desktop bar connect at unchanged URLs, the next proactive tick fires.
- Email intake in shadow mode books nothing twice against a test message already in `dedup.db`.
- `expense-tracker` and `portfolio-tracker` read a mapping change made in the laptop's wiki within two minutes.
- Only one `hermes` container is running across both machines (no Telegram `409 Conflict`).

## Rollback

1. `migrate-hermes.yml` in reverse (laptop → server) with Hermes stopped on the laptop.
2. Unset `HERMES_RUNNER_LABEL`; run `deploy.yml` with `force_all=true`; `hermes` returns to the server.
3. Re-point the `tailscale serve` entries to `127.0.0.1`; disable the sync timer.

Skipping step 1 loses everything Friday did on the laptop since cutover.

## Known effects

- **Production inspection splits.** Hermes, its logs and `/opt/data` are on the laptop; modules are on the server. Claude sessions and `hermes-wiki-sync.sh` reach Hermes over SSH to the laptop.
- **Every model call crosses Wi-Fi** to `codex-router` on the server and back. That is a few milliseconds against multi-second model calls.
- **Docker socket reach.** Under Docker Desktop, Hermes's `docker.sock` can start containers that mount the Windows C: drive. Accepted for now.
- **Availability.** Laptop sleep, Windows updates and travel take Hermes offline; modules on the server keep running but are only reachable through Hermes.
- **Whisper stays on the server as the speech-to-text backup only.** Parakeet is on the same machine as Hermes, so the backup is used only if the Parakeet process fails. Idle, Whisper unloads its model (24 MB measured).

## Open decisions

- Cutover time.
