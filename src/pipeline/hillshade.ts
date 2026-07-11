import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runTool } from "./exec.js";

// v3: generated ONCE per regional grid cell and clipped per site (see
// cache/hillshadeCache.ts and clip.ts's clipToPolygon), instead of
// independently per site — this is what fixes the seams/gaps between
// adjacent sites' depth-shading tiles. Bumping busts marine_data_hillshade_cache
// so nothing serves a pre-regional raster.
export const ALGORITHM_VERSION_HILLSHADE = "depth-color-relief-v3-regional";

// Simple blue-scale bathymetric colour ramp (elevation in metres, negative =
// underwater). Bundled inline rather than as a separate asset file so the
// worker package has no extra files to keep in sync with the Docker build
// context.
//
// Land (and very shallow water above -1m) must render fully transparent —
// otherwise this raster draws as a solid block over land wherever a launch
// site's coverage polygon includes any shore/inland margin (it always
// includes a small one, see bathymetry_coverage_inland_km). v1 only put the
// alpha=0 stop at exactly 0m, and gdaldem linearly interpolates alpha
// between adjacent stops — so -10m..0m faded gradually instead of cutting
// off, leaving a visible smear at the coastline instead of a crisp edge.
// The -1.001/-1 pair below is intentionally ~1mm apart: real depth data
// still interpolates smoothly down to -1.001, then alpha drops to 0 within
// that last sliver, giving an effectively hard cutoff at -1m without
// disabling interpolation for the actual depth colours further out.
const DEPTH_COLOR_RAMP = `-11000 8 29 88 255
-6000 8 64 129 255
-3000 20 100 160 255
-1000 33 130 186 255
-500 65 165 210 255
-200 116 196 226 255
-50 171 221 236 255
-10 224 243 248 255
-1.001 224 243 248 255
-1 255 255 255 0
0 255 255 255 0
nv 0 0 0 0
`;

/** Generates the "depth shading" raster (a colour-relief bathymetric render) from the given source raster — called once per regional grid cell (see cache/hillshadeCache.ts) on the whole uncut cell raster, then clipped per site. This IS the algorithm the "algorithm_version" dataset-versioning field tracks — bump ALGORITHM_VERSION_HILLSHADE whenever the ramp or blend approach changes. */
export async function generateDepthShading(sourceTifPath: string, workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const rampPath = path.join(workDir, "depth-ramp.txt");
  await writeFile(rampPath, DEPTH_COLOR_RAMP);

  const outPath = path.join(workDir, "shaded.tif");
  await runTool("gdaldem", ["color-relief", "-alpha", sourceTifPath, rampPath, outPath]);
  return outPath;
}
