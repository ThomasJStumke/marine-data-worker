import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runTool } from "./exec.js";
import { config } from "../config.js";

// Tag stamped onto every job's `pmtiles_version` column. Bump if the tiling
// approach below changes (e.g. switching mbtiles-intermediate raster tiling
// for a direct rio-pmtiles path) even if the pmtiles CLI/spec version itself
// didn't change.
export const PMTILES_BUILD_VERSION = "pmtiles-build-v1";

/** Raster (depth-shading) GeoTIFF -> MBTiles -> PMTiles. */
export async function rasterToPmtiles(shadedTifPath: string, workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const mbtilesPath = path.join(workDir, "bathymetry.mbtiles");
  const pmtilesPath = path.join(workDir, "bathymetry.pmtiles");

  await runTool("gdal_translate", [
    "-of", "MBTILES",
    "-co", "TILE_FORMAT=PNG",
    shadedTifPath,
    mbtilesPath,
  ]);
  await runTool("gdaladdo", ["-r", "average", mbtilesPath, ...zoomLevels()]);
  await runTool("pmtiles", ["convert", mbtilesPath, pmtilesPath]);
  return pmtilesPath;
}

/** Vector (contours) GeoJSON -> PMTiles directly via tippecanoe. */
export async function contoursToPmtiles(contoursGeoJsonPath: string, workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const pmtilesPath = path.join(workDir, "contours.pmtiles");

  await runTool("tippecanoe", [
    "-o", pmtilesPath,
    "-l", "contours",
    "-Z", String(config.minZoom),
    "-z", String(config.maxZoom),
    "--force",
    contoursGeoJsonPath,
  ]);
  return pmtilesPath;
}

function zoomLevels(): string[] {
  const levels: string[] = [];
  for (let z = 2; z <= config.maxZoom - config.minZoom; z *= 2) levels.push(String(z));
  return levels;
}
