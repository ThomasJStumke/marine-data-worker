import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runTool } from "./exec.js";

export const ALGORITHM_VERSION_CONTOURS = "gdal-contour-v2";

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
