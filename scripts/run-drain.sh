#!/usr/bin/env bash
# Hourly cron entry point: drain whatever's currently QUEUED in
# bathymetry_jobs, then exit. See docs/marine-data-worker.md and
# ../README.md for what this container does; see
# supabase/migrations/20260712040000_marine_data_worker_runs.sql for how
# each invocation's outcome is recorded for the super-admin admin UI.
set -euo pipefail

WORKER_DIR="/home/optiplex/stack/apps/workers/marine-data"
LOG_DIR="${HOME}/backups/marine-data-worker"
LOG_FILE="${LOG_DIR}/drain.log"

mkdir -p "$LOG_DIR"

{
  echo "── $(date -Iseconds) ──"
  docker run --rm \
    --env-file "${WORKER_DIR}/.env" \
    -v marine-data-cache:/var/lib/marine-data-worker/cache \
    -v marine-data-work:/var/lib/marine-data-worker/work \
    -v /mnt/storage/marine-data-gebco:/var/lib/marine-data-worker/gebco:ro \
    marine-data-worker node dist/cli/drain.js
} >> "$LOG_FILE" 2>&1
