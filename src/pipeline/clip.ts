import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runTool } from "./exec.js";
import { polygonToGeoJSON } from "../geo/polygon.js";
import type { CoveragePolygon } from "../types.js";

/**
 * Clips a source raster to the launch site's actual coverage POLYGON (via
 * gdalwarp -cutline), not just its bounding box — the polygon is
 * offshore-biased (see geo/polygon.ts), so a plain bbox clip would keep
 * corners of land/sea that the polygon deliberately excludes.
 */
export async function clipToPolygon(sourceTifPath: string, polygon: CoveragePolygon, workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const cutlinePath = path.join(workDir, "coverage.geojson");
  await writeFile(cutlinePath, JSON.stringify(polygonToGeoJSON(polygon)));

  const outPath = path.join(workDir, "clipped.tif");
  await runTool("gdalwarp", [
    "-of", "GTiff",
    "-t_srs", "EPSG:4326",
    "-cutline", cutlinePath,
    "-crop_to_cutline",
    "-dstnodata", "0",
    "-overwrite",
    sourceTifPath,
    outPath,
  ]);
  return outPath;
}
