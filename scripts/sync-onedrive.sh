#!/usr/bin/env bash
set -euo pipefail
# Sync OneDrive data to the gateway_onedrive_data Docker volume.
# Non-interactive if a refresh_token exists; falls back to OAuth if not.
#
# Usage: ./scripts/sync-onedrive.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF_DIR="$ROOT/modules/onedrive-sync/config/onedrive"
TOKEN="$CONF_DIR/refresh_token"

# Resolve ONEDRIVE_CLIENT_ID from portfolio-tracker .env
PT_ENV="$ROOT/modules/portfolio-tracker/.env"
if [ -f "$PT_ENV" ]; then
  export ONEDRIVE_CLIENT_ID=$(grep -E '^ONEDRIVE_CLIENT_ID=' "$PT_ENV" | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

mkdir -p "$CONF_DIR"

if [ -f "$TOKEN" ]; then
  echo "=== OneDrive: Non-interactive sync (token found) ==="
  docker run --rm \
    -v "$CONF_DIR:/onedrive/conf" \
    -v gateway_onedrive_data:/onedrive/data \
    driveone/onedrive:latest --sync --confdir /onedrive/conf --syncdir /onedrive/data
  echo "Sync complete."
else
  echo "=== OneDrive: No refresh token found. Starting interactive OAuth ==="
  echo ""
  echo "Open this URL, log in, and paste the redirect URI:"
  echo "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${ONEDRIVE_CLIENT_ID}&scope=Files.ReadWrite%20Files.ReadWrite.All%20Sites.ReadWrite.All%20offline_access&response_type=code&prompt=login&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient"
  echo ""
  echo -n "Paste redirect URI: "
  read -r REDIRECT_URI

  if [ -n "$REDIRECT_URI" ]; then
    echo "$REDIRECT_URI" | docker run --rm -i \
      -v "$CONF_DIR:/onedrive/conf" \
      -v gateway_onedrive_data:/onedrive/data \
      driveone/onedrive:latest --sync --verbose --confdir /onedrive/conf --syncdir /onedrive/data
    if [ -f "$TOKEN" ]; then
      echo "Token saved. Restart portfolio-tracker to pick up changes:"
      echo "  cd ~/friday/gateway && docker compose restart portfolio-tracker"
    fi
  fi
fi
