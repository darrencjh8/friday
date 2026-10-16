#!/bin/sh
# Download a OneDrive shared file via its share link.
# Converts the share link to a direct download URL and fetches the file.

set -e

SHARE_URL="${ONEDRIVE_SHARE_URL}"
OUTPUT="${ONEDRIVE_LOCAL_PATH:-/data/onedrive/portfolio.xml}"
INTERVAL="${ONEDRIVE_SYNC_INTERVAL:-300}"

if [ -z "$SHARE_URL" ]; then
  echo "ONEDRIVE_SHARE_URL not set. Exiting."
  exit 1
fi

# Convert share URL to direct download
# Format: https://1drv.ms/u/s!<encoded>  or  https://onedrive.live.com/?cid=<cid>&id=<id>&authkey=<authkey>
get_direct_url() {
  REDIRECT_URL=$(curl -sI -o /dev/null -w '%{redirect_url}' "$SHARE_URL" 2>/dev/null)
  if [ -n "$REDIRECT_URL" ]; then
    ENCODED=$(echo "$REDIRECT_URL" | grep -oP 'resid=\K[^&]+' | head -1)
    AUTHKEY=$(echo "$REDIRECT_URL" | grep -oP 'authkey=\K[^&]+' | head -1)
    if [ -n "$ENCODED" ] && [ -n "$AUTHKEY" ]; then
      echo "https://api.onedrive.com/updr/updrv2/download?resid=${ENCODED}&authkey=${AUTHKEY}"
      return 0
    fi
  fi
  # Fallback: try share URL with ?download=1
  echo "${SHARE_URL}?download=1"
}

while true; do
  DIRECT_URL=$(get_direct_url)
  mkdir -p "$(dirname "$OUTPUT")"
  curl -sL -o "${OUTPUT}.tmp" "$DIRECT_URL" 2>/dev/null && mv "${OUTPUT}.tmp" "$OUTPUT"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Synced: $(wc -c < "$OUTPUT" 2>/dev/null || echo 0) bytes"
  sleep "$INTERVAL"
done
