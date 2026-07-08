import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runTool } from "./exec.js";

export const ALGORITHM_VERSION_CONTOURS = "gdal-contour-v1";

/** Generates depth-contour lines (GeoJSON) from the clipped source at a fixed interval, e.g. every 10m. */
export async function generateContours(clippedTifPath: string, workDir: string, intervalM: number): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const outPath = path.join(workDir, "contours.geojson");
  await runTool("gdal_contour", [
    "-a", "depth",
    "-i", String(intervalM),
    "-f", "GeoJSON",
    clippedTifPath,
    outPath,
  ]);
  return outPath;
}
