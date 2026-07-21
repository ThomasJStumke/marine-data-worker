#!/usr/bin/env bash
# Daily cron entry point: evict cache entries past CACHE_RETENTION_DAYS
# and/or beyond CACHE_MAX_SIZE_GB. See src/cli/cleanupCache.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cache-migration.conf
source "${SCRIPT_DIR}/cache-migration.conf"

WORKER_DIR="/home/optiplex/stack/apps/workers/marine-data"
LOG_DIR="${HOME}/backups/marine-data-worker"
LOG_FILE="${LOG_DIR}/cache-cleanup.log"

mkdir -p "$LOG_DIR"

{
  echo "── $(date -Iseconds) ──"
  docker run --rm \
    --env-file "${WORKER_DIR}/.env" \
    -v "${NAS_CACHE_PATH}:/var/lib/marine-data-worker/cache" \
    "$WORKER_IMAGE" node dist/cli/cleanupCache.js
} >> "$LOG_FILE" 2>&1
