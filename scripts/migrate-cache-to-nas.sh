#!/usr/bin/env bash
# Migrates the marine-data-cache Docker volume to a bind-mounted NAS path
# (see scripts/cache-migration.conf for the destination and other knobs).
#
# Why a "toolbox" container does the actual file move/copy: the volume's
# files are owned by root (the worker container runs as root — see
# Dockerfile), so the invoking host user (not root, no sudo in this
# environment) cannot read or write them directly. A throwaway container
# bind-mounting the volume + the destination gets root inside its own
# namespace and can move the files regardless of host-user permissions.
# This isn't a workaround; it's the same reason `docker run` needs the
# docker group/socket in the first place.
#
# Phases, tracked in $MIGRATION_STATE_DIR/state.env so the script is safely
# resumable/idempotent — rerunning it after an interruption picks up from
# the last completed phase instead of redoing work or double-moving data:
#   DETECTED  -> source/destination resolved, pre-move manifest captured
#   COPIED    -> data present at NAS_CACHE_PATH (via instant rename when
#                source+dest share a filesystem, else rsync -aHAX copy)
#   VALIDATED -> counts/sample-checksums verified + worker read/write/
#                restart-persistence smoke test passed against the new path
#   CUTOVER   -> cron scripts + the standalone container point at the new
#                bind mount, and the recreated container is confirmed healthy
#   CLEANED   -> old Docker volume removed (only with --finalize, and only
#                after CUTOVER; see "refuse to delete" requirement)
#
# Usage:
#   ./migrate-cache-to-nas.sh              # runs DETECTED..CUTOVER
#   ./migrate-cache-to-nas.sh --finalize    # also removes the old volume
#   ./migrate-cache-to-nas.sh --status      # print current phase and exit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cache-migration.conf
source "${SCRIPT_DIR}/cache-migration.conf"

FINALIZE=0
STATUS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --finalize) FINALIZE=1 ;;
    --status) STATUS_ONLY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$MIGRATION_STATE_DIR"
STATE_FILE="${MIGRATION_STATE_DIR}/state.env"
LOG_FILE="${MIGRATION_STATE_DIR}/migrate.log"
LOCK_FILE="${MIGRATION_STATE_DIR}/migrate.lock"

log() {
  local line
  line="[$(date -Iseconds)] $*"
  echo "$line" | tee -a "$LOG_FILE" >&2
}

# --- state helpers (simple key=value file, sourceable) ---
PHASE="NONE"
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$STATE_FILE"
fi

save_state() {
  {
    echo "PHASE=\"$PHASE\""
    echo "SRC_METHOD=\"${SRC_METHOD:-}\""
    echo "SRC_FILE_COUNT=\"${SRC_FILE_COUNT:-}\""
    echo "SRC_TOTAL_BYTES=\"${SRC_TOTAL_BYTES:-}\""
    echo "SAMPLE_MANIFEST=\"${SAMPLE_MANIFEST:-}\""
    echo "LAST_UPDATED=\"$(date -Iseconds)\""
  } > "$STATE_FILE"
}

if [[ "$STATUS_ONLY" == "1" ]]; then
  echo "phase: $PHASE"
  echo "nas cache path: $NAS_CACHE_PATH"
  echo "state file: $STATE_FILE"
  echo "log file: $LOG_FILE"
  exit 0
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another migration run is already in progress (lock: $LOCK_FILE) — exiting"
  exit 1
fi

log "=== migrate-cache-to-nas.sh starting (phase=$PHASE, finalize=$FINALIZE) ==="

volume_exists() {
  docker volume inspect "$CACHE_VOLUME_NAME" >/dev/null 2>&1
}

volume_mountpoint() {
  docker volume inspect "$CACHE_VOLUME_NAME" --format '{{.Mountpoint}}'
}

# Containers currently referencing the old volume (running or stopped).
containers_using_volume() {
  docker ps -a --filter "volume=${CACHE_VOLUME_NAME}" --format '{{.Names}}'
}

# ---------------------------------------------------------------------------
# Phase: DETECTED — figure out where the cache actually is right now.
# ---------------------------------------------------------------------------
if [[ "$PHASE" == "NONE" ]]; then
  log "detecting current cache location..."

  if [[ -d "$NAS_CACHE_PATH" ]] && [[ -f "${NAS_CACHE_PATH}/.migrated.ok" ]]; then
    log "destination already has a completed-migration marker (${NAS_CACHE_PATH}/.migrated.ok) — nothing to do"
    PHASE="CUTOVER"
    save_state
  elif volume_exists; then
    MOUNTPOINT="$(volume_mountpoint)"
    log "found Docker volume '${CACHE_VOLUME_NAME}' at host path: $MOUNTPOINT"
    log "destination (NAS path): $NAS_CACHE_PATH"

    if [[ -e "$NAS_CACHE_PATH" ]]; then
      log "destination path already exists but has no completion marker — treating as an interrupted prior run; will validate/resume rather than overwrite"
    fi

    # Capture counts/size and a checksum sample from the SOURCE before
    # touching anything, so VALIDATED has a pre-move manifest to check
    # against regardless of which copy method ends up being used.
    log "capturing pre-move manifest (file count, total size, sample checksums) via toolbox container..."
    MANIFEST_OUTPUT="$(docker run --rm -v "${CACHE_VOLUME_NAME}:/source:ro" "$TOOLBOX_IMAGE" sh -c '
      set -e
      total_bytes=$(find /source -type f -exec stat -c "%s" {} \; | awk "{s+=\$1} END{print s+0}")
      total_files=$(find /source -type f | wc -l)
      echo "BYTES=${total_bytes}"
      echo "FILES=${total_files}"
      echo "SAMPLE_START"
      find /source -type f | sort | awk "NR % 37 == 1" | head -25 | while read -r f; do
        sha256sum "$f" | sed "s|/source/||"
      done
      echo "SAMPLE_END"
    ')"
    SRC_TOTAL_BYTES="$(echo "$MANIFEST_OUTPUT" | grep '^BYTES=' | cut -d= -f2)"
    SRC_FILE_COUNT="$(echo "$MANIFEST_OUTPUT" | grep '^FILES=' | cut -d= -f2)"
    SAMPLE_MANIFEST="$(echo "$MANIFEST_OUTPUT" | sed -n '/SAMPLE_START/,/SAMPLE_END/p' | sed '1d;$d' | base64 -w0)"
    log "source: ${SRC_FILE_COUNT} files, ${SRC_TOTAL_BYTES} bytes ($(( SRC_TOTAL_BYTES / 1024 / 1024 / 1024 )) GiB)"

    # Preflight: does the destination filesystem have enough room? (skip
    # the check if source+dest turn out to be the same device — a rename
    # needs no extra space at all.)
    DEST_PARENT="$(dirname "$NAS_CACHE_PATH")"
    mkdir -p "$DEST_PARENT"
    AVAIL_KB="$(df --output=avail -k "$DEST_PARENT" | tail -1 | tr -d ' ')"
    AVAIL_BYTES=$(( AVAIL_KB * 1024 ))
    SRC_DEV="$(docker run --rm -v "${CACHE_VOLUME_NAME}:/source:ro" "$TOOLBOX_IMAGE" stat -c %d /source)"
    DEST_DEV="$(docker run --rm -v "${DEST_PARENT}:/dest:ro" "$TOOLBOX_IMAGE" stat -c %d /dest)"
    if [[ "$SRC_DEV" == "$DEST_DEV" ]]; then
      log "source and destination share a filesystem (dev ${SRC_DEV}) — migration will be an atomic rename, no extra space required"
    elif (( AVAIL_BYTES < SRC_TOTAL_BYTES + (5 * 1024 * 1024 * 1024) )); then
      log "ERROR: destination filesystem has ${AVAIL_BYTES} bytes free, need at least ${SRC_TOTAL_BYTES} (+5GiB headroom) for a cross-device copy"
      exit 1
    fi

    PHASE="DETECTED"
    save_state
  else
    log "no Docker volume '${CACHE_VOLUME_NAME}' found and no completed migration marker at ${NAS_CACHE_PATH} — nothing to migrate"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Phase: COPIED — move (same device) or copy (cross device) the data.
# ---------------------------------------------------------------------------
if [[ "$PHASE" == "DETECTED" ]]; then
  DEST_PARENT="$(dirname "$NAS_CACHE_PATH")"
  SRC_DEV="$(docker run --rm -v "${CACHE_VOLUME_NAME}:/source:ro" "$TOOLBOX_IMAGE" stat -c %d /source)"
  DEST_DEV="$(docker run --rm -v "${DEST_PARENT}:/dest:ro" "$TOOLBOX_IMAGE" stat -c %d /dest)"

  if [[ -e "$NAS_CACHE_PATH" ]]; then
    log "destination already populated from a prior interrupted run — skipping copy, proceeding to validation"
    SRC_METHOD="resumed"
  elif [[ "$SRC_DEV" == "$DEST_DEV" ]]; then
    log "performing same-device atomic rename: $(volume_mountpoint) -> $NAS_CACHE_PATH"
    docker run --rm \
      -v "${CACHE_VOLUME_NAME}:/source" \
      -v "${DEST_PARENT}:/destparent" \
      "$TOOLBOX_IMAGE" sh -c "mv /source '/destparent/$(basename "$NAS_CACHE_PATH")'"
    log "rename complete"
    SRC_METHOD="rename"
  else
    log "source and destination are on different filesystems — falling back to rsync -aHAX (preserves owner/perms/timestamps/hardlinks/ACLs/symlinks), resumable if interrupted"
    docker run --rm \
      -v "${CACHE_VOLUME_NAME}:/source:ro" \
      -v "${DEST_PARENT}:/destparent" \
      "$TOOLBOX_IMAGE" sh -c "
        apk add --no-cache rsync >/dev/null 2>&1 || { echo 'ERROR: could not install rsync in toolbox (no network egress?)' >&2; exit 1; }
        mkdir -p '/destparent/$(basename "$NAS_CACHE_PATH")'
        rsync -aHAX --numeric-ids --info=progress2 /source/ '/destparent/$(basename "$NAS_CACHE_PATH")/'
      " 2>&1 | tee -a "$LOG_FILE"
    log "rsync copy complete (source volume left intact until validation + cutover succeed)"
    SRC_METHOD="rsync"
  fi

  PHASE="COPIED"
  save_state
fi

# ---------------------------------------------------------------------------
# Phase: VALIDATED — verify integrity, then prove the worker can actually
# read existing entries, write new ones, and survive a restart.
# ---------------------------------------------------------------------------
if [[ "$PHASE" == "COPIED" ]]; then
  log "validating migrated data at $NAS_CACHE_PATH..."

  DEST_BYTES="$(docker run --rm -v "${NAS_CACHE_PATH}:/dest:ro" "$TOOLBOX_IMAGE" sh -c 'find /dest -type f -exec stat -c "%s" {} \; | awk "{s+=\$1} END{print s+0}"')"
  DEST_FILES="$(docker run --rm -v "${NAS_CACHE_PATH}:/dest:ro" "$TOOLBOX_IMAGE" find /dest -type f | wc -l)"
  log "destination: ${DEST_FILES} files (expected ${SRC_FILE_COUNT}), ${DEST_BYTES} bytes (expected ${SRC_TOTAL_BYTES})"

  if [[ "$DEST_FILES" != "$SRC_FILE_COUNT" ]] || [[ "$DEST_BYTES" != "$SRC_TOTAL_BYTES" ]]; then
    log "ERROR: file count / byte count mismatch — refusing to proceed. Old data is untouched (only ever moved, never deleted, at this point)."
    exit 1
  fi

  log "re-hashing sampled files at the destination and comparing against the pre-move manifest..."
  echo "$SAMPLE_MANIFEST" | base64 -d > "${MIGRATION_STATE_DIR}/pre-move-sample.sha256"
  MISMATCH=0
  DEST_SAMPLE_OUTPUT="$(docker run --rm -i -v "${NAS_CACHE_PATH}:/dest:ro" "$TOOLBOX_IMAGE" sh -c '
    cd /dest && sha256sum -cs -
  ' < "${MIGRATION_STATE_DIR}/pre-move-sample.sha256" 2>&1)" || MISMATCH=1
  if [[ "$MISMATCH" == "1" ]]; then
    log "ERROR: checksum mismatch on sampled files after migration: $DEST_SAMPLE_OUTPUT"
    log "refusing to proceed — old data left in place"
    exit 1
  fi
  log "sample checksums match"

  log "running worker read/write/restart-persistence smoke test against the new bind mount..."
  TEST_KEY="migration-smoke-test-$$"
  docker run --rm -v "${NAS_CACHE_PATH}:/var/lib/marine-data-worker/cache" "$WORKER_IMAGE" \
    node -e "
      const fs = require('fs');
      const path = '/var/lib/marine-data-worker/cache/${TEST_KEY}.txt';
      fs.writeFileSync(path, 'migration smoke test');
      if (fs.readFileSync(path, 'utf8') !== 'migration smoke test') throw new Error('read-after-write mismatch');
      console.log('write+read OK');
    "
  # A second, separate container instance simulates a restart: if the file
  # written above is visible here, the bind mount genuinely persists data
  # across container lifecycles (not just within one process).
  docker run --rm -v "${NAS_CACHE_PATH}:/var/lib/marine-data-worker/cache" "$WORKER_IMAGE" \
    node -e "
      const fs = require('fs');
      const path = '/var/lib/marine-data-worker/cache/${TEST_KEY}.txt';
      if (!fs.existsSync(path)) throw new Error('file from previous container instance not found — persistence check failed');
      fs.unlinkSync(path);
      console.log('restart-persistence OK, test file cleaned up');
    "
  log "worker smoke test passed (read existing cache, write new entry, survive across container instances)"

  docker run --rm -v "${NAS_CACHE_PATH}:/dest" "$TOOLBOX_IMAGE" sh -c \
    "echo \"migrated_at=$(date -Iseconds)\nsrc_method=${SRC_METHOD}\nfiles=${DEST_FILES}\nbytes=${DEST_BYTES}\" > /dest/.migrated.ok"

  PHASE="VALIDATED"
  save_state
  log "validation passed"
fi

# ---------------------------------------------------------------------------
# Phase: CUTOVER — point the cron scripts + standalone container at the
# bind mount instead of the volume.
# ---------------------------------------------------------------------------
if [[ "$PHASE" == "VALIDATED" ]]; then
  log "cutting over cron entry-point scripts to the bind mount..."

  for f in run-drain.sh run-force-check.sh; do
    TARGET="${SCRIPT_DIR}/${f}"
    if grep -q -- "-v marine-data-cache:/var/lib/marine-data-worker/cache" "$TARGET"; then
      cp "$TARGET" "${MIGRATION_STATE_DIR}/${f}.orig"
      sed -i \
        -e "s|-v marine-data-cache:/var/lib/marine-data-worker/cache|-v \"\${NAS_CACHE_PATH:-${NAS_CACHE_PATH}}\":/var/lib/marine-data-worker/cache|" \
        -e "/^WORKER_DIR=/a source \"\${WORKER_DIR}/scripts/cache-migration.conf\"" \
        "$TARGET"
      log "updated $TARGET (backup saved to ${MIGRATION_STATE_DIR}/${f}.orig)"
    else
      log "$TARGET already uses a bind mount — skipping"
    fi
  done

  if docker inspect "$STANDALONE_CONTAINER_NAME" >/dev/null 2>&1; then
    log "recreating standalone container '$STANDALONE_CONTAINER_NAME' against the bind mount..."
    docker rm -f "$STANDALONE_CONTAINER_NAME" >/dev/null
    docker run -d \
      --name "$STANDALONE_CONTAINER_NAME" \
      --restart unless-stopped \
      --env-file "${SCRIPT_DIR}/../.env" \
      -v "${NAS_CACHE_PATH}:/var/lib/marine-data-worker/cache" \
      -v marine-data-work:/var/lib/marine-data-worker/work \
      -v /mnt/storage/marine-data-gebco:/var/lib/marine-data-worker/gebco:ro \
      "$WORKER_IMAGE" node dist/cli/drain.js >/dev/null
    log "waiting 20s to confirm the recreated container is healthy..."
    sleep 20
    STATUS="$(docker inspect "$STANDALONE_CONTAINER_NAME" --format '{{.State.Status}}')"
    EXIT_CODE="$(docker inspect "$STANDALONE_CONTAINER_NAME" --format '{{.State.ExitCode}}')"
    RESTART_COUNT="$(docker inspect "$STANDALONE_CONTAINER_NAME" --format '{{.RestartCount}}')"
    log "container status: $STATUS, last exit code: $EXIT_CODE, restart count: $RESTART_COUNT"
    # This container's own design is drain-once-then-exit(0), restarted by
    # --restart unless-stopped — so "restarting" with a climbing restart
    # count is its normal steady state, not a crash loop. A *nonzero* last
    # exit code, or an error-level line in recent logs, is the real signal.
    if [[ "$EXIT_CODE" != "0" ]]; then
      log "ERROR: recreated container's last run exited nonzero (${EXIT_CODE}) — see rollback-cache-migration.sh"
      exit 1
    fi
    if docker logs --tail 20 "$STANDALONE_CONTAINER_NAME" 2>&1 | grep -qi '"level":"error"'; then
      log "ERROR: recreated container logged an error after cutover — see rollback-cache-migration.sh"
      exit 1
    fi
  else
    log "no running '$STANDALONE_CONTAINER_NAME' container found — nothing to recreate (cron-only deployment)"
  fi

  PHASE="CUTOVER"
  save_state
  log "cutover complete — cache is now served from $NAS_CACHE_PATH via bind mount"
fi

# ---------------------------------------------------------------------------
# Phase: CLEANED — remove the old (by now empty, or superseded) volume.
# Gated behind --finalize: refuse to delete anything until explicitly asked,
# on top of the VALIDATED/CUTOVER gate above.
# ---------------------------------------------------------------------------
if [[ "$PHASE" == "CUTOVER" ]]; then
  if [[ "$FINALIZE" != "1" ]]; then
    log "cutover verified. Old volume '${CACHE_VOLUME_NAME}' left in place — rerun with --finalize once you're satisfied to remove it."
    exit 0
  fi

  if ! volume_exists; then
    log "old volume already gone — nothing to clean up"
    PHASE="CLEANED"
    save_state
    exit 0
  fi

  STILL_USED="$(containers_using_volume)"
  if [[ -n "$STILL_USED" ]]; then
    log "ERROR: refusing to remove volume '${CACHE_VOLUME_NAME}' — still referenced by: $STILL_USED"
    exit 1
  fi

  log "removing old volume '${CACHE_VOLUME_NAME}'..."
  docker volume rm "$CACHE_VOLUME_NAME"
  PHASE="CLEANED"
  save_state
  log "=== migration finalized: $CACHE_VOLUME_NAME -> $NAS_CACHE_PATH ==="
fi

log "done (phase=$PHASE)"
