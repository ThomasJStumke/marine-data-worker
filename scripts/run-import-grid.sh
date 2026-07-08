#!/usr/bin/env bash
# Cron entry point (every 2 minutes): process any admin-submitted grid-import
# requests (marine_data_grid_imports, status=PENDING), then exit. Near-instant
# no-op when the queue is empty. See src/cli/importGrid.ts and
# supabase/migrations/20260712050000_marine_data_grid_imports.sql.
#
# Needs read-write access to the grid storage dir (unlike run-drain.sh's
# read-only mount) since this is what downloads/extracts/symlinks new grids
# into it.
set -euo pipefail

WORKER_DIR="/home/optiplex/stack/apps/workers/marine-data"
LOG_DIR="${HOME}/backups/marine-data-worker"
LOG_FILE="${LOG_DIR}/import-grid.log"

mkdir -p "$LOG_DIR"

{
  echo "── $(date -Iseconds) ──"
  docker run --rm \
    --env-file "${WORKER_DIR}/.env" \
    -v /mnt/storage/marine-data-gebco:/var/lib/marine-data-worker/gebco \
    marine-data-worker node dist/cli/importGrid.js
} >> "$LOG_FILE" 2>&1
