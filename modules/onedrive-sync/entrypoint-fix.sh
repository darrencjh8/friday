#!/bin/sh
# Force clean state by removing stale hash/db files, then run the real entrypoint
rm -f /onedrive/conf/.config.hash /onedrive/conf/.sync_list.hash
rm -f /onedrive/conf/items.sqlite3
exec /entrypoint.sh "$@"
