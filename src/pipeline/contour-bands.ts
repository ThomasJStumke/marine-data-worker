import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runTool } from "./exec.js";
import { maskLandToNodata } from "./landmask.js";
import { polygonToGeoJSON } from "../geo/polygon.js";
import type { CoveragePolygon } from "../types.js";

// v6: landmask.ts's maskLandToNodata now ALSO checks a Natural Earth
// coastline polygon in addition to the raw elevation cutoff (see
// landmask.ts) — GEBCO's ~450m resolution disagrees with the real coastline
// at low-lying coasts/estuaries, so elevation alone let some land bands
// through (visible as filled, depth-labelled polygons over land). Bumping
// busts marine_data_contour_bands_cache so nothing serves a pre-coastline-mask
// trace.
export const ALGORITHM_VERSION_CONTOUR_BANDS = "gdal-contour-bands-v6-coastline-mask";

// Same land-exclusion cutoff as contours.ts's MAX_ELEVATION_M. The ogr2ogr
// -where filter below is a real elevation filter (unlike gdal_contour's own
// -amin/-amax, which are just attribute names in polygon mode) and was
// already correctly excluding land bands — masking is added on top mainly to
// avoid tracing/emitting land polygons at all, and to match contours.ts.
const MAX_ELEVATION_M = -1;
export const DEPTH_MIN_FIELD = "depth_min";
export const DEPTH_MAX_FIELD = "depth_max";

/**
 * Generates filled depth-band polygons (GeoJSON) at a fixed interval from
 * the given source raster, each tagged with depth_min/depth_max — the
 * fillable counterpart to contours.ts's lines. Called once per regional grid
 * cell on the whole (uncut) cell raster (see cache/contourBandsCache.ts),
 * then windowed down to each site's own polygon via
 * clipContourBandsToPolygon below — the same cache-once-clip-per-site
 * pattern contours.ts uses for line contours, which is what makes adjacent
 * sites sharing a cell produce bit-identical band vertices instead of
 * mismatched fills at their shared edge.
 *
 * Client-side, a user's custom depth-range colors are matched against each
 * band's depth_min (see FishingSpotsMap's syncContourBandsTier) — this
 * interval is deliberately finer than the line contours' so that remapping
 * doesn't produce visibly chunkier bands than the user actually configured.
 */
export async function generateContourBands(clippedTifPath: string, workDir: string, intervalM: number): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const maskedPath = await maskLandToNodata(clippedTifPath, workDir, MAX_ELEVATION_M);
  const rawPath = path.join(workDir, "contour-bands-raw.geojson");
  // No -inodata — see contours.ts's generateContours for why (it means
  // "ignore nodata", the opposite of the desired land exclusion).
  await runTool("gdal_contour", [
    "-p",
    "-amin", DEPTH_MIN_FIELD,
    "-amax", DEPTH_MAX_FIELD,
    "-i", String(intervalM),
    "-f", "GeoJSON",
    maskedPath,
    rawPath,
  ]);

  // depth_min > REALISTIC_OCEAN_FLOOR_M guards against gdal_contour's
  // polygon mode occasionally tagging the deepest band's lower bound with
  // the raw nodata sentinel (-32768, see landmask.ts) instead of a real
  // depth — observed on a real test run. No ocean trench comes close to
  // -11000m, so anything past that is unambiguously a masking artifact, not
  // real bathymetry.
  const REALISTIC_OCEAN_FLOOR_M = -11000;
  const outPath = path.join(workDir, "contour-bands.geojson");
  await runTool("ogr2ogr", [
    "-f", "GeoJSON",
    "-where", `${DEPTH_MAX_FIELD} <= ${MAX_ELEVATION_M} AND ${DEPTH_MIN_FIELD} > ${REALISTIC_OCEAN_FLOOR_M}`,
    outPath,
    rawPath,
  ]);
  return outPath;
}

/**
 * Windows an already-traced, already-continuous regional contour-bands set
 * (see cache/contourBandsCache.ts) down to one launch site's own rotated,
 * offshore-biased polygon — the exact counterpart of contours.ts's
 * clipContoursToPolygon, for filled bands instead of lines.
 */
export async function clipContourBandsToPolygon(
  regionalGeoJsonPath: string,
  polygon: CoveragePolygon,
  workDir: string,
): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const cutlinePath = path.join(workDir, "bands-site-coverage.geojson");
  await writeFile(cutlinePath, JSON.stringify(polygonToGeoJSON(polygon)));

  const outPath = path.join(workDir, "site-contour-bands.geojson");
  await runTool("ogr2ogr", ["-f", "GeoJSON", "-clipsrc", cutlinePath, outPath, regionalGeoJsonPath]);
  await assertNonTrivialBands(outPath);
  return outPath;
}

/**
 * Throws (not just warns) when a site's clipped contour bands look emptier
 * than its own coverage polygon would justify — mirrors contours.ts's
 * assertNonTrivialContours, for the same "never publish an empty layer"
 * reason.
 */
async function assertNonTrivialBands(geojsonPath: string): Promise<void> {
  const raw = await readFile(geojsonPath, "utf-8");
  const parsed = JSON.parse(raw) as { features?: unknown[] };
  const featureCount = parsed.features?.length ?? 0;
  if (featureCount === 0) {
    throw new Error(
      `Clipped contour bands for ${geojsonPath} contain 0 features — refusing to publish an empty contour-bands layer`,
    );
  }
}
