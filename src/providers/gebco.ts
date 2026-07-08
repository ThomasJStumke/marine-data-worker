import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { runTool } from "../pipeline/exec.js";
import { sha256File, fileSizeBytes } from "../pipeline/checksum.js";
import type { BathymetryProvider, SourceFetchRequest, SourceFetchResult } from "../types.js";

/**
 * GEBCO source provider. This is the FIRST implementation of
 * BathymetryProvider, not a special-cased default — the rest of the worker
 * (cache, clip, hillshade, contours, pmtiles, upload) only ever talks to the
 * `BathymetryProvider` interface and never imports this file directly except
 * through the registry (see registry.ts). Swapping in NOAA/EMODnet/a local
 * hydrographic office/a commercial provider means adding one more file like
 * this one, not touching pipeline code.
 *
 * Two acquisition modes, picked at construction time by whether
 * GEBCO_LOCAL_GRID_PATH is set:
 *
 * - Local (preferred): clip the requested bbox straight out of a
 *   pre-downloaded global GEBCO grid file (NetCDF or GeoTIFF — see
 *   docs/marine-data-worker.md for where to get one) with `gdalwarp`. No
 *   network call per job at all.
 * - Remote (legacy fallback): call GEBCO's grid-extract WMS/WCS-style
 *   endpoint. As of this writing that endpoint (GEBCO_API_BASE_URL) has been
 *   retired/moved — even a bare GetCapabilities 404s — so this path only
 *   exists in case GEBCO stands up an equivalent service again; the base URL
 *   and grid version stay env-configurable either way.
 */
export class GEBCOProvider implements BathymetryProvider {
  readonly name = "gebco";
  readonly version: string;

  constructor(
    private readonly apiBaseUrl = config.gebcoApiBaseUrl,
    gridVersion = config.gebcoGridVersion,
    private readonly localGridPath = config.gebcoLocalGridPath,
  ) {
    this.version = gridVersion;
  }

  async fetchSource(req: SourceFetchRequest, destDir: string): Promise<SourceFetchResult> {
    await mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, `gebco-${Date.now()}.tif`);

    if (this.localGridPath) {
      await this.clipFromLocalGrid(req, destPath);
    } else {
      await this.downloadFromWebService(req, destPath);
    }

    const checksum = await sha256File(destPath);
    const sizeBytes = await fileSizeBytes(destPath);

    return {
      provider: this.name,
      providerVersion: this.version,
      resolutionArcSec: req.resolutionArcSec,
      filePath: destPath,
      bbox: req.bbox,
      checksum,
      sizeBytes,
    };
  }

  /** Extracts the requested bbox directly from the local global grid — no network involved. */
  private async clipFromLocalGrid(req: SourceFetchRequest, destPath: string): Promise<void> {
    const { west, south, east, north } = req.bbox;
    const res = req.resolutionArcSec / 3600;
    await runTool("gdalwarp", [
      "-of", "GTiff",
      "-te", String(west), String(south), String(east), String(north),
      "-te_srs", "EPSG:4326",
      "-t_srs", "EPSG:4326",
      "-tr", String(res), String(res),
      "-overwrite",
      this.localGridPath,
      destPath,
    ]);
  }

  private async downloadFromWebService(req: SourceFetchRequest, destPath: string): Promise<void> {
    const url = this.buildRequestUrl(req);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`GEBCO source fetch failed (${res.status} ${res.statusText}) for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(destPath, buf);
  }

  /** Builds the GEBCO grid-extract request URL for a bounding box. Isolated so the exact query contract can change (or be unit-tested) without touching fetchSource's control flow. */
  private buildRequestUrl(req: SourceFetchRequest): string {
    const { west, south, east, north } = req.bbox;
    const params = new URLSearchParams({
      request: "GetCoverage",
      version: "1.0.0",
      service: "WCS",
      coverage: this.version,
      format: "GeoTIFF",
      bbox: `${west},${south},${east},${north}`,
      crs: "EPSG:4326",
      resx: String(req.resolutionArcSec / 3600),
      resy: String(req.resolutionArcSec / 3600),
    });
    return `${this.apiBaseUrl}?${params.toString()}`;
  }
}
