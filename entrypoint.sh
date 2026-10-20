#!/bin/sh
set -e
DATA="${DATA_DIR:-/data}"
mkdir -p "$DATA/uploads" "$DATA/backups"

# Disaster recovery: brand-new /data + OneDrive configured => pull the latest copy back automatically.
if [ ! -f "$DATA/house.db" ] && [ -n "$RCLONE_REMOTE" ] && [ -f "$RCLONE_CONFIG" ]; then
  echo "[restore] No database found. Checking $RCLONE_REMOTE for a backup..."
  LATEST=$(rclone lsf "$RCLONE_REMOTE/backups" --files-only 2>/dev/null | grep '^house-.*\.db$' | sort | tail -n 1 || true)
  if [ -n "$LATEST" ]; then
    rclone copyto "$RCLONE_REMOTE/backups/$LATEST" "$DATA/house.db"
    rclone copy "$RCLONE_REMOTE/uploads" "$DATA/uploads" || true
    echo "[restore] Restored $LATEST and uploads from OneDrive."
  else
    echo "[restore] No backup found on remote; starting fresh."
  fi
fi

exec "$@"
