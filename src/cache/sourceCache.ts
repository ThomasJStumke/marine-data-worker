import { access } from "node:fs/promises";
import path from "node:path";
import { db } from "../db/client.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { padBBox } from "../geo/polygon.js";
import type { BathymetryProvider, BBox, SourceFetchResult } from "../types.js";

export interface CacheLookupResult {
  hit: boolean;
  fullyContains: boolean;
  overlapRatio: number;
  filePath: string;
  checksum: string;
  sourceCacheId: string;
}

/**
 * Geography-aware source cache. Unlike a plain string-keyed cache, "does a
 * cache entry satisfy this request" is answered by a real PostGIS spatial
 * query (find_covering_source_cache — ST_Contains / ST_Intersects +
 * overlap-ratio, see the 20260710000000 migration), not by comparing an
 * opaque key. That's what lets nearby-but-not-identical launch site
 * polygons (Cape Vidal / St Lucia / Mapelane / Sodwana all sit within a few
 * km of each other) share one provider download: their bounding boxes
 * differ, but a sufficiently large cached extent spatially contains all of
 * them.
 *
 * To make that containment likely in the first place, every fresh download
 * is padded by SOURCE_DOWNLOAD_PADDING_KM beyond what the current job
 * actually needs (see fetchWithCache below) — the padding is what turns
 * "occasionally overlapping" into "usually fully contains the next nearby
 * request".
 */
export async function findCachedSource(
  provider: string,
  providerVersion: string,
  resolutionArcSec: number,
  bbox: BBox,
): Promise<CacheLookupResult | null> {
  const { data, error } = await db.rpc("find_covering_source_cache", {
    p_provider: provider,
    p_provider_version: providerVersion,
    p_resolution_arc_sec: resolutionArcSec,
    p_west: bbox.west,
    p_south: bbox.south,
    p_east: bbox.east,
    p_north: bbox.north,
    p_min_overlap_ratio: config.sourceCacheMinOverlapRatio,
  });
  if (error) throw new Error(`find_covering_source_cache failed: ${error.message}`);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { id: string; source_file: string; checksum: string; fully_contains: boolean; overlap_ratio: number }
    | undefined;
  if (!row) return null;

  // The DB row can outlive the worker's local disk (a redeployed volume, a
  // different worker instance's ephemeral disk in a non-shared-cache setup,
  // etc.) — verify the file is actually still present before trusting the hit.
  try {
    await access(row.source_file);
  } catch {
    logger.warn("cache row found but local file missing — treating as cache miss", { filePath: row.source_file });
    return null;
  }

  await touchCacheEntry(row.id);

  return {
    hit: true,
    fullyContains: row.fully_contains,
    overlapRatio: row.overlap_ratio,
    filePath: row.source_file,
    checksum: row.checksum,
    sourceCacheId: row.id,
  };
}

async function touchCacheEntry(id: string): Promise<void> {
  await db.from("marine_data_source_cache").update({ last_used_at: new Date().toISOString() }).eq("id", id);
}

async function storeCacheEntry(result: SourceFetchResult): Promise<string> {
  const { data, error } = await db.rpc("store_source_cache_entry", {
    p_provider: result.provider,
    p_provider_version: result.providerVersion,
    p_resolution_arc_sec: result.resolutionArcSec,
    p_west: result.bbox.west,
    p_south: result.bbox.south,
    p_east: result.bbox.east,
    p_north: result.bbox.north,
    p_source_file: result.filePath,
    p_checksum: result.checksum,
    p_size_bytes: result.sizeBytes,
    p_metadata: {},
  });
  if (error) throw new Error(`store_source_cache_entry failed: ${error.message}`);
  return data as string;
}

/**
 * Cache-first source acquisition: spatial cache hit -> reuse the file on
 * disk, no provider call at all. Cache miss -> download a PADDED bbox from
 * the provider (so this download itself becomes a covering cache entry for
 * future nearby jobs) and record it in marine_data_source_cache.
 */
export async function fetchSourceWithCache(
  provider: BathymetryProvider,
  requestedBBox: BBox,
  resolutionArcSec: number,
  latitude: number,
  onStage: (stage: string, message: string) => Promise<void>,
): Promise<{ filePath: string; fromCache: boolean; sourceCacheId: string }> {
  const cached = await findCachedSource(provider.name, provider.version, resolutionArcSec, requestedBBox);
  if (cached) {
    await onStage(
      "cache_hit",
      `Reusing cached ${provider.name} source (${cached.fullyContains ? "fully contains" : `${Math.round(cached.overlapRatio * 100)}% overlap`}) — no download needed`,
    );
    return { filePath: cached.filePath, fromCache: true, sourceCacheId: cached.sourceCacheId };
  }

  await onStage("cache_miss", `No cached ${provider.name} source covers this area — downloading`);
  const paddedBBox = padBBox(requestedBBox, config.sourceDownloadPaddingKm, latitude);
  await onStage(
    "downloading",
    `Downloading ${provider.name} source for padded bbox (±${config.sourceDownloadPaddingKm}km) so nearby launch sites can reuse it`,
  );

  const destDir = path.join(config.cacheDirectory, provider.name);
  const result = await provider.fetchSource({ bbox: paddedBBox, resolutionArcSec }, destDir);
  const sourceCacheId = await storeCacheEntry(result);

  return { filePath: result.filePath, fromCache: false, sourceCacheId };
}
