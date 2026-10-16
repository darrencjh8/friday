#!/bin/bash
# One-time OAuth authorization for OneDrive sync.
# Run this ONCE to authenticate, then the Docker compose service syncs automatically.

CONFIG_DIR="$(cd "$(dirname "$0")" && pwd)/config/onedrive"

mkdir -p "$CONFIG_DIR"

echo "=== OneDrive Authorization ==="
echo ""
echo "1. A URL will appear below. Open it in a browser."
echo "2. Log in to your Microsoft account."
echo "3. Grant access to the OneDrive application."
echo "4. You will be redirected to a blank page. Copy the ENTIRE URL from the address bar."
echo "5. Paste the URL back here and press Enter."
echo ""

docker run --rm -it \
  -v "$CONFIG_DIR:/onedrive/conf" \
  driveone/onedrive:latest --synchronize --verbose

echo ""
echo "Authorization complete. The refresh token is stored in:"
echo "  $CONFIG_DIR"
echo ""
echo "You can now start the sync service:"
echo "  docker compose up -d onedrive-sync"
