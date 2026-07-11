import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/client.js";
import type { GridCell } from "../geo/contourGrid.js";
import { logger } from "../logger.js";
import { generateDepthShading } from "../pipeline/hillshade.js";
import { sha256File, fileSizeBytes } from "../pipeline/checksum.js";
import type { BathymetryProvider, BBox } from "../types.js";

export interface RegionalHillshadeResult {
  filePath: string;
  fromCache: boolean;
}

async function findHillshadeCacheEntry(
  provider: string,
  providerVersion: string,
  resolutionArcSec: number,
  cell: GridCell,
  algorithmVersion: string,
): Promise<{ id: string; hillshadeFile: string; checksum: string } | null> {
  const { data, error } = await db.rpc("find_hillshade_cache_entry", {
    p_provider: provider,
    p_provider_version: providerVersion,
    p_resolution_arc_sec: resolutionArcSec,
    p_algorithm_version: algorithmVersion,
    p_grid_south: cell.south,
    p_grid_west: cell.west,
  });
  if (error) throw new Error(`find_hillshade_cache_entry failed: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { id: string; hillshade_file: string; checksum: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, hillshadeFile: row.hillshade_file, checksum: row.checksum };
}

async function refreshHillshadeCacheEntry(id: string, hillshadeFile: string, checksum: string, sizeBytes: number): Promise<void> {
  const { error } = await db
    .from("marine_data_hillshade_cache")
    .update({ hillshade_file: hillshadeFile, checksum, size_bytes: sizeBytes, last_used_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`refreshing marine_data_hillshade_cache(${id}) failed: ${error.message}`);
}

async function storeHillshadeCacheEntry(args: {
  provider: string;
  providerVersion: string;
  resolutionArcSec: number;
  cell: GridCell;
  paddedBBox: { west: number; south: number; east: number; north: number };
  hillshadeFile: string;
  checksum: string;
  sizeBytes: number;
  sourceCacheId: string | null;
  algorithmVersion: string;
}): Promise<{ id: string; hillshadeFile: string; wasExisting: boolean }> {
  const { data, error } = await db.rpc("store_hillshade_cache_entry", {
    p_provider: args.provider,
    p_provider_version: args.providerVersion,
    p_resolution_arc_sec: args.resolutionArcSec,
    p_algorithm_version: args.algorithmVersion,
    p_grid_south: args.cell.south,
    p_grid_west: args.cell.west,
    p_west: args.paddedBBox.west,
    p_south: args.paddedBBox.south,
    p_east: args.paddedBBox.east,
    p_north: args.paddedBBox.north,
    p_hillshade_file: args.hillshadeFile,
    p_checksum: args.checksum,
    p_size_bytes: args.sizeBytes,
    p_source_cache_id: args.sourceCacheId,
    p_metadata: {},
  });
  if (error) throw new Error(`store_hillshade_cache_entry failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { id: string; hillshade_file: string; was_existing: boolean };
  return { id: row.id, hillshadeFile: row.hillshade_file, wasExisting: row.was_existing };
}

/**
 * Cache-first regional depth-shading: mirrors contourCache.ts's
 * fetchOrTraceRegionalContours, but for the color-relief raster instead of
 * line contours — generated once per grid cell from the whole (uncut) cell
 * raster, so every site sharing a cell clips (see clip.ts's clipToPolygon)
 * an identical source raster instead of each independently color-relief'ing
 * its own rotated cutline, which is what caused shading seams/gaps between
 * adjacent sites.
 */
export async function fetchOrGenerateRegionalHillshade(
  provider: BathymetryProvider,
  resolutionArcSec: number,
  cell: GridCell,
  tracedBBox: BBox,
  sourceRasterPath: string,
  sourceCacheId: string | null,
  algorithmVersion: string,
  onStage: (stage: string, message: string) => Promise<void>,
): Promise<RegionalHillshadeResult> {
  const existing = await findHillshadeCacheEntry(provider.name, provider.version, resolutionArcSec, cell, algorithmVersion);
  if (existing) {
    try {
      await access(existing.hillshadeFile);
      await onStage(
        "hillshade_cache_hit",
        `Reusing cached regional hillshade for grid cell (${cell.south}, ${cell.west}) — no regeneration needed`,
      );
      return { filePath: existing.hillshadeFile, fromCache: true };
    } catch {
      logger.warn("hillshade cache row found but local file missing — regenerating and repairing the row", {
        hillshadeFile: existing.hillshadeFile,
      });
      const generatedPath = await generateRegionalHillshade(sourceRasterPath, cell);
      const [checksum, sizeBytes] = await Promise.all([sha256File(generatedPath), fileSizeBytes(generatedPath)]);
      await refreshHillshadeCacheEntry(existing.id, generatedPath, checksum, sizeBytes);
      return { filePath: generatedPath, fromCache: false };
    }
  }

  await onStage(
    "hillshade_cache_miss",
    `No cached regional hillshade for grid cell (${cell.south}, ${cell.west}) — generating from the shared regional raster`,
  );
  const generatedPath = await generateRegionalHillshade(sourceRasterPath, cell);
  const [checksum, sizeBytes] = await Promise.all([sha256File(generatedPath), fileSizeBytes(generatedPath)]);

  const stored = await storeHillshadeCacheEntry({
    provider: provider.name,
    providerVersion: provider.version,
    resolutionArcSec,
    cell,
    paddedBBox: tracedBBox,
    hillshadeFile: generatedPath,
    checksum,
    sizeBytes,
    sourceCacheId,
    algorithmVersion,
  });

  if (stored.wasExisting) {
    await rm(path.dirname(generatedPath), { recursive: true, force: true }).catch(() => {});
    return { filePath: stored.hillshadeFile, fromCache: true };
  }
  return { filePath: generatedPath, fromCache: false };
}

async function generateRegionalHillshade(sourceRasterPath: string, cell: GridCell): Promise<string> {
  const destDir = path.join(config.cacheDirectory, "hillshade", `${cell.south}_${cell.west}_${Date.now()}`);
  await mkdir(destDir, { recursive: true });
  return generateDepthShading(sourceRasterPath, destDir);
}
