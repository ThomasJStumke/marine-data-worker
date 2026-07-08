import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runTool } from "./exec.js";

export const ALGORITHM_VERSION_HILLSHADE = "depth-color-relief-v1";

// Simple blue-scale bathymetric colour ramp (elevation in metres, negative =
// underwater; 0 and above rendered transparent-ish since the layer is meant
// to sit over the base map's own land colours). Bundled inline rather than
// as a separate asset file so the worker package has no extra files to keep
// in sync with the Docker build context.
const DEPTH_COLOR_RAMP = `-11000 8 29 88 255
-6000 8 64 129 255
-3000 20 100 160 255
-1000 33 130 186 255
-500 65 165 210 255
-200 116 196 226 255
-50 171 221 236 255
-10 224 243 248 255
0 255 255 255 0
nv 0 0 0 0
`;

/** Generates the "depth shading" raster (a colour-relief bathymetric render) from the clipped source. This IS the algorithm the "algorithm_version" dataset-versioning field tracks — bump ALGORITHM_VERSION_HILLSHADE whenever the ramp or blend approach changes. */
export async function generateDepthShading(clippedTifPath: string, workDir: string): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const rampPath = path.join(workDir, "depth-ramp.txt");
  await writeFile(rampPath, DEPTH_COLOR_RAMP);

  const outPath = path.join(workDir, "shaded.tif");
  await runTool("gdaldem", ["color-relief", "-alpha", clippedTifPath, rampPath, outPath]);
  return outPath;
}
