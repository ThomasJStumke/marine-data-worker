import { readdir, symlink, rename, rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { claimNextGridImport, markGridImportStage, markGridImportCompleted, markGridImportFailed } from "../db/gridImports.js";
import { downloadToFile } from "../pipeline/download.js";
import { runTool, runToolCapture } from "../pipeline/exec.js";
import { sha256File, fileSizeBytes } from "../pipeline/checksum.js";
import type { GridImportJob } from "../types.js";

const RASTER_EXTENSIONS = [".nc", ".tif", ".tiff"];

/** Recursively finds the first .nc/.tif/.tiff file under dir — used after extracting a .zip download. */
async function findRasterFile(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (RASTER_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      return path.join(entry.parentPath ?? entry.path ?? dir, entry.name);
    }
  }
  return null;
}

/**
 * Downloads a grid file from an admin-submitted URL, extracts it if it's a
 * .zip, validates it's actually a raster gdalinfo can open, and — only on
 * success — atomically re-points the `current.nc` symlink GEBCOProvider
 * reads from (config.gebcoLocalGridPath). A failed import never touches the
 * existing symlink, so a bad URL can't take down bathymetry generation.
 */
async function processImport(job: GridImportJob): Promise<void> {
  const importsDir = path.join(config.gridStorageDir, "imports");

  try {
    await markGridImportStage(job.id, "downloading");
    const basename = path.basename(new URL(job.url).pathname) || `grid-${job.id}.bin`;
    const downloadPath = path.join(importsDir, `${Date.now()}-${basename}`);
    logger.info("downloading grid import", { jobId: job.id, url: job.url, downloadPath });
    await downloadToFile(job.url, downloadPath);

    let gridPath = downloadPath;
    if (downloadPath.toLowerCase().endsWith(".zip")) {
      await markGridImportStage(job.id, "extracting");
      const extractDir = `${downloadPath}-extracted`;
      await runTool("unzip", ["-o", downloadPath, "-d", extractDir]);
      const found = await findRasterFile(extractDir);
      if (!found) throw new Error("No .nc/.tif/.tiff file found inside the downloaded .zip archive");
      gridPath = found;
    }

    await markGridImportStage(job.id, "validating");
    const info = await runToolCapture("gdalinfo", [gridPath]);
    if (!/^Driver:/m.test(info)) {
      throw new Error("gdalinfo could not identify the downloaded file as a valid raster");
    }
    const rasterSummary = info
      .split("\n")
      .filter((l) => /^(Driver|Size is|Pixel Size|Upper Left|Lower Right)/.test(l))
      .join("\n");

    const checksum = await sha256File(gridPath);
    const sizeBytes = await fileSizeBytes(gridPath);

    const currentLinkPath = path.join(config.gridStorageDir, "current.nc");
    const tmpLinkPath = `${currentLinkPath}.tmp`;
    await rm(tmpLinkPath, { force: true });
    await symlink(gridPath, tmpLinkPath);
    await rename(tmpLinkPath, currentLinkPath); // atomic — GEBCOProvider never sees a half-updated symlink

    await markGridImportCompleted(job.id, { filePath: gridPath, fileSizeBytes: sizeBytes, checksum, rasterSummary });
    logger.info("grid import completed", { jobId: job.id, gridPath, sizeBytes });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error("grid import failed", { jobId: job.id, error: error.message });
    await markGridImportFailed(job.id, "failed", error.message).catch(() => {});
  }
}

/** Claims and processes every PENDING grid import, then exits — cron-driven, same shape as worker:drain. */
async function main() {
  while (true) {
    const job = await claimNextGridImport();
    if (!job) break;
    logger.info("claimed grid import", { jobId: job.id, url: job.url });
    await processImport(job);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("worker:import-grid failed:", err);
    process.exit(1);
  });
