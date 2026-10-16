#!/bin/bash
# Emit one bounded, redacted snapshot for a fixed Docker service.
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: $0 expense-tracker|hermes|portfolio-tracker|codex-router|actual-api" >&2
    exit 64
fi

component=$1
case "$component" in
    expense-tracker|hermes|portfolio-tracker|codex-router|actual-api) ;;
    *) echo "unknown triage component" >&2; exit 64 ;;
esac

case "$component" in
    hermes) services=(hermes) ;;
    expense-tracker) services=(expense-tracker) ;;
    portfolio-tracker) services=(portfolio-tracker) ;;
    codex-router) services=(codex-router-a codex-router-b) ;;
    actual-api) services=(actual-api) ;;
esac

project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' hermes 2>/dev/null || true)
if [[ ! "$project" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "cannot resolve Compose project for log triage" >&2
    exit 1
fi
containers=()
for service in "${services[@]}"; do
    if names=$(docker ps -a --filter "label=com.docker.compose.project=$project" \
        --filter "label=com.docker.compose.service=$service" --format '{{.Names}}' 2>/dev/null); then
        while IFS= read -r name; do
            [ -n "$name" ] && containers+=("$name")
        done <<< "$names"
    fi
done

snapshot_dir=/opt/data/log-issue-triage/snapshots
state_dir=/opt/data/log-issue-triage/state
snapshot="$snapshot_dir/$component.json"
since_file="$state_dir/$component.since"
mkdir -p "$snapshot_dir" "$state_dir"
# Drop any previous run's snapshot first, so a failure below cannot leave the
# caller reading stale evidence from an earlier run.
rm -f "$snapshot"

# Latest-only window: the first run bounds to the last 24h; each success stores
# its start time and the next run resumes from it. A failure exits before the
# store, so the next run retries the same window instead of skipping past it.
# The start (not end) timestamp is stored so logs written during the run are
# re-seen rather than lost.
run_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
since="24h"
# Only a stored RFC3339 timestamp (or docker's relative form, e.g. 6h) is used.
# Anything else (disk trouble, a hand edit) would make every `docker logs` fail,
# skip the store below, and wedge each later run on the same garbage (#739), so
# it falls back to 24h and the success path overwrites it.
if [ -s "$since_file" ]; then
    stored=$(head -c 64 "$since_file" | tr -d '\n')
    if [[ "$stored" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$ ]] \
        || [[ "$stored" =~ ^[0-9]+[smh]$ ]]; then
        since=$stored
    else
        echo "log triage: ignoring invalid stored window in $since_file; using 24h" >&2
    fi
fi
# Write to a temp file and publish only on success. Redirecting straight at
# "$snapshot" truncates it before the collector runs, so a collector that died
# mid-write left a PARTIAL snapshot that the next run read as a fresh sample and
# re-triaged as new leads. With `set -e` a failing pipeline aborts before the
# move, so nothing is published and no path is printed.
tmp="$snapshot.tmp.$$"
trap 'rm -f "$tmp"' EXIT INT TERM

# Stream directly into the redactor: no raw log artifact is persisted and each
# bounded Docker tail is a standalone sample rather than a stale file cursor.
if ((${#containers[@]} == 0)); then
    printf '[collector-error] container=%s exit=1\n' "$component"
else
for container in "${containers[@]}"; do
    if metadata=$(docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container" 2>/dev/null); then
        IFS='|' read -r image_id image_ref revision <<< "$metadata"
    else
        image_id=""
        image_ref=""
        revision=""
    fi
    printf '[collector-meta] container=%s image_id=%s image_ref=%s revision=%s\n' \
        "$container" "$image_id" "$image_ref" "$revision"
    if timeout 30 docker logs --since "$since" --timestamps --tail 500 "$container" 2>&1 | sed "s/^/$container\t/"; then
        printf '[collector-ok] container=%s\n' "$container"
    else
        status=$?
        printf '[collector-error] container=%s exit=%s\n' "$container" "$status"
    fi
done
fi |
    python3 /opt/data/scripts/log-issue-triage-collect.py \
        --component "$component" \
        --source - \
        --state-dir "$state_dir" \
        --max-lines 200 \
        --max-bytes 65536 \
        >"$tmp"
mv "$tmp" "$snapshot"
printf '%s' "$run_started" >"$since_file"
printf '%s\n' "$snapshot"
