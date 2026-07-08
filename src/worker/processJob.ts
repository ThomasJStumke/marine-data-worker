import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { fetchLaunchSite } from "../db/launchSites.js";
import { logStage, markStage, markUploading, markJobCompleted, markJobFailed } from "../db/jobs.js";
import { buildCoveragePolygon } from "../geo/polygon.js";
import { getProvider } from "../providers/registry.js";
import { fetchSourceWithCache } from "../cache/sourceCache.js";
import { clipToPolygon } from "../pipeline/clip.js";
import { generateDepthShading, ALGORITHM_VERSION_HILLSHADE } from "../pipeline/hillshade.js";
import { generateContours, ALGORITHM_VERSION_CONTOURS } from "../pipeline/contours.js";
import { rasterToPmtiles, contoursToPmtiles, PMTILES_BUILD_VERSION } from "../pipeline/pmtiles.js";
import { validatePmtiles } from "../pipeline/validate.js";
import { sha256File } from "../pipeline/checksum.js";
import { bathymetryKey, contourKey, uploadIfChanged } from "../r2/uploader.js";
import type { BathymetryJob } from "../types.js";

/**
 * Runs the full pipeline for one already-claimed (status=GENERATING) job:
 *
 *   read launch site -> build coverage polygon -> acquire provider source
 *   (cache-first) -> clip to polygon -> depth shading -> contours -> PMTiles
 *   -> validate -> checksum -> compare against live checksums -> upload only
 *   what changed -> update launch_locations + bathymetry_jobs -> COMPLETED
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

    const { filePath: sourcePath, fromCache } = await fetchSourceWithCache(
      provider,
      polygon.bbox,
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
    const contoursGeoJsonPath = await generateContours(clippedPath, workDir, config.contourIntervalM);

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
