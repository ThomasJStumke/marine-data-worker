import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runTool } from "./exec.js";
import { maskLandToNodata } from "./landmask.js";
import { polygonToGeoJSON } from "../geo/polygon.js";
import type { CoveragePolygon } from "../types.js";

// v5: land is now actually excluded via landmask.ts (masked to nodata before
// tracing, no -inodata flag so gdal_contour respects that nodata tag) —
// v1-v3's "-amax <number>" was a no-op (see landmask.ts's doc comment), and
// the first cut at v4 wrongly passed -inodata (which means "ignore nodata",
// the opposite of excluding it), producing a spurious contour traced right
// down to the nodata sentinel value. Bumping this busts
// marine_data_contour_cache (keyed on algorithm_version, see
// 20260718000000_contour_cache_algorithm_version.sql) so already-cached grid
// cells retrace with the real fix instead of serving a still-broken trace.
export const ALGORITHM_VERSION_CONTOURS = "gdal-contour-v5-landmask-fixed";

// GEBCO elevation is positive on land. -1 matches the raster ramp's cutoff
// in hillshade.ts so the two layers agree on where "water" starts.
const MAX_ELEVATION_M = -1;

/** Generates depth-contour lines (GeoJSON) from the clipped source at a fixed interval, e.g. every 10m — land elevation (above MAX_ELEVATION_M) is excluded. */
export async function generateContours(clippedTifPath: string, workDir: string, intervalM: number): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const maskedPath = await maskLandToNodata(clippedTifPath, workDir, MAX_ELEVATION_M);
  const outPath = path.join(workDir, "contours.geojson");
  // No -inodata here — that flag means "ignore nodata and contour through
  // it anyway" (confirmed via gdal_contour --help/docs), the OPPOSITE of
  // what's needed. Omitting it makes gdal_contour respect the masked
  // raster's NoDataValue tag (set by maskLandToNodata) and correctly skip
  // land instead of tracing a spurious contour down to the nodata sentinel.
  await runTool("gdal_contour", [
    "-a", "depth",
    "-i", String(intervalM),
    "-f", "GeoJSON",
    maskedPath,
    outPath,
  ]);
  return outPath;
}

/**
 * Windows an already-traced, already-continuous regional contour set (see
 * cache/contourCache.ts) down to one launch site's own rotated, offshore-
 * biased polygon — the vector-output equivalent of clip.ts's raster
 * cutline, preserving the same intentional land/inland exclusion, but
 * applied AFTER tracing instead of before it. Two sites sharing a region
 * end up with bit-identical vertices in their overlap because both are
 * windows of the exact same source geometry.
 */
export async function clipContoursToPolygon(
  regionalGeoJsonPath: string,
  polygon: CoveragePolygon,
  workDir: string,
): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const cutlinePath = path.join(workDir, "site-coverage.geojson");
  await writeFile(cutlinePath, JSON.stringify(polygonToGeoJSON(polygon)));

  const outPath = path.join(workDir, "site-contours.geojson");
  await runTool("ogr2ogr", ["-f", "GeoJSON", "-clipsrc", cutlinePath, outPath, regionalGeoJsonPath]);
  await assertNonTrivialContours(outPath);
  return outPath;
}

/**
 * Throws (not just warns) when a site's clipped contours look emptier than
 * its own coverage polygon would justify — e.g. a CRS/extent mismatch
 * between the regional trace and this site's polygon. Must throw so
 * markJobFailed's "never overwrite a working layer" guarantee actually
 * engages instead of silently uploading an empty PMTiles archive over a
 * working one.
 */
async function assertNonTrivialContours(geojsonPath: string): Promise<void> {
  const raw = await readFile(geojsonPath, "utf-8");
  const parsed = JSON.parse(raw) as { features?: unknown[] };
  const featureCount = parsed.features?.length ?? 0;
  if (featureCount === 0) {
    throw new Error(
      `Clipped contours for ${geojsonPath} contain 0 features — refusing to publish an empty contour layer`,
    );
  }
}
