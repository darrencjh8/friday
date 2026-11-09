QUESTIONS
q: Which directory does sa1 write to on this image — /var/log/sa or /var/log/sysstat? | a: /var/log/sysstat (Debian sysstat default — sysstat(5): SA_DIR defaults to /var/log/sysstat; /var/log/sa is the RHEL/upstream default). Implementation verifies it in the built image (and the SA_DIR value in /etc/sysstat/sysstat) and adjusts if it differs.
q: Which mechanism runs sa1 every 2 minutes — an s6 service inside the container, or host cron calling docker exec? | a: An s6 longrun service inside the image. It is fully automated by deploy (image + compose flow through CI/CD); host cron needs a one-time manual line in darren's crontab that deploy.sh cannot install (deploy.sh:1246-1282, fetch-claude-usage precedent) and silently collects nothing if the line is missing.
q: Where does the sa history persist so it survives container recreates? | a: Host bind /home/runner/data/hermes/sysstat mounted to /var/log/sysstat in the hermes service (modules/docker-compose.yml).
q: How is the 28-day retention enforced without a cron daemon? | a: The collector loop prunes sa files older than 28 days once a day. /etc/sysstat/sysstat HISTORY is irrelevant — it only drives the Debian cron scripts, which are not used.
q: How is the sar verification done, and what proves the numbers are the host's? | a: Post-deploy, with Darren's approval: docker exec hermes sar -u and sar -r against today's sa file; CPU count and ~8 GB total memory match the host. This is the hard gate before codex-router PR #496 merges.
q: Does the volume need a deploy.sh mkdir like the claude-usage dir? | a: No. Docker creates a missing bind source as root and the only writer is root-in-container. The claude-usage mkdir exists because darren (not root) writes there.
q: What is the sa1 binary path in the built image? | assumption: /usr/lib/sysstat/sa1 (Debian sysstat layout). Implementation verifies it in the built image and adjusts the run script if it differs.
q: Does sar inside the container report host numbers? | assumption: Yes — containers share the host kernel and /proc/stat, /proc/meminfo, /proc/diskstats are host-wide. The post-deploy sar run confirms it; if it does not, this plan is revised (no fallback collector is specified here).

# Install sysstat in the Hermes Docker image for host metrics history

Issue: darrencjh8/friday #198. Parent: codex-router #483 (host metrics history).
Decision (Darren, 2026-11-09): sysstat goes in the Hermes Docker image, not on the host
(apt at build time, no sudo anywhere). The three earlier options from #483 (grant the
runner narrow sudo / manual host install / different collector) are superseded.

## Context

codex-router #483 needs host metrics history to diagnose incidents like 2026-11-03,
when hop log lines had no timestamps and no host metrics history existed. Installing
sysstat on the host is blocked: the self-hosted runner has no passwordless sudo for
apt. Hermes runs in Docker from modules/hermes/Dockerfile, which already installs
packages at build time, so sysstat rides the same step and the deploy flow is unchanged.

## Evidence (base 4f2af1b, verified from the repo)

- `modules/hermes/Dockerfile:5-8`: `RUN apt-get update && apt-get install -y
  --no-install-recommends poppler-utils qpdf && rm -rf /var/lib/apt/lists/*`.
  Adding `sysstat` here is one line; apt runs inside the image build, no sudo anywhere.
- `modules/hermes/Dockerfile:81-83`: the reminders s6 service is installed by
  `COPY webui/s6-rc.d/reminders /etc/s6-overlay/s6-rc.d/reminders`,
  `chmod +x .../run`, and `touch /etc/s6-overlay/s6-rc.d/user/contents.d/reminders`.
  The service itself is `modules/hermes/webui/s6-rc.d/reminders/` with `run`
  (`#!/command/with-contenv sh`), `type` (`longrun`), `dependencies.d/base`.
  The image runs under s6-overlay, so a second service follows the same pattern.
- `modules/docker-compose.yml:286` (hermes service), volumes at `:324-330`:
  `/home/runner/data/hermes/data:/opt/data`, `/workspace`, two secret file binds,
  docker.sock, expense-tracker-data ro. Nothing persists `/var/log/sysstat`.
- `modules/deploy.sh:1246-1282`: scheduling lives in DARREN's crontab, not the
  runner's; deploy.sh can only print a reminder to add the line. A host-cron
  collector would therefore need a manual one-time step.
- No `sysstat`, `sar`, `sa1` or `/var/log/sysstat` reference exists anywhere in the repo
  (grep over modules/ and .github/workflows/).
- Debian sysstat default data directory is `/var/log/sysstat` (sysstat(5):
  SA_DIR defaults to `/var/log/sysstat`; `/var/log/sa` is the RHEL/upstream
  default), so the volume, the prune path and the verification paths below all
  use `/var/log/sysstat`.
- The hermes container runs as root (deploy.sh:922 comment), so the collector needs
  no user switching and no permission setup for the sa volume.
- Test pattern: `modules/tests/test_compose_hermes_memory_limit.py` — unittest,
  yaml-parses docker-compose.yml, asserts on structure. New tests follow it.

## Change (6 files, ~60 lines)

1. `modules/hermes/Dockerfile`: add `sysstat` to the existing apt-get install list
   (line 5). No new RUN step.
2. New s6 service `modules/hermes/webui/s6-rc.d/sysstat/`:
   - `run` (`#!/command/with-contenv sh`): loop forever — `/usr/lib/sysstat/sa1 1 1`,
     prune `/var/log/sysstat` files older than 28 days, then `sleep 120`:
     `find /var/log/sysstat -type f -name 'sa[0-9][0-9]' -mtime +28 -delete`.
     The prune runs every iteration (cheap over a handful of files; no
     date-change state to track).
     Runs as root (no `s6-setuidgid` — sa1 writes `/var/log/sysstat`, container is root).
   - `type`: `longrun`. `dependencies.d/base`: empty, same as reminders.
   - Cadence is approximate (~121 s per sample including sa1 runtime); acceptance
     is 2-minute sampling, not exact 120.0 s.
   - Rejected: host cron via `docker exec` (manual crontab step, silent no-data
     failure mode); a cron daemon in the image (a new moving part for what a
     10-line loop does); `sa2` daily summaries (`sar` reads the raw sa files,
     no summary needed).
3. `modules/hermes/Dockerfile`: install the service following the reminders lines —
   `COPY webui/s6-rc.d/sysstat /etc/s6-overlay/s6-rc.d/sysstat`,
   `chmod +x .../run`, `touch /etc/s6-overlay/s6-rc.d/user/contents.d/sysstat`.
4. `modules/docker-compose.yml`: add `- /home/runner/data/hermes/sysstat:/var/log/sysstat`
   to the hermes service volumes. No `deploy.sh` mkdir: Docker creates a missing
   bind source as root and the only writer is root-in-container.
5. `modules/tests/test_sysstat_host_metrics.py` (new): class
   `SysstatHostMetricsTests`, following the compose-test pattern above:
   - `test_sysstat_installed_in_hermes_image`: the Dockerfile apt-get install
     list contains `sysstat`.
   - `test_sa_volume_persisted`: the compose hermes service mounts a host path
     to `/var/log/sysstat`.
   - `test_collector_service_installed`: the s6 service dir exists with
     `run`/`type`/`dependencies.d/base`; `run` is executable, invokes `sa1`,
     sleeps 120, and prunes older than 28 days.
   - `test_collector_runs_as_root`: `run` contains no `s6-setuidgid`.
   Assertions are structural only (identifiers, paths, numbers); no prose pinned.
   Test id: `modules.tests.test_sysstat_host_metrics.SysstatHostMetricsTests.test_sysstat_installed_in_hermes_image`
   (siblings named the same way). RED control: all four fail at base (no sysstat,
   no volume, no service) and pass at HEAD.

## Idempotence

A second deploy rebuilds the same image, recreates the container on the same
volume (data persists), and s6 restarts the loop; `sa1` appends to today's file,
so no duplicate samples beyond the loop's own cadence. No `deploy.sh` step, no
`DEPLOY.md` change (nothing manual to document), no `deploy.yml` change.

## Verification (hard gate, post-deploy, needs Darren's approval)

After the friday PR lands and deploys, run on the host (production command,
approval first):

```
docker exec hermes sar -u -f /var/log/sysstat/sa$(date +%d)
docker exec hermes sar -r -f /var/log/sysstat/sa$(date +%d)
```

Pass means: the sa file exists with samples every ~2 minutes, CPU count matches
the host (compare `sar -u` against `nproc` on the host at verification time —
no count is recorded in the repo), and total memory reads ~8 GB. Only then may codex-router PR #496
(troubleshooting docs) merge. If `sar` does not report host numbers, this plan
is revised — no fallback collector is specified here.

## Out of scope

- Installing sysstat on the host (superseded by Darren's decision).
- The troubleshooting doc itself (codex-router #496, separate PR, gated on this).
- `deploy.sh`, `deploy.yml`, `DEPLOY.md`, other services, the web client.
- `sa2` daily summaries, `HISTORY` tuning, a cron daemon in the image.
