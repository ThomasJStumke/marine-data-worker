import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/client.js";
import type { GridCell } from "../geo/contourGrid.js";
import { logger } from "../logger.js";
import { generateContours } from "../pipeline/contours.js";
import { sha256File, fileSizeBytes } from "../pipeline/checksum.js";
import type { BathymetryProvider, BBox } from "../types.js";

export interface RegionalContoursResult {
  filePath: string;
  fromCache: boolean;
}

async function findContourCacheEntry(
  provider: string,
  providerVersion: string,
  resolutionArcSec: number,
  contourIntervalM: number,
  cell: GridCell,
): Promise<{ id: string; contoursFile: string; checksum: string } | null> {
  const { data, error } = await db.rpc("find_contour_cache_entry", {
    p_provider: provider,
    p_provider_version: providerVersion,
    p_resolution_arc_sec: resolutionArcSec,
    p_contour_interval_m: contourIntervalM,
    p_grid_south: cell.south,
    p_grid_west: cell.west,
  });
  if (error) throw new Error(`find_contour_cache_entry failed: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { id: string; contours_file: string; checksum: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, contoursFile: row.contours_file, checksum: row.checksum };
}

/** Repairs a cache row whose file was verified missing on disk — a plain UPDATE by id, not the insert-or-fetch path (which would just hand back the same stale row via ON CONFLICT DO NOTHING). */
async function refreshContourCacheEntry(id: string, contoursFile: string, checksum: string, sizeBytes: number): Promise<void> {
  const { error } = await db
    .from("marine_data_contour_cache")
    .update({ contours_file: contoursFile, checksum, size_bytes: sizeBytes, last_used_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`refreshing marine_data_contour_cache(${id}) failed: ${error.message}`);
}

async function storeContourCacheEntry(args: {
  provider: string;
  providerVersion: string;
  resolutionArcSec: number;
  contourIntervalM: number;
  cell: GridCell;
  paddedBBox: { west: number; south: number; east: number; north: number };
  contoursFile: string;
  checksum: string;
  sizeBytes: number;
  sourceCacheId: string | null;
}): Promise<{ id: string; contoursFile: string; wasExisting: boolean }> {
  const { data, error } = await db.rpc("store_contour_cache_entry", {
    p_provider: args.provider,
    p_provider_version: args.providerVersion,
    p_resolution_arc_sec: args.resolutionArcSec,
    p_contour_interval_m: args.contourIntervalM,
    p_grid_south: args.cell.south,
    p_grid_west: args.cell.west,
    p_west: args.paddedBBox.west,
    p_south: args.paddedBBox.south,
    p_east: args.paddedBBox.east,
    p_north: args.paddedBBox.north,
    p_contours_file: args.contoursFile,
    p_checksum: args.checksum,
    p_size_bytes: args.sizeBytes,
    p_source_cache_id: args.sourceCacheId,
    p_metadata: {},
  });
  if (error) throw new Error(`store_contour_cache_entry failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { id: string; contours_file: string; was_existing: boolean };
  return { id: row.id, contoursFile: row.contours_file, wasExisting: row.was_existing };
}

/**
 * Cache-first regional contour tracing: a grid-cell cache hit reuses the
 * exact same trace every site in that cell already shares (see
 * geo/contourGrid.ts) — no re-tracing, no per-site rotation/mismatch. A
 * miss traces the WHOLE wide raster (no cutline — see generateContours)
 * once, so every site that later resolves to this cell shares this exact
 * output. A concurrent miss for the same cell (possible under
 * MAX_CONCURRENT_JOBS > 1) is resolved by store_contour_cache_entry's
 * atomic insert-or-fetch: whichever job loses the race discards its own
 * freshly-traced file and reuses the winner's.
 *
 * The traced file is written into config.cacheDirectory (persistent,
 * survives across jobs/restarts — same convention as sourceCache.ts), NOT
 * the caller's per-job workDir, which processJob.ts always rm -rf's once
 * that job finishes. Writing into workDir would make every cache row
 * outlive its own file by exactly one job — the next job to look it up
 * would always find it already deleted.
 */
export async function fetchOrTraceRegionalContours(
  provider: BathymetryProvider,
  resolutionArcSec: number,
  contourIntervalM: number,
  cell: GridCell,
  tracedBBox: BBox, // the ACTUAL bbox sourceRasterPath covers — stored verbatim as this cache row's extent, never recomputed, so it never drifts from what generateContours actually traced
  sourceRasterPath: string,
  sourceCacheId: string | null,
  onStage: (stage: string, message: string) => Promise<void>,
): Promise<RegionalContoursResult> {
  const existing = await findContourCacheEntry(provider.name, provider.version, resolutionArcSec, contourIntervalM, cell);
  if (existing) {
    try {
      await access(existing.contoursFile);
      await onStage(
        "contours_cache_hit",
        `Reusing cached contours for grid cell (${cell.south}, ${cell.west}) — no retracing needed`,
      );
      return { filePath: existing.contoursFile, fromCache: true };
    } catch {
      logger.warn("contour cache row found but local file missing — retracing and repairing the row", {
        contoursFile: existing.contoursFile,
      });
      const tracedPath = await traceRegionalContours(sourceRasterPath, contourIntervalM, cell);
      const [checksum, sizeBytes] = await Promise.all([sha256File(tracedPath), fileSizeBytes(tracedPath)]);
      // A plain UPDATE by id, not the insert-or-fetch path below — that path's
      // ON CONFLICT DO NOTHING would just hand back this same stale row again.
      await refreshContourCacheEntry(existing.id, tracedPath, checksum, sizeBytes);
      return { filePath: tracedPath, fromCache: false };
    }
  }

  await onStage(
    "contours_cache_miss",
    `No cached contours for grid cell (${cell.south}, ${cell.west}) — tracing from the shared regional raster`,
  );
  const tracedPath = await traceRegionalContours(sourceRasterPath, contourIntervalM, cell);
  const [checksum, sizeBytes] = await Promise.all([sha256File(tracedPath), fileSizeBytes(tracedPath)]);

  const stored = await storeContourCacheEntry({
    provider: provider.name,
    providerVersion: provider.version,
    resolutionArcSec,
    contourIntervalM,
    cell,
    paddedBBox: tracedBBox,
    contoursFile: tracedPath,
    checksum,
    sizeBytes,
    sourceCacheId,
  });

  if (stored.wasExisting) {
    // A concurrent job won the race for this exact cell — reuse its file
    // and best-effort clean up our own now-redundant trace (persistent
    // cache dir, not workDir — nothing else will ever remove it).
    await rm(path.dirname(tracedPath), { recursive: true, force: true }).catch(() => {});
    return { filePath: stored.contoursFile, fromCache: true };
  }
  return { filePath: tracedPath, fromCache: false };
}

async function traceRegionalContours(sourceRasterPath: string, contourIntervalM: number, cell: GridCell): Promise<string> {
  const destDir = path.join(config.cacheDirectory, "contours", `${cell.south}_${cell.west}_${Date.now()}`);
  await mkdir(destDir, { recursive: true });
  return generateContours(sourceRasterPath, destDir, contourIntervalM);
}
