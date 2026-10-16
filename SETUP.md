# Friday — Linux Machine Setup

Production server running Hermes Agent and supporting services via Docker Compose (`modules/docker-compose.yml`).

## Machine

| Detail | Value |
|--------|-------|
| Hostname | `darren` |
| IP | `<prod-host>` |
| OS | Debian-based Linux |
| Docker | 26.1.5 |

---

## Users & Groups

| User | UID | Groups | Purpose |
|------|-----|--------|---------|
| `darren` | 1000 | `docker`, `sudo` | Admin SSH, git deploys |
| `runner` | 1001 | `docker` | GitHub Actions runner |

Both users are in the `docker` group — either can run `docker` commands.

---

## Directory Layout

```
/home/
├── darren/                        # darren home
│   └── friday/           # Git repo (deployed from here)
└── runner/                        # runner home (drwx------)
    └── data/                      # Persistent data root
        ├── hermes/
        │   ├── data/              # → /opt/data in hermes container
        │   └── workspace/         # → /workspace in hermes container
        ├── expense-tracker/
        │   └── data/              # → /app/data in expense-tracker container
        ├── portfolio-tracker/
        │   ├── data/              # → /app/data in portfolio-tracker container
        │   ├── onedrive_token/    # → /app/config/onedrive in portfolio-tracker
        │   │   └── refresh_token  # OneDrive OAuth refresh token (file)
        │   └── google-service-account.json  # → /app/config/ in portfolio-tracker (ro)
```

`.github/workflows/deploy.yml` pre-creates `expense-tracker/data`, `portfolio-tracker/data`, and `hermes/{data,workspace}` on every deploy (`mkdir -p /home/runner/data/...`). The `onedrive_token/` and `google-service-account.json` paths are created out-of-band and mounted read-write/read-only by `modules/docker-compose.yml`.

---

## Permissions Model

### Problem: Container UID ≠ Host UID

Docker containers create files owned by their internal user (e.g. `hermes` = UID 10000).
On the host, UID 10000 maps to `UNKNOWN`. Only root can access these files.

### Current State

| Directory | Host Permissions | Owner | Accessible by runner? |
|-----------|-----------------|-------|----------------------|
| `/home/runner/data/hermes/data` | `drwx------` (700) | 10000:10000 | ❌ |
| `/home/runner/data/hermes/workspace` | owned by runner | runner | ✅ |
| `/home/runner/data/expense-tracker/data` | (container creates) | 1000:1000 | ✅ |
| `/home/runner/data/portfolio-tracker/*` | (varies) | (varies) | TBD |

### How to Fix Cross-User Access

When container-created directories block host users, use the one-liner:

```bash
sudo find /home/runner/data -maxdepth 3 -type d ! -perm /g+r \
    -exec chgrp runner {} \; -exec chmod 750 {} \;
sudo find /home/runner/data -maxdepth 3 -type f ! -perm /g+r \
    \( -name "*.yml" -o -name "*.yaml" -o -name "*.md" \
       -o -name "*.json" -o -name ".gh_token" -o -name "*.env" \) \
    -exec chmod 640 {} \;
```

This changes the group to `runner` and adds group read permission without touching the owner.

> **Note**: Container recreates files on restart, so this may need to be re-run after container restarts. Consider adding to a boot script or cron.

---

## Docker Services

| Service | Container | Host Port | Internal Port | Healthcheck |
|---------|-----------|-----------|---------------|-------------|
| Hermes | `hermes` | 8642, 9119, 8644 | same | waits on expense-tracker + portfolio-tracker |
| Expense Tracker | `modules-expense-tracker-1` | 127.0.0.1:8080 | 8080 | `/health` |
| Portfolio Tracker | `modules-portfolio-tracker-1` | 127.0.0.1:8081 | 8081 | `/health` |
| Actual API | `modules-actual-api-1` | 127.0.0.1:3000 | 3000 | — |
| Codex Router (front) | `modules-codex-router-1` | 0.0.0.0:4100 | 4100 | `/health/liveliness` |
| Codex Router (colours) | `modules-codex-router-a-1`, `modules-codex-router-b-1` | — | 4100 | `/health/liveliness` |

Expense Tracker, Portfolio Tracker, and Actual API bind to `127.0.0.1` (localhost only). Hermes publishes `9119` and `8644` on all interfaces and `8642` (the API server) on `127.0.0.1` only, and the Codex Router front publishes `4100` on all interfaces so Hermes providers can reach `http://codex-router:4100/v1`.

Codex Router is three containers: the caddy front `codex-router`, which owns port 4100, and the two identical router colours `codex-router-a` and `codex-router-b`, which publish nothing and are only reachable through the front. A deploy replaces one colour at a time, so 4100 keeps serving.

---

## Named Volumes

| Volume | Mounted To | Service |
|--------|-----------|---------|
| `onedrive_data` | `/data/onedrive` | portfolio-tracker |
| `codex_router_state` | `/app/state` | codex-router-a, codex-router-b |

Named volumes live at `/var/lib/docker/volumes/` — managed by Docker, not directly accessible.

---

## Deploy

Shipping is CI/CD only: pushing to `main` triggers `.github/workflows/deploy.yml` on the self-hosted runner, which detects changed components, builds with `modules/build.sh`, then runs `modules/deploy.sh <components> --non-interactive --skip-build`. A codex-router deploy is a rolling update: `deploy.sh` starts the idle colour, waits for its `/health/liveliness`, moves the front to it, then stops the previously serving colour after a `ROUTER_DRAIN_SECONDS` (default 600) drain.

Never run `modules/deploy.sh` (or `git pull`) manually on this host. Without `--skip-build`, `modules/deploy.sh` performs its own `git pull` and image build, which bypasses the pipeline's change detection and health gate. Merges to `main` are the only shipping path.

`modules/deploy.sh` requires at least one `--component`. Available: `all`, `hermes`, `portfolio-tracker`, `expense-tracker`, `actual-api`, `image-gen`, `codex-router`. Running it with no component prints usage and exits 1.

---

## OneDrive Token Path

| Context | Path |
|---------|------|
| Host | `/home/runner/data/portfolio-tracker/onedrive_token/refresh_token` |
| Container (portfolio-tracker) | `/app/config/onedrive/refresh_token` |

---

## Key Files on Host

| File | Purpose |
|------|---------|
| `/home/runner/data/hermes/friday_pat.secret` | Scoped fallback PAT, bind-mounted read-only as `/run/secrets/friday_pat` for the boot-time codex-router checkout refresh |
| `/home/runner/data/hermes/data/.gh_token` | Retired: the installation token is supplied through gh's own `hosts.yml`, never a flat file |
| `/home/runner/data/hermes/data/config.yaml` | Hermes gateway config |
| `/home/runner/data/hermes/data/SOUL.md` | Agent personality |
| `/home/runner/data/hermes/data/cron/jobs.json` | Cron job definitions |
| `/home/runner/data/hermes/data/memories/MEMORY.md` | Long-term memory (backed up to git) |
| `/home/runner/data/portfolio-tracker/onedrive_token/refresh_token` | OneDrive OAuth token |
| `/home/runner/data/portfolio-tracker/google-service-account.json` | Google Sheets API key |

---

## Cron Jobs (inside hermes container)

| Job | Schedule | Purpose |
|-----|----------|---------|
| `ops-github-token-refresh` | Every 15 min | Refresh GitHub App installation token |
| `memory-backup` | Every 360 min | Backup memories to private git repo |
| `finance-portfolio-sync` | Daily at 12:00 SGT (container `Asia/Singapore`) | Zero-token `POST /tools/pp-sync-all` portfolio sync |
| `wiki-due-reminders` | Daily at 08:15 | Wiki due-date reminders |
| `memory-approve-queue` | Daily at 08:00 | Drain the memory write-approval queue |
| `ops-log-issues` | Daily at 18:30 | Daily log issue triage (artifact-only workdir) |
| `wiki-repo-docs` | Mondays at 03:30 | Wiki repo docs refresh |
| `wiki-finance-refresh` | Mondays at 04:00 | Wiki finance refresh |
| `memory-compact` | Sundays at 07:30 | Weekly merge of duplicate MEMORY.md / USER.md entries under their caps |
| `memory-mnemosyne-vacuum` | Sundays at 03:00 | Mnemosyne VACUUM report (no_agent) |
| `skills-merge-proposals` | Sundays at 04:15 | Skill merge proposals (no_agent) |

Check status:

```bash
docker exec hermes python3 -c "
import json
with open('/opt/data/cron/jobs.json') as f:
    data = json.load(f)
for j in data['jobs']:
    print(f\"{j['name']}: {j['last_status']}\")"
```
