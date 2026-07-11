import { db } from "./client.js";
import type { BathymetryJob, JobStatus } from "../types.js";
import { logger } from "../logger.js";

/**
 * Atomically claims the oldest QUEUED job via the claim_next_bathymetry_job()
 * Postgres function (SELECT ... FOR UPDATE SKIP LOCKED inside one RPC call).
 * This is the ONLY way the worker should ever pick up a job — never a plain
 * SELECT followed by a separate UPDATE, which would race two worker
 * instances onto the same row. Safe to call from any number of concurrent
 * worker processes; each call claims at most one distinct row.
 */
export async function claimNextJob(): Promise<BathymetryJob | null> {
  const { data, error } = await db.rpc("claim_next_bathymetry_job");
  if (error) throw new Error(`claim_next_bathymetry_job failed: ${error.message}`);
  // The function is a SETOF-returning RPC (see the
  // 20260712030000_fix_claim_next_bathymetry_job_null migration for why: a
  // plain composite-returning function can't produce a genuine NULL over
  // PostgREST), so supabase-js hands back an array — [] when the queue is
  // empty, never a nulls-filled row.
  const rows = (data as BathymetryJob[] | null) ?? [];
  return rows[0] ?? null;
}

export async function updateJob(id: string, patch: Partial<BathymetryJob>): Promise<void> {
  const { error } = await db.from("bathymetry_jobs").update(patch).eq("id", id);
  if (error) throw new Error(`update bathymetry_jobs(${id}) failed: ${error.message}`);
}

export async function markStage(id: string, stage: string): Promise<void> {
  await updateJob(id, { current_stage: stage });
}

export async function markUploading(job: BathymetryJob): Promise<void> {
  await updateJob(job.id, { status: "UPLOADING", current_stage: "uploading" });
  await db.from("launch_locations").update({ bathymetry_status: "UPLOADING" }).eq("id", job.launch_site_id);
}

/** Insert one row into the per-stage log history. Never throws — logging must not fail a job. */
export async function logStage(
  jobId: string,
  stage: string,
  message: string,
  level: "info" | "warn" | "error" = "info",
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.from("marine_data_job_logs").insert({ job_id: jobId, stage, level, message, metadata });
  } catch (err) {
    logger.warn("failed to write marine_data_job_logs row (non-fatal)", { jobId, stage, err: String(err) });
  }
}

export interface JobFailureInfo {
  stage: string;
  message: string;
  stack?: string;
}

/** Mark a job FAILED. Deliberately does NOT touch launch_locations tile URLs/enabled flags — a previously-working layer must never disappear because a later regeneration attempt failed. */
export async function markJobFailed(job: BathymetryJob, info: JobFailureInfo, durationMs: number): Promise<void> {
  await updateJob(job.id, {
    status: "FAILED",
    completed_at: new Date().toISOString(),
    current_stage: info.stage,
    error_message: info.message,
    error_stack: info.stack ?? null,
    processing_duration_ms: durationMs,
  });
  await db.from("launch_locations").update({ bathymetry_status: "FAILED" }).eq("id", job.launch_site_id);
  await logStage(job.id, info.stage, info.message, "error", { stack: info.stack });
}

export interface JobCompletionInfo {
  bathymetryTileUrl: string;
  contourTileUrl: string;
  contourBandsTileUrl: string;
  bathymetryChecksum: string;
  contourChecksum: string;
  contourBandsChecksum: string;
  providerName: string;
  providerVersion: string;
  generatorVersion: string;
  workerVersion: string;
  algorithmVersion: string;
  resolutionArcSec: number;
  contourIntervalM: number;
  pmtilesVersion: string;
  skippedUnchanged: boolean;
}

/** Mark a job COMPLETED and mirror the resulting dataset (URLs + full version/checksum snapshot) onto launch_locations. */
export async function markJobCompleted(job: BathymetryJob, info: JobCompletionInfo, durationMs: number): Promise<void> {
  const now = new Date().toISOString();
  await updateJob(job.id, {
    status: "COMPLETED",
    completed_at: now,
    current_stage: "completed",
    bathymetry_tile_url: info.bathymetryTileUrl,
    contour_tile_url: info.contourTileUrl,
    contour_bands_tile_url: info.contourBandsTileUrl,
    bathymetry_checksum: info.bathymetryChecksum,
    contour_checksum: info.contourChecksum,
    contour_bands_checksum: info.contourBandsChecksum,
    provider_version: info.providerVersion,
    generator_version: info.generatorVersion,
    worker_version: info.workerVersion,
    algorithm_version: info.algorithmVersion,
    resolution_arc_sec: info.resolutionArcSec,
    contour_interval_m: info.contourIntervalM,
    pmtiles_version: info.pmtilesVersion,
    processing_duration_ms: durationMs,
    skipped_unchanged: info.skippedUnchanged,
  });

  const launchSitePatch: Record<string, unknown> = {
    bathymetry_status: "COMPLETED",
    bathymetry_last_checked_at: now,
    bathymetry_provider: info.providerName,
    bathymetry_provider_version: info.providerVersion,
    bathymetry_generator_version: info.generatorVersion,
    bathymetry_algorithm_version: info.algorithmVersion,
    bathymetry_resolution_arc_sec: info.resolutionArcSec,
    bathymetry_contour_interval_m: info.contourIntervalM,
    bathymetry_pmtiles_version: info.pmtilesVersion,
    bathymetry_checksum: info.bathymetryChecksum,
    contour_checksum: info.contourChecksum,
    contour_bands_checksum: info.contourBandsChecksum,
  };

  // Only advance "generated_at" and flip on the layer toggles / URLs when the
  // output actually changed — an unchanged-by-checksum run just confirms the
  // existing dataset is still current (see markJobSkippedUnchanged below for
  // the case where we never even got this far because checksums matched
  // before upload).
  if (!info.skippedUnchanged) {
    launchSitePatch.bathymetry_generated_at = now;
    launchSitePatch.bathymetry_last_updated_at = now;
    launchSitePatch.bathymetry_tile_url = info.bathymetryTileUrl;
    launchSitePatch.contour_tile_url = info.contourTileUrl;
    launchSitePatch.contour_bands_tile_url = info.contourBandsTileUrl;
    launchSitePatch.bathymetry_enabled = true;
    launchSitePatch.contours_enabled = true;
    launchSitePatch.contour_bands_enabled = true;
  }

  const { error } = await db.from("launch_locations").update(launchSitePatch).eq("id", job.launch_site_id);
  if (error) throw new Error(`update launch_locations(${job.launch_site_id}) failed: ${error.message}`);

  await logStage(job.id, "completed", info.skippedUnchanged
    ? "Output identical to live dataset by checksum — skipped upload/overwrite"
    : "Bathymetry generation completed and published");
}

/** Requeue a FAILED job — used by `worker:retry`. Does not touch existing (still-live) launch_locations tile URLs. */
export async function requeueJob(jobId: string): Promise<BathymetryJob> {
  const { data: existing, error: fetchError } = await db.from("bathymetry_jobs").select("*").eq("id", jobId).single();
  if (fetchError || !existing) throw new Error(`Job ${jobId} not found`);
  const job = existing as BathymetryJob;
  if (job.status !== "FAILED") {
    throw new Error(`Job ${jobId} is ${job.status}, not FAILED — only failed jobs can be retried`);
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await db
    .from("bathymetry_jobs")
    .update({
      status: "QUEUED",
      requested_at: now,
      started_at: null,
      completed_at: null,
      error_message: null,
      error_stack: null,
      current_stage: "requeued",
      retry_count: job.retry_count + 1,
    })
    .eq("id", jobId)
    .select("*")
    .single();
  if (error || !updated) throw new Error(`Failed to requeue job ${jobId}: ${error?.message}`);

  await db.from("launch_locations").update({ bathymetry_status: "QUEUED" }).eq("id", job.launch_site_id);
  await logStage(jobId, "requeued", `Retried by admin (attempt ${job.retry_count + 1})`);
  return updated as BathymetryJob;
}

/** True if this launch site already has a job in flight (QUEUED/GENERATING/UPLOADING) — used to avoid duplicate active jobs from the backfill/queue CLI. */
export async function hasActiveJobForSite(launchSiteId: string): Promise<boolean> {
  const { count, error } = await db
    .from("bathymetry_jobs")
    .select("id", { count: "exact", head: true })
    .eq("launch_site_id", launchSiteId)
    .in("status", ["QUEUED", "GENERATING", "UPLOADING"]);
  if (error) throw new Error(`hasActiveJobForSite(${launchSiteId}) failed: ${error.message}`);
  return (count ?? 0) > 0;
}

export interface EnqueueOptions {
  launchSiteId: string;
  coverage: { offshoreKm: number; leftKm: number; rightKm: number; inlandKm: number };
  requestedBy?: string | null;
}

/** Insert a new QUEUED job — the same operation the admin UI's "Generate Bathymetry" button performs, exposed here for the `worker:queue` backfill CLI. */
export async function enqueueJob(opts: EnqueueOptions): Promise<BathymetryJob> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("bathymetry_jobs")
    .insert({
      launch_site_id: opts.launchSiteId,
      status: "QUEUED" as JobStatus,
      coverage_offshore_km: opts.coverage.offshoreKm,
      coverage_left_km: opts.coverage.leftKm,
      coverage_right_km: opts.coverage.rightKm,
      coverage_inland_km: opts.coverage.inlandKm,
      requested_by: opts.requestedBy ?? null,
      requested_at: now,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`Failed to enqueue job for site ${opts.launchSiteId}: ${error?.message}`);

  await db
    .from("launch_locations")
    .update({ bathymetry_status: "QUEUED", bathymetry_generation_requested_at: now })
    .eq("id", opts.launchSiteId);

  return data as BathymetryJob;
}
