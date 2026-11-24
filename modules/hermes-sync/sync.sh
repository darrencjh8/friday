#!/bin/sh
# Two-way folder sync between the server and the hermes machine (the laptop),
# run on the server every minute while hermes lives on the laptop:
#   server -> laptop  expense-tracker's data/ (dedup.db, wiki-proposals.jsonl,
#                     ...), which the laptop's hermes mounts read-only;
#   laptop -> server  hermes's wiki/entities/accounts, which expense-tracker and
#                     portfolio-tracker mount read-only at /wiki/accounts.
#
# It does nothing unless HERMES_TARGET is friday-laptop. Before cutover the
# laptop's accounts copy is empty or stale and must never reach the server, and
# a deploy back to the server recreates this container idle.
#
# After ALERT_AFTER failed runs in a row it alerts once, and once more when a run
# succeeds again: to the Hermes notify webhook, and by email when SMTP_USERNAME,
# SMTP_PASSWORD and ALERT_EMAIL_TO are set. The webhook is hermes on the laptop,
# so when the laptop is down only the email arrives.
set -u

: "${LAPTOP_LAN_HOST:?}"
HERMES_TARGET="${HERMES_TARGET:-server}"
LAPTOP_SSH_USER="${LAPTOP_SSH_USER:-darren}"
LAPTOP_SSH_PORT="${LAPTOP_SSH_PORT:-2222}"
STATE_DIR="${STATE_DIR:-/state}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-/tmp/hermes-sync-snapshot}"
ET_DATA_DIR="${ET_DATA_DIR:-/home/runner/data/expense-tracker/data}"
ACCOUNTS_DIR="${ACCOUNTS_DIR:-/home/runner/data/hermes/data/home/wiki/entities/accounts}"
HERMES_DATA_DIR="${HERMES_DATA_DIR:-/home/runner/data/hermes/data}"
INTERVAL="${HERMES_SYNC_INTERVAL:-60}"
SMTP_URL="${SMTP_URL:-smtps://smtp.zoho.com:465}"
ALERT_AFTER="${HERMES_SYNC_ALERT_AFTER:-10}"
# 0 runs forever; the tests set a count.
RUNS="${HERMES_SYNC_RUNS:-0}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) hermes-sync: $*"; }

if [ "$HERMES_TARGET" != friday-laptop ]; then
  log "idle: HERMES_TARGET is $HERMES_TARGET, not friday-laptop"
  [ "$RUNS" -gt 0 ] && exit 0
  exec sleep infinity
fi

for tool in rsync ssh sqlite3 curl openssl; do
  if ! command -v "$tool" >/dev/null; then
    # ponytail: installs the tools at every start (needs the Alpine mirror), as
    # lan-guard does; bake an image if the server must boot without internet.
    apk add --no-cache rsync openssh-client sqlite curl openssl >/dev/null
    break
  fi
done

SSH="ssh -p $LAPTOP_SSH_PORT -i $STATE_DIR/laptop_ssh_key -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$STATE_DIR/known_hosts"
REMOTE="$LAPTOP_SSH_USER@$LAPTOP_LAN_HOST"

sync_once() {
  # A live SQLite file copied byte by byte can tear mid-write, so each database
  # goes through SQLite's backup API into a snapshot first. The snapshot is put
  # in rollback-journal mode so hermes can open it from a read-only mount
  # without the -wal and -shm files.
  rm -rf "$SNAPSHOT_DIR" && mkdir -p "$SNAPSHOT_DIR" || return 1
  for db in "$ET_DATA_DIR"/*.db; do
    [ -f "$db" ] || continue
    snap="$SNAPSHOT_DIR/$(basename "$db")"
    sqlite3 "$db" ".backup '$snap'" || return 1
    sqlite3 "$snap" "PRAGMA journal_mode=DELETE" >/dev/null || return 1
  done

  # Server -> laptop. --delete stays inside the laptop's copy of this one
  # directory, which nothing on the laptop writes, so it mirrors the server.
  # Excluded files (the snapshots) are never deleted by it.
  rsync -a --delete --mkpath --chmod=a+rX \
    --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db-journal' \
    -e "$SSH" "$ET_DATA_DIR/" "$REMOTE:$ET_DATA_DIR/" || return 1
  rsync -a --mkpath --chmod=a+rX -e "$SSH" "$SNAPSHOT_DIR/" "$REMOTE:$ET_DATA_DIR/" || return 1

  # Laptop -> server. Never --delete: an empty or half-copied laptop directory
  # must not be able to remove the server's mappings. --update also skips any
  # file that is newer on the server. A mapping deleted on the laptop therefore
  # stays on the server until it is removed there by hand.
  #
  # The read passes through hermes's data/ (0700, owned by the container user),
  # which needs o+x for the SSH user. Hermes resets it to 0700 when it starts,
  # so a refused read grants that traverse bit again through a root container
  # on the laptop and retries once. o+x still does not let data/ be listed.
  rsync -a --update -e "$SSH" "$REMOTE:$ACCOUNTS_DIR/" "$ACCOUNTS_DIR/" && return 0
  log "accounts read refused; granting traverse on hermes data/ and retrying"
  $SSH "$REMOTE" "docker run --rm --network none -v '$HERMES_DATA_DIR:/d' alpine:3 chmod o+x /d" || return 1
  rsync -a --update -e "$SSH" "$REMOTE:$ACCOUNTS_DIR/" "$ACCOUNTS_DIR/" || return 1
}

email() {
  if [ -z "${SMTP_USERNAME:-}" ] || [ -z "${SMTP_PASSWORD:-}" ] || [ -z "${ALERT_EMAIL_TO:-}" ]; then
    log "email settings unset, not emailing"
    return 0
  fi
  mail="${TMPDIR:-/tmp}/hermes-sync-alert.eml"
  printf 'From: Friday <%s>\r\nTo: %s\r\nSubject: %s\r\n\r\n%s\r\n' \
    "$SMTP_USERNAME" "$ALERT_EMAIL_TO" "$1" "$2" > "$mail" || return 0
  # The password reaches curl as a config line on stdin, never on its command line.
  printf 'user = "%s:%s"\n' "$SMTP_USERNAME" "$SMTP_PASSWORD" \
    | curl -sS -m 30 --ssl-reqd --url "$SMTP_URL" -K - \
        --mail-from "$SMTP_USERNAME" --mail-rcpt "$ALERT_EMAIL_TO" -T "$mail" >/dev/null \
    || log "email not delivered"
  rm -f "$mail"
}

notify() {
  email "$2" "$1"
  if [ -z "${NOTIFY_URL:-}" ]; then
    log "NOTIFY_URL unset, not alerting: $1"
    return 0
  fi
  # The messages are fixed strings without quotes, so no JSON escaping needed.
  body="{\"message\":\"$1\"}"
  set --
  if [ -n "${HERMES_WEBHOOK_SECRET:-}" ]; then
    sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$HERMES_WEBHOOK_SECRET" | sed 's/^.*= //')
    set -- -H "X-Webhook-Signature: $sig"
  fi
  curl -fsS -m 10 -H "Content-Type: application/json" "$@" -d "$body" "$NOTIFY_URL" >/dev/null \
    || log "alert not delivered"
}

fails=0
run=0
while :; do
  run=$((run + 1))
  if out=$(sync_once 2>&1); then
    log "ok"
    if [ "$fails" -ge "$ALERT_AFTER" ]; then
      notify "hermes-sync recovered: the server and laptop folders are syncing again after $fails failed minutes." \
        "Friday: hermes-sync recovered"
    fi
    fails=0
  else
    fails=$((fails + 1))
    log "failed ($fails in a row): $out"
    if [ "$fails" -eq "$ALERT_AFTER" ]; then
      if $SSH "$REMOTE" true >/dev/null 2>&1; then
        notify "hermes-sync has failed for $ALERT_AFTER minutes in a row: expense-tracker data is not reaching the laptop and wiki account mappings are not reaching the server. See docker logs modules-hermes-sync-1 on the server." \
          "Friday: hermes-sync is failing"
      else
        notify "The laptop has not answered for $ALERT_AFTER minutes: Hermes is unreachable, and hermes-sync is stalled. It may be off, asleep or off the network." \
          "Friday: the laptop is down"
      fi
    fi
  fi
  [ "$RUNS" -gt 0 ] && [ "$run" -ge "$RUNS" ] && exit 0
  sleep "$INTERVAL"
done
