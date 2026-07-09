import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { fetchLaunchSite } from "../db/launchSites.js";
import { logStage, markStage, markUploading, markJobCompleted, markJobFailed } from "../db/jobs.js";
import { buildCoveragePolygon, padBBox } from "../geo/polygon.js";
import { resolveContourGridCell } from "../geo/contourGrid.js";
import { getProvider } from "../providers/registry.js";
import { fetchSourceWithCache } from "../cache/sourceCache.js";
import { fetchOrTraceRegionalContours } from "../cache/contourCache.js";
import { clipToPolygon } from "../pipeline/clip.js";
import { generateDepthShading, ALGORITHM_VERSION_HILLSHADE } from "../pipeline/hillshade.js";
import { clipContoursToPolygon, ALGORITHM_VERSION_CONTOURS } from "../pipeline/contours.js";
import { rasterToPmtiles, contoursToPmtiles, PMTILES_BUILD_VERSION } from "../pipeline/pmtiles.js";
import { validatePmtiles } from "../pipeline/validate.js";
import { sha256File } from "../pipeline/checksum.js";
import { bathymetryKey, contourKey, uploadIfChanged } from "../r2/uploader.js";
import type { BathymetryJob } from "../types.js";

/**
 * Runs the full pipeline for one already-claimed (status=GENERATING) job:
 *
 *   read launch site -> build coverage polygon -> resolve its fixed contour
 *   grid cell -> acquire provider source for the padded CELL (cache-first)
 *   -> clip to the site's own polygon -> depth shading -> fetch-or-trace
 *   contours for the whole CELL (cache-first, shared across every site in
 *   it) -> vector-clip that regional trace to the site's own polygon ->
 *   PMTiles -> validate -> checksum -> compare against live checksums ->
 *   upload only what changed -> update launch_locations + bathymetry_jobs
 *   -> COMPLETED
 *
 * Contours are traced once per grid cell (see geo/contourGrid.ts,
 * cache/contourCache.ts) rather than once per site — this is what makes
 * adjacent sites sharing a cell produce bit-identical contour vertices in
 * their overlap area, instead of each site's independently-rotated cutline
 * producing mismatched lines at its own edge. Hillshade/bathymetry stay
 * per-site, unaffected by this.
 *
 * On any failure, the job is marked FAILED and the launch site's EXISTING
 * tile URLs/enabled flags are left completely untouched (see
 * db/jobs.ts#markJobFailed) — a working layer must never disappear because a
 * later regeneration attempt failed.
 */
export type JobOutcome = "COMPLETED" | "SKIPPED_UNCHANGED" | "FAILED";

export async function processJob(job: BathymetryJob): Promise<JobOutcome> {
  const startedAtMs = job.started_at ? new Date(job.started_at).getTime() : Date.now();
  let stage = "starting";

  const onStage = async (nextStage: string, message: string) => {
    stage = nextStage;
    logger.info(message, { jobId: job.id, stage: nextStage });
    await markStage(job.id, nextStage);
    await logStage(job.id, nextStage, message);
  };

  const workDir = await mkdtemp(path.join(tmpdir(), "marine-data-"));

  try {
    const site = await fetchLaunchSite(job.launch_site_id);

    await onStage("building_polygon", `Building coverage polygon for ${site.name}`);
    const polygon = buildCoveragePolygon(site.latitude, site.longitude, site.beach_facing_deg, {
      offshoreKm: job.coverage_offshore_km,
      leftKm: job.coverage_left_km,
      rightKm: job.coverage_right_km,
      inlandKm: job.coverage_inland_km,
    });

    const provider = getProvider(job.source_provider || config.bathymetryProvider);
    const resolutionArcSec = config.sourceResolutionArcSec;

    // Contours are traced once per fixed grid cell, not per site (see
    // geo/contourGrid.ts) — so the raster fetched here is padded out to
    // cover that whole cell (comfortably wider than any single site's own
    // polygon), and this ONE raster serves both the per-site hillshade clip
    // below AND the shared regional contour trace, with no duplicate fetch.
    const cell = resolveContourGridCell(site.latitude, site.longitude, config.contourGridCellSizeDeg);
    let widePaddedBBox = padBBox(cell, config.contourRegionPaddingKm, site.latitude);
    const fullyContainsPolygon = (b: typeof widePaddedBBox) =>
      polygon.bbox.west >= b.west && polygon.bbox.east <= b.east &&
      polygon.bbox.south >= b.south && polygon.bbox.north <= b.north;
    if (!fullyContainsPolygon(widePaddedBBox)) {
      // Rare (a site sitting close enough to a ~1000km grid line, with a
      // wide-enough offshore facing toward that line, that its own polygon
      // pokes past the padded cell) but geometrically possible — widen
      // defensively rather than silently producing a truncated regional
      // trace. One doubling of the pad comfortably covers any realistic
      // shortfall since the site's own polygon (~80km) is far smaller than
      // the pad itself (50km default).
      logger.warn("site polygon not fully contained by its padded grid cell — widening padding for this job", {
        jobId: job.id,
        siteId: site.id,
      });
      widePaddedBBox = padBBox(widePaddedBBox, config.contourRegionPaddingKm, site.latitude);
    }

    const { filePath: sourcePath, fromCache, sourceCacheId } = await fetchSourceWithCache(
      provider,
      widePaddedBBox,
      resolutionArcSec,
      site.latitude,
      onStage,
    );
    logger.info(fromCache ? "source served from cache" : "source freshly downloaded", { jobId: job.id, provider: provider.name });

    await onStage("clipping", "Clipping source to launch site coverage polygon");
    const clippedPath = await clipToPolygon(sourcePath, polygon, workDir);

    await onStage("hillshade", "Generating depth-shading raster");
    const shadedPath = await generateDepthShading(clippedPath, workDir);

    await onStage("contours", `Generating ${config.contourIntervalM}m contours`);
    const { filePath: regionalContoursPath } = await fetchOrTraceRegionalContours(
      provider,
      resolutionArcSec,
      config.contourIntervalM,
      cell,
      widePaddedBBox,
      sourcePath,
      sourceCacheId,
      onStage,
    );
    const contoursGeoJsonPath = await clipContoursToPolygon(regionalContoursPath, polygon, workDir);

    await onStage("pmtiles", "Converting outputs to PMTiles");
    const bathymetryPmtilesPath = await rasterToPmtiles(shadedPath, workDir);
    const contourPmtilesPath = await contoursToPmtiles(contoursGeoJsonPath, workDir);

    await onStage("validating", "Validating generated PMTiles archives");
    await validatePmtiles(bathymetryPmtilesPath);
    await validatePmtiles(contourPmtilesPath);

    const bathymetryChecksum = await sha256File(bathymetryPmtilesPath);
    const contourChecksum = await sha256File(contourPmtilesPath);

    const bathymetryUnchanged = site.bathymetry_checksum === bathymetryChecksum;
    const contourUnchanged = site.contour_checksum === contourChecksum;

    let bathymetryUrl: string;
    let contourUrl: string;

    if (bathymetryUnchanged && contourUnchanged) {
      // Nothing actually changed vs. what's already live — this is the
      // checksum-comparison short-circuit: skip both uploads entirely and
      // just record that we checked.
      await onStage("checksum_unchanged", "Generated output identical to live dataset by checksum — skipping upload");
      bathymetryUrl = site.bathymetry_tile_url!;
      contourUrl = site.contour_tile_url!;
    } else {
      await markUploading(job);
      await onStage("uploading", "Uploading changed PMTiles to Cloudflare R2");

      const bathymetryResult = bathymetryUnchanged
        ? { uploaded: false, url: site.bathymetry_tile_url!, key: bathymetryKey(site.country, site.name) }
        : await uploadIfChanged(bathymetryKey(site.country, site.name), bathymetryPmtilesPath, bathymetryChecksum);
      const contourResult = contourUnchanged
        ? { uploaded: false, url: site.contour_tile_url!, key: contourKey(site.country, site.name) }
        : await uploadIfChanged(contourKey(site.country, site.name), contourPmtilesPath, contourChecksum);

      bathymetryUrl = bathymetryResult.url;
      contourUrl = contourResult.url;
    }

    const durationMs = Date.now() - startedAtMs;
    await markJobCompleted(
      job,
      {
        bathymetryTileUrl: bathymetryUrl,
        contourTileUrl: contourUrl,
        bathymetryChecksum,
        contourChecksum,
        providerName: provider.name,
        providerVersion: provider.version,
        generatorVersion: config.generatorVersion,
        workerVersion: config.workerVersion,
        algorithmVersion: `${ALGORITHM_VERSION_HILLSHADE}+${ALGORITHM_VERSION_CONTOURS}`,
        resolutionArcSec,
        contourIntervalM: config.contourIntervalM,
        pmtilesVersion: PMTILES_BUILD_VERSION,
        skippedUnchanged: bathymetryUnchanged && contourUnchanged,
      },
      durationMs,
    );
    logger.info("job completed", { jobId: job.id, durationMs, skippedUnchanged: bathymetryUnchanged && contourUnchanged });
    return bathymetryUnchanged && contourUnchanged ? "SKIPPED_UNCHANGED" : "COMPLETED";
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const durationMs = Date.now() - startedAtMs;
    logger.error("job failed", { jobId: job.id, stage, error: error.message });
    await markJobFailed(job, { stage, message: error.message, stack: error.stack }, durationMs);
    return "FAILED";
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
