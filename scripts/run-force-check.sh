#!/usr/bin/env bash
# Every-minute cron entry point: check for an admin-requested "Force Run"
# (super-admin Bathymetry Jobs page) and drain the queue immediately if one
# exists. Near-instant no-op otherwise. Same mounts as run-drain.sh since
# this runs the identical drain logic when triggered — see
# src/cli/checkForceRun.ts and src/worker/drainQueue.ts.
set -euo pipefail

WORKER_DIR="/home/optiplex/stack/apps/workers/marine-data"
source "${WORKER_DIR}/scripts/cache-migration.conf"
LOG_DIR="${HOME}/backups/marine-data-worker"
LOG_FILE="${LOG_DIR}/force-check.log"

mkdir -p "$LOG_DIR"

{
  echo "── $(date -Iseconds) ──"
  docker run --rm \
    --env-file "${WORKER_DIR}/.env" \
    -v "${NAS_CACHE_PATH:-/mnt/storage/marine-data-cache}":/var/lib/marine-data-worker/cache \
    -v marine-data-work:/var/lib/marine-data-worker/work \
    -v /mnt/storage/marine-data-gebco:/var/lib/marine-data-worker/gebco:ro \
    marine-data-worker node dist/cli/checkForceRun.js
} >> "$LOG_FILE" 2>&1
