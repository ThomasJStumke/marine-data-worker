import path from "node:path";
import { runTool, runToolCapture } from "./exec.js";

// Sentinel nodata value stamped onto masked-out (land) cells — arbitrary but
// must not collide with any real elevation value in the source data (GEBCO
// depths never approach -32768m).
const LAND_NODATA_SENTINEL = -32768;

// Natural Earth's 1:10m-scale "land" polygon set (public domain) — bundled
// in the Docker image (see Dockerfile's `COPY data ./data`) rather than
// fetched at runtime, so masking never depends on network access and never
// drifts between runs. This is a SECOND, independent land/sea boundary on
// top of the raw elevation cutoff below.
//
// Why both: elevation-only masking (checking GEBCO for anything > -1m) was
// the ONLY land exclusion before this, and it's not enough on its own —
// GEBCO's bathymetry is ~450m-resolution and disagrees with reality at
// low-lying coasts/estuaries/river mouths (e.g. a cell reads -0.3m depth
// where the real terrain is dry land, so the -1m cutoff lets it through).
// A pixel is masked to nodata if EITHER signal says land: real elevation
// above the cutoff, OR it falls inside a Natural Earth land polygon. The
// coastline vector is much higher resolution than GEBCO, so it's the
// stronger signal at the actual shoreline; the elevation check still
// catches genuine land far from the coastline vector's own inaccuracies.
const DEFAULT_COASTLINE_SHAPEFILE_PATH = path.join(process.cwd(), "data", "coastline", "ne_10m_land.shp");
const COASTLINE_SHAPEFILE_PATH = process.env.COASTLINE_SHAPEFILE_PATH || DEFAULT_COASTLINE_SHAPEFILE_PATH;
const COASTLINE_LAYER = "ne_10m_land";

type RasterGridSpec = { xsize: number; ysize: number; xmin: number; ymin: number; xmax: number; ymax: number };

async function getRasterGridSpec(tifPath: string): Promise<RasterGridSpec> {
  const raw = await runToolCapture("gdalinfo", ["-json", tifPath]);
  const info = JSON.parse(raw) as {
    size: [number, number];
    cornerCoordinates: { upperLeft: [number, number]; lowerRight: [number, number] };
  };
  const [xsize, ysize] = info.size;
  const [xmin, ymax] = info.cornerCoordinates.upperLeft;
  const [xmax, ymin] = info.cornerCoordinates.lowerRight;
  return { xsize, ysize, xmin, ymin, xmax, ymax };
}

/**
 * Rasterizes the bundled Natural Earth land polygons onto the exact same
 * grid (extent + pixel size) as `referenceTifPath`, producing a Byte raster
 * where 1 = land, 0 = sea. Pixel-aligned to the reference so it can be
 * combined with it directly in maskLandToNodata's gdal_calc expression.
 */
export async function rasterizeCoastlineMask(referenceTifPath: string, workDir: string): Promise<string> {
  const grid = await getRasterGridSpec(referenceTifPath);
  const outPath = path.join(workDir, "coastline-mask.tif");
  await runTool("gdal_rasterize", [
    "-ot", "Byte",
    "-burn", "1",
    "-init", "0",
    "-te", String(grid.xmin), String(grid.ymin), String(grid.xmax), String(grid.ymax),
    "-ts", String(grid.xsize), String(grid.ysize),
    "-l", COASTLINE_LAYER,
    COASTLINE_SHAPEFILE_PATH,
    outPath,
  ]);
  return outPath;
}

/**
 * Masks all land (and very-shallow-water) cells to nodata, so gdal_contour
 * naturally skips them instead of tracing spurious hillside/terrain contours
 * across the coastline, and gdaldem color-relief renders them fully
 * transparent (see hillshade.ts's `nv` ramp entry). A cell is masked when
 * EITHER: its elevation is strictly above maxElevationM, OR it falls inside
 * the Natural Earth land polygon (see rasterizeCoastlineMask above) — the
 * combination catches coastal-resolution disagreements that either signal
 * alone misses.
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
  const coastlineMaskPath = await rasterizeCoastlineMask(tifPath, workDir);
  const outPath = path.join(workDir, "masked.tif");
  const isSea = `((A<=${maxElevationM})*(B==0))`;
  await runTool("gdal_calc.py", [
    "-A", tifPath,
    "-B", coastlineMaskPath,
    "--outfile", outPath,
    "--calc", `A*${isSea}+(${LAND_NODATA_SENTINEL})*(1-${isSea})`,
    "--NoDataValue", String(LAND_NODATA_SENTINEL),
    "--overwrite",
  ]);
  return outPath;
}
