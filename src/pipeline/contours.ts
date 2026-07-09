import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runTool } from "./exec.js";
import { polygonToGeoJSON } from "../geo/polygon.js";
import type { CoveragePolygon } from "../types.js";

export const ALGORITHM_VERSION_CONTOURS = "gdal-contour-v3-regional";

// GEBCO elevation is positive on land, so without a ceiling gdal_contour
// happily traces land-elevation contours too (e.g. a "10" contour up a
// hillside) — same shore-crossing problem as the raster ramp in
// hillshade.ts. -amax keeps this to real depth only; -1 matches the
// raster's cutoff so the two layers agree on where "water" starts.
const MAX_ELEVATION_M = -1;

/** Generates depth-contour lines (GeoJSON) from the clipped source at a fixed interval, e.g. every 10m — land elevation (above MAX_ELEVATION_M) is excluded. */
export async function generateContours(clippedTifPath: string, workDir: string, intervalM: number): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const outPath = path.join(workDir, "contours.geojson");
  await runTool("gdal_contour", [
    "-a", "depth",
    "-i", String(intervalM),
    "-amax", String(MAX_ELEVATION_M),
    "-f", "GeoJSON",
    clippedTifPath,
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
