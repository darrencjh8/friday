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
- **Deploy target per service.** The deploy job's runner comes from `vars.DEPLOY_RUNNER_LABEL` (default `self-hosted`, the server). A second job deploys `hermes` to the `friday-laptop` runner when the target is `friday-laptop`: the `hermes_target` dropdown on a manual run (default `friday-laptop`), or on a push to main a default written in `deploy.yml` (`server` until cutover). With `server`, `hermes` deploys to the server exactly as today.

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
- Stays on the tailnet as `darren.taila8e105.ts.net` and remains the only address clients use: the Dots Android app, the desktop bar and the phone connect to the server, and its `tailscale serve` Hermes entries proxy to the laptop's LAN address. The laptop does not need to join the tailnet. While the laptop is off, those entries return a gateway error and the app shows Friday offline.

## Changes in this repository

1. `deploy.yml`: `deploy` job `runs-on: ${{ vars.DEPLOY_RUNNER_LABEL || 'self-hosted' }}` and excludes `hermes` from its component list when the hermes target is `friday-laptop`. New `deploy-hermes` job on `runs-on: friday-laptop`, gated on that target, running `deploy.sh --component hermes` with the same secrets and variables. With the target `server`, behaviour is unchanged.
2. `modules/docker-compose.laptop.yml` (override, used only by `deploy-hermes`): `extra_hosts` from `vars.SERVER_LAN_HOST`, Hermes ports also bound to `vars.LAPTOP_LAN_HOST`.
3. `modules/docker-compose.yml` (server): `expense-tracker`, `portfolio-tracker`, `whisper` also published on `${SERVER_LAN_HOST}` when set; unset keeps today's bindings.
4. Folder sync, both directions over the existing laptop SSH (port 2222, key restricted to the server): a systemd timer on the server, every minute, `rsync` of `expense-tracker/data` to the laptop and of the laptop's `wiki/entities/accounts` back to the server. Installed by the deploy, logged, and alerting through the existing notify webhook after 10 failed minutes.
5. Remote Docker for module containers: Hermes's scripts that target `modules-*` containers use `DOCKER_HOST=ssh://<user>@<server>` with a dedicated key; commands that target the `hermes` container itself stay local. Each script is updated and tested individually.
6. `modules/hermes/config.yaml` `stt` command: convert the voice note to 16 kHz mono WAV with `ffmpeg`, send it to Parakeet's `/transcribe` with a 2 s connect timeout, and fall back to `whisper:8000/transcribe` on the server if Parakeet does not answer or errors. Tested with Parakeet up and with it stopped.
7. `.github/workflows/migrate-hermes.yml` (`workflow_dispatch`, server runner, environment `darren-prod`, concurrency group `production-deploy`; inputs `dry_run`, default `true`, and `direction`, `to-laptop` or `to-server`): checks free space on both machines, archives `/home/runner/data/hermes` with `tar --numeric-owner` in a root `alpine` container (since `data/` is container-owned), copies archive and SHA-256 with `rsync -e "ssh -p 2222"` using the `LAPTOP_SSH_KEY` secret, and verifies the checksum on the receiving side. Both directions run on the server, because the laptop key only authorizes server-to-laptop logins: `to-server` pulls. With `dry_run=false`, `to-laptop` first stops only the server's `hermes` container and refuses if hermes runs on the laptop; `to-server` refuses if hermes runs on either machine. It then moves any existing `hermes` directory on the receiving side to `hermes.bak-<UTC timestamp>` and extracts. If a real `to-laptop` run fails or is cancelled after stopping the server's hermes, it starts it again. It deletes only its own archive and checksum. Docker over SSH on the laptop uses `DOCKER_CONFIG=/home/darren/.docker-friday`.

## Cutover runbook

Preparation (no downtime):
1. Router reservation for the laptop (done by Darren); Docker Desktop starts at sign-in; Windows auto-login with lock; critical battery action Hibernate.
2. Merge changes 1 to 7 with the new variables unset: production is unchanged.
3. Set `SERVER_LAN_HOST`, `LAPTOP_LAN_HOST`; deploy the server so the module ports and firewall rule are in place. From the laptop, `curl` each module health endpoint; from any other LAN device, confirm they are refused.
4. Run `migrate-hermes.yml` with the defaults (`dry_run=true`, `to-laptop`) to time the copy and check free space. Hermes keeps running, so this copy is not consistent; it is deleted at the end and nothing is extracted.

Window (Friday offline, estimate 10 to 20 minutes):
1. Pause merges.
2. `migrate-hermes.yml` with `dry_run=false`, `direction=to-laptop`: stops the server's `hermes`, archives, copies, verifies, and extracts into the laptop's `/home/runner/data/hermes` (an existing directory there is moved to `hermes.bak-<timestamp>`). The server's `hermes` stays stopped; on failure the workflow starts it again.
3. Check the run log: checksum `OK` and the extracted size.
4. Merge the cutover PR that changes the push default in `deploy.yml` to `friday-laptop`, then run `deploy.yml` with `force_all=true` and `hermes_target=friday-laptop`. The server job skips `hermes`; `deploy-hermes` starts it on the laptop.
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

1. Stop Hermes on the laptop, then run `migrate-hermes.yml` with `dry_run=false`, `direction=to-server`. The server pulls the laptop's data and moves its own stale copy to `hermes.bak-<timestamp>` before extracting.
2. Run `deploy.yml` with `force_all=true` and `hermes_target=server`, and revert the push default to `server`; `hermes` returns to the server.
3. Re-point the `tailscale serve` entries to `127.0.0.1`; disable the sync timer.

Skipping step 1 loses everything Friday did on the laptop since cutover.

## Known effects

- **Production inspection splits.** Hermes, its logs and `/opt/data` are on the laptop; modules are on the server. Claude sessions and `hermes-wiki-sync.sh` reach Hermes over SSH to the laptop.
- **Every model call crosses Wi-Fi** to `codex-router` on the server and back. That is a few milliseconds against multi-second model calls.
- **Docker socket reach.** Under Docker Desktop, Hermes's `docker.sock` can start containers that mount the Windows C: drive. Accepted for now.
- **Availability.** Laptop sleep, Windows updates and travel take Hermes offline; modules on the server keep running but are only reachable through Hermes.
- **Whisper stays on the server as the speech-to-text backup only.** Parakeet is on the same machine as Hermes, so the backup is used only if the Parakeet process fails. Idle, Whisper unloads its model (24 MB measured).

## `dots-web` stays on the server

`dots-web` (tailnet port 8789) stays. Besides the web app, it hosts the `/api/pair` relay that the desktop bar and the Android app use to pair; Hermes has no equivalent endpoint. After pairing, both clients talk to Hermes directly.

## Open decisions

- Cutover time.
