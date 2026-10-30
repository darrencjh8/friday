#!/bin/bash
# Monthly Actual Budget backup — deterministic REST call, zero LLM tokens.
# portfolio-tracker exports each budget through actual-api and uploads the
# zips to the OneDrive folder Darren shares (Flyio). Silent on success; a failure exits non-zero
# so the no_agent cron job alerts.
set -euo pipefail

ENDPOINT="${ACTUAL_BACKUP_ENDPOINT:-http://portfolio-tracker:8081/backup/actual}"

RESP=$(curl -s -w "\n%{http_code}" -X POST "$ENDPOINT" --max-time 900 2>&1) || true
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
    echo "Actual backup to OneDrive failed (HTTP ${HTTP_CODE:-none}): ${BODY:0:300}" >&2
    exit 1
fi
echo "[actual-backup] $(date -Iseconds) $BODY" >&2
