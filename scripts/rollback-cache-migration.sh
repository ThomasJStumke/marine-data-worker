#!/usr/bin/env bash
# Reverses migrate-cache-to-nas.sh. Safe to run at any phase: the migration
# script never deletes cache data itself (only ever moves it, and only
# removes the empty old volume when explicitly --finalize'd), so a rollback
# is always just "point everything back at a Docker volume named
# marine-data-cache containing the data currently at NAS_CACHE_PATH."
#
# Usage: ./rollback-cache-migration.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cache-migration.conf
source "${SCRIPT_DIR}/cache-migration.conf"

mkdir -p "$MIGRATION_STATE_DIR"
STATE_FILE="${MIGRATION_STATE_DIR}/state.env"
LOG_FILE="${MIGRATION_STATE_DIR}/rollback.log"
LOCK_FILE="${MIGRATION_STATE_DIR}/migrate.lock"

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE" >&2; }

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "a migration/rollback run is already in progress — exiting"
  exit 1
fi

log "=== rollback-cache-migration.sh starting ==="

if docker volume inspect "$CACHE_VOLUME_NAME" >/dev/null 2>&1; then
  log "volume '${CACHE_VOLUME_NAME}' already exists — assuming migration never reached --finalize; nothing to recreate"
else
  if [[ ! -d "$NAS_CACHE_PATH" ]]; then
    log "ERROR: neither the volume nor ${NAS_CACHE_PATH} exist — cannot determine where the data is. Aborting."
    exit 1
  fi
  log "recreating volume '${CACHE_VOLUME_NAME}' and moving data back from ${NAS_CACHE_PATH}..."
  docker volume create "$CACHE_VOLUME_NAME" >/dev/null
  MOUNTPOINT="$(docker volume inspect "$CACHE_VOLUME_NAME" --format '{{.Mountpoint}}')"
  DEST_PARENT_INSIDE="$(dirname "$NAS_CACHE_PATH")"

  SRC_DEV="$(docker run --rm -v "${DEST_PARENT_INSIDE}:/src:ro" "$TOOLBOX_IMAGE" stat -c %d /src)"
  DEST_DEV="$(docker run --rm -v "${CACHE_VOLUME_NAME}:/dst:ro" "$TOOLBOX_IMAGE" stat -c %d /dst)"

  if [[ "$SRC_DEV" == "$DEST_DEV" ]]; then
    log "same filesystem — moving data back via atomic rename"
    docker run --rm \
      -v "${DEST_PARENT_INSIDE}:/srcparent" \
      -v "${CACHE_VOLUME_NAME}:/dst" \
      "$TOOLBOX_IMAGE" sh -c "rmdir /dst 2>/dev/null; mv '/srcparent/$(basename "$NAS_CACHE_PATH")' /dst"
  else
    log "different filesystems — copying back with rsync (source at ${NAS_CACHE_PATH} is left intact until you confirm the rollback worked)"
    docker run --rm \
      -v "${NAS_CACHE_PATH}:/src:ro" \
      -v "${CACHE_VOLUME_NAME}:/dst" \
      "$TOOLBOX_IMAGE" sh -c "
        apk add --no-cache rsync >/dev/null 2>&1
        rsync -aHAX --numeric-ids --info=progress2 /src/ /dst/
      " 2>&1 | tee -a "$LOG_FILE"
  fi
  log "data restored into volume '${CACHE_VOLUME_NAME}' (mountpoint: $MOUNTPOINT)"
fi

for f in run-drain.sh run-force-check.sh; do
  BACKUP="${MIGRATION_STATE_DIR}/${f}.orig"
  TARGET="${SCRIPT_DIR}/${f}"
  if [[ -f "$BACKUP" ]]; then
    cp "$BACKUP" "$TARGET"
    log "restored $TARGET from $BACKUP"
  else
    log "no backup found for $f (${BACKUP}) — leaving as-is; check manually whether it references the volume or the bind mount"
  fi
done

if docker inspect "$STANDALONE_CONTAINER_NAME" >/dev/null 2>&1; then
  log "recreating standalone container '$STANDALONE_CONTAINER_NAME' against the volume..."
  docker rm -f "$STANDALONE_CONTAINER_NAME" >/dev/null
  docker run -d \
    --name "$STANDALONE_CONTAINER_NAME" \
    --restart unless-stopped \
    --env-file "${SCRIPT_DIR}/../.env" \
    -v "${CACHE_VOLUME_NAME}:/var/lib/marine-data-worker/cache" \
    -v marine-data-work:/var/lib/marine-data-worker/work \
    -v /mnt/storage/marine-data-gebco:/var/lib/marine-data-worker/gebco:ro \
    "$WORKER_IMAGE" node dist/cli/drain.js >/dev/null
  log "recreated $STANDALONE_CONTAINER_NAME on the volume mount"
fi

rm -f "$STATE_FILE"
log "=== rollback complete: cache is back on Docker volume '${CACHE_VOLUME_NAME}' ==="
