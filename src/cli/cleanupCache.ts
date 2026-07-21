import { unlink } from "node:fs/promises";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { logger } from "../logger.js";

/**
 * Evicts source/contour/hillshade/contour-bands cache entries — both the DB
 * row (marine_data_*_cache) and the file it points at on
 * config.cacheDirectory — once they're either older than
 * CACHE_RETENTION_DAYS or the total cache exceeds CACHE_MAX_SIZE_GB (LRU,
 * by last_used_at). Either limit set to 0 disables that criterion.
 *
 * Table order matters: marine_data_contour_cache, marine_data_hillshade_cache
 * and marine_data_contour_bands_cache all carry a `source_cache_id` FK
 * (RESTRICT, no ON DELETE clause — see the 20260716000000 and
 * 20260801120000 migrations) into marine_data_source_cache, so children
 * must be evicted before a source row they still reference. A source row
 * that's outlived its own retention/budget cutoff but is still referenced
 * by a live (not-yet-evicted) child is skipped rather than force-deleted —
 * see maybeEvictSourceCache below.
 */
const CHILD_TABLES = [
  { table: "marine_data_contour_bands_cache", fileColumn: "contour_bands_file" },
  { table: "marine_data_contour_cache", fileColumn: "contours_file" },
  { table: "marine_data_hillshade_cache", fileColumn: "hillshade_file" },
] as const;

const SOURCE_TABLE = "marine_data_source_cache";
const SOURCE_FILE_COLUMN = "source_file";

interface CacheRow {
  id: string;
  size_bytes: number;
  last_used_at: string;
  [fileColumn: string]: unknown;
}

interface EvictionStats {
  filesDeleted: number;
  bytesFreed: number;
  rowsDeleted: number;
  filesMissing: number;
}

function newStats(): EvictionStats {
  return { filesDeleted: 0, bytesFreed: 0, rowsDeleted: 0, filesMissing: 0 };
}

async function deleteRow(
  stats: EvictionStats,
  dryRun: boolean,
  table: string,
  fileColumn: string,
  row: CacheRow,
): Promise<void> {
  const filePath = row[fileColumn] as string;
  if (dryRun) {
    logger.info("would evict cache entry", { table, id: row.id, filePath, sizeBytes: row.size_bytes, lastUsedAt: row.last_used_at });
    stats.filesDeleted += 1;
    stats.bytesFreed += row.size_bytes;
    return;
  }

  try {
    await unlink(filePath);
    stats.filesDeleted += 1;
    stats.bytesFreed += row.size_bytes;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      stats.filesMissing += 1;
    } else {
      logger.error("failed to unlink cache file, leaving DB row in place", { table, filePath, error: String(err) });
      return;
    }
  }

  const { error } = await db.from(table).delete().eq("id", row.id);
  if (error) {
    logger.error("failed to delete cache row after unlinking file", { table, id: row.id, error: error.message });
    return;
  }
  stats.rowsDeleted += 1;
}

async function fetchCandidateRows(table: string, fileColumn: string, cutoffIso: string | null): Promise<CacheRow[]> {
  const columns: string = ["id", "size_bytes", "last_used_at", fileColumn].join(", ");
  let query = db.from(table).select(columns).order("last_used_at", { ascending: true });
  if (cutoffIso) query = query.lt("last_used_at", cutoffIso);
  const { data, error } = await query;
  if (error) throw new Error(`fetching ${table} rows failed: ${error.message}`);
  return (data ?? []) as unknown as CacheRow[];
}

async function evictExpiredChildren(dryRun: boolean, cutoffIso: string, stats: EvictionStats): Promise<void> {
  for (const { table, fileColumn } of CHILD_TABLES) {
    const rows = await fetchCandidateRows(table, fileColumn, cutoffIso);
    logger.info("retention: evicting expired entries", { table, count: rows.length, cutoffIso });
    for (const row of rows) await deleteRow(stats, dryRun, table, fileColumn, row);
  }
}

/** Source rows can't be deleted while a (not-yet-evicted) child still references them — FK is RESTRICT. */
async function referencedSourceCacheIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const { table } of CHILD_TABLES) {
    const { data, error } = await db.from(table).select("source_cache_id").not("source_cache_id", "is", null);
    if (error) throw new Error(`reading source_cache_id from ${table} failed: ${error.message}`);
    for (const row of (data ?? []) as { source_cache_id: string }[]) ids.add(row.source_cache_id);
  }
  return ids;
}

async function evictExpiredSourceCache(dryRun: boolean, cutoffIso: string, stats: EvictionStats): Promise<void> {
  const rows = await fetchCandidateRows(SOURCE_TABLE, SOURCE_FILE_COLUMN, cutoffIso);
  const referenced = await referencedSourceCacheIds();
  const evictable = rows.filter((r) => !referenced.has(r.id));
  const skipped = rows.length - evictable.length;
  logger.info("retention: evicting expired source-cache entries", {
    count: evictable.length,
    skippedStillReferenced: skipped,
    cutoffIso,
  });
  for (const row of evictable) await deleteRow(stats, dryRun, SOURCE_TABLE, SOURCE_FILE_COLUMN, row);
}

async function currentTotalBytes(): Promise<number> {
  let total = 0;
  for (const { table } of [...CHILD_TABLES, { table: SOURCE_TABLE, fileColumn: SOURCE_FILE_COLUMN }]) {
    const { data, error } = await db.from(table).select("size_bytes");
    if (error) throw new Error(`summing size_bytes for ${table} failed: ${error.message}`);
    total += (data ?? []).reduce((sum, r) => sum + (r as { size_bytes: number }).size_bytes, 0);
  }
  return total;
}

/**
 * LRU eviction across all four tables combined, oldest last_used_at first,
 * until under the size budget. Children are always eligible; a source row
 * is skipped (not counted toward the freed total) if a live child still
 * references it, same as the retention pass above.
 */
async function evictOverBudget(dryRun: boolean, maxBytes: number, stats: EvictionStats): Promise<void> {
  let total = await currentTotalBytes();
  if (total <= maxBytes) {
    logger.info("cache size within budget — no size-based eviction needed", { totalBytes: total, maxBytes });
    return;
  }
  logger.info("cache size over budget — evicting oldest entries first", { totalBytes: total, maxBytes });

  const referenced = await referencedSourceCacheIds();
  type Candidate = CacheRow & { table: string; fileColumn: string };
  const all: Candidate[] = [];
  for (const { table, fileColumn } of CHILD_TABLES) {
    const rows = await fetchCandidateRows(table, fileColumn, null);
    all.push(...rows.map((r) => ({ ...r, table, fileColumn })));
  }
  const sourceRows = await fetchCandidateRows(SOURCE_TABLE, SOURCE_FILE_COLUMN, null);
  all.push(
    ...sourceRows.filter((r) => !referenced.has(r.id)).map((r) => ({ ...r, table: SOURCE_TABLE, fileColumn: SOURCE_FILE_COLUMN })),
  );
  all.sort((a, b) => new Date(a.last_used_at).getTime() - new Date(b.last_used_at).getTime());

  for (const candidate of all) {
    if (total <= maxBytes) break;
    await deleteRow(stats, dryRun, candidate.table, candidate.fileColumn, candidate);
    total -= candidate.size_bytes;
  }
  logger.info("size-based eviction complete", { remainingBytes: total, maxBytes });
}

export async function cleanupCache(opts: { dryRun: boolean }): Promise<EvictionStats> {
  const stats = newStats();

  if (config.cacheRetentionDays > 0) {
    const cutoff = new Date(Date.now() - config.cacheRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    await evictExpiredChildren(opts.dryRun, cutoff, stats);
    await evictExpiredSourceCache(opts.dryRun, cutoff, stats);
  } else {
    logger.info("CACHE_RETENTION_DAYS=0 — retention-based eviction disabled");
  }

  if (config.cacheMaxSizeGb > 0) {
    await evictOverBudget(opts.dryRun, config.cacheMaxSizeGb * 1024 * 1024 * 1024, stats);
  } else {
    logger.info("CACHE_MAX_SIZE_GB=0 — size-based eviction disabled");
  }

  return stats;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  logger.info("worker:cleanup-cache starting", {
    dryRun,
    retentionDays: config.cacheRetentionDays,
    maxSizeGb: config.cacheMaxSizeGb,
  });
  const stats = await cleanupCache({ dryRun });
  logger.info("worker:cleanup-cache finished", { ...stats, gibFreed: (stats.bytesFreed / 1024 / 1024 / 1024).toFixed(2) });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("worker:cleanup-cache failed:", err);
    process.exit(1);
  });
