import path from "node:path";
import { runTool } from "./exec.js";

// Sentinel nodata value stamped onto masked-out (land) cells — arbitrary but
// must not collide with any real elevation value in the source data (GEBCO
// depths never approach -32768m).
const LAND_NODATA_SENTINEL = -32768;

/**
 * Masks all land (and very-shallow-water) cells — elevation strictly above
 * maxElevationM — to nodata, so gdal_contour's `-inodata` flag makes it
 * naturally skip them instead of tracing spurious hillside/terrain contours
 * across the coastline. Mirrors hillshade.ts's DEPTH_COLOR_RAMP alpha=0 land
 * cutoff, but at the raster level so contours.ts/contour-bands.ts get the
 * same cutoff.
 *
 * NOTE: gdal_contour's `-amin`/`-amax` flags are ALWAYS attribute-name
 * options (only meaningful together with `-p`, polygon mode) in this GDAL
 * version — never an elevation-range filter, confirmed via `gdal_contour
 * --help`. An earlier version of this pipeline passed `-amax <number>`
 * expecting it to act as an elevation ceiling; it silently did nothing,
 * which is why land contours kept appearing despite that code's intent.
 * Masking the input raster (this function) is the actual fix.
 */
export async function maskLandToNodata(tifPath: string, workDir: string, maxElevationM: number): Promise<string> {
  const outPath = path.join(workDir, "masked.tif");
  await runTool("gdal_calc.py", [
    "-A", tifPath,
    "--outfile", outPath,
    "--calc", `A*(A<=${maxElevationM})+(${LAND_NODATA_SENTINEL})*(A>${maxElevationM})`,
    "--NoDataValue", String(LAND_NODATA_SENTINEL),
    "--overwrite",
  ]);
  return outPath;
}
