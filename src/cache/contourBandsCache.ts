import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/client.js";
import type { GridCell } from "../geo/contourGrid.js";
import { logger } from "../logger.js";
import { generateContourBands } from "../pipeline/contour-bands.js";
import { sha256File, fileSizeBytes } from "../pipeline/checksum.js";
import type { BathymetryProvider, BBox } from "../types.js";

export interface RegionalContourBandsResult {
  filePath: string;
  fromCache: boolean;
}

async function findContourBandsCacheEntry(
  provider: string,
  providerVersion: string,
  resolutionArcSec: number,
  contourBandsIntervalM: number,
  cell: GridCell,
  algorithmVersion: string,
): Promise<{ id: string; contourBandsFile: string; checksum: string } | null> {
  const { data, error } = await db.rpc("find_contour_bands_cache_entry", {
    p_provider: provider,
    p_provider_version: providerVersion,
    p_resolution_arc_sec: resolutionArcSec,
    p_contour_bands_interval_m: contourBandsIntervalM,
    p_algorithm_version: algorithmVersion,
    p_grid_south: cell.south,
    p_grid_west: cell.west,
  });
  if (error) throw new Error(`find_contour_bands_cache_entry failed: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { id: string; contour_bands_file: string; checksum: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, contourBandsFile: row.contour_bands_file, checksum: row.checksum };
}

async function refreshContourBandsCacheEntry(id: string, contourBandsFile: string, checksum: string, sizeBytes: number): Promise<void> {
  const { error } = await db
    .from("marine_data_contour_bands_cache")
    .update({ contour_bands_file: contourBandsFile, checksum, size_bytes: sizeBytes, last_used_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`refreshing marine_data_contour_bands_cache(${id}) failed: ${error.message}`);
}

async function storeContourBandsCacheEntry(args: {
  provider: string;
  providerVersion: string;
  resolutionArcSec: number;
  contourBandsIntervalM: number;
  cell: GridCell;
  paddedBBox: { west: number; south: number; east: number; north: number };
  contourBandsFile: string;
  checksum: string;
  sizeBytes: number;
  sourceCacheId: string | null;
  algorithmVersion: string;
}): Promise<{ id: string; contourBandsFile: string; wasExisting: boolean }> {
  const { data, error } = await db.rpc("store_contour_bands_cache_entry", {
    p_provider: args.provider,
    p_provider_version: args.providerVersion,
    p_resolution_arc_sec: args.resolutionArcSec,
    p_contour_bands_interval_m: args.contourBandsIntervalM,
    p_algorithm_version: args.algorithmVersion,
    p_grid_south: args.cell.south,
    p_grid_west: args.cell.west,
    p_west: args.paddedBBox.west,
    p_south: args.paddedBBox.south,
    p_east: args.paddedBBox.east,
    p_north: args.paddedBBox.north,
    p_contour_bands_file: args.contourBandsFile,
    p_checksum: args.checksum,
    p_size_bytes: args.sizeBytes,
    p_source_cache_id: args.sourceCacheId,
    p_metadata: {},
  });
  if (error) throw new Error(`store_contour_bands_cache_entry failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { id: string; contour_bands_file: string; was_existing: boolean };
  return { id: row.id, contourBandsFile: row.contour_bands_file, wasExisting: row.was_existing };
}

/**
 * Cache-first regional contour-band tracing: mirrors contourCache.ts's
 * fetchOrTraceRegionalContours for the fillable depth-band polygons ("Custom
 * Shading") instead of contour lines — traced once per grid cell from the
 * whole (uncut) cell raster, then vector-clipped (see
 * contour-bands.ts's clipContourBandsToPolygon) per site, so adjacent sites
 * sharing a cell get bit-identical band vertices instead of each
 * independently tracing its own rotated cutline.
 */
export async function fetchOrGenerateRegionalContourBands(
  provider: BathymetryProvider,
  resolutionArcSec: number,
  contourBandsIntervalM: number,
  cell: GridCell,
  tracedBBox: BBox,
  sourceRasterPath: string,
  sourceCacheId: string | null,
  algorithmVersion: string,
  onStage: (stage: string, message: string) => Promise<void>,
): Promise<RegionalContourBandsResult> {
  const existing = await findContourBandsCacheEntry(
    provider.name,
    provider.version,
    resolutionArcSec,
    contourBandsIntervalM,
    cell,
    algorithmVersion,
  );
  if (existing) {
    try {
      await access(existing.contourBandsFile);
      await onStage(
        "contour_bands_cache_hit",
        `Reusing cached regional contour bands for grid cell (${cell.south}, ${cell.west}) — no retracing needed`,
      );
      return { filePath: existing.contourBandsFile, fromCache: true };
    } catch {
      logger.warn("contour bands cache row found but local file missing — retracing and repairing the row", {
        contourBandsFile: existing.contourBandsFile,
      });
      const tracedPath = await traceRegionalContourBands(sourceRasterPath, contourBandsIntervalM, cell);
      const [checksum, sizeBytes] = await Promise.all([sha256File(tracedPath), fileSizeBytes(tracedPath)]);
      await refreshContourBandsCacheEntry(existing.id, tracedPath, checksum, sizeBytes);
      return { filePath: tracedPath, fromCache: false };
    }
  }

  await onStage(
    "contour_bands_cache_miss",
    `No cached regional contour bands for grid cell (${cell.south}, ${cell.west}) — tracing from the shared regional raster`,
  );
  const tracedPath = await traceRegionalContourBands(sourceRasterPath, contourBandsIntervalM, cell);
  const [checksum, sizeBytes] = await Promise.all([sha256File(tracedPath), fileSizeBytes(tracedPath)]);

  const stored = await storeContourBandsCacheEntry({
    provider: provider.name,
    providerVersion: provider.version,
    resolutionArcSec,
    contourBandsIntervalM,
    cell,
    paddedBBox: tracedBBox,
    contourBandsFile: tracedPath,
    checksum,
    sizeBytes,
    sourceCacheId,
    algorithmVersion,
  });

  if (stored.wasExisting) {
    await rm(path.dirname(tracedPath), { recursive: true, force: true }).catch(() => {});
    return { filePath: stored.contourBandsFile, fromCache: true };
  }
  return { filePath: tracedPath, fromCache: false };
}

async function traceRegionalContourBands(sourceRasterPath: string, contourBandsIntervalM: number, cell: GridCell): Promise<string> {
  const destDir = path.join(config.cacheDirectory, "contour-bands", `${cell.south}_${cell.west}_${Date.now()}`);
  await mkdir(destDir, { recursive: true });
  return generateContourBands(sourceRasterPath, destDir, contourBandsIntervalM);
}
