import { runTool } from "./exec.js";
import { fileSizeBytes } from "./checksum.js";

/** Sanity-checks a generated PMTiles file before upload: non-empty, and readable by the pmtiles CLI's own header validator. */
export async function validatePmtiles(filePath: string): Promise<void> {
  const size = await fileSizeBytes(filePath);
  if (size === 0) throw new Error(`Generated PMTiles file is empty: ${filePath}`);
  await runTool("pmtiles", ["show", filePath]);
}
