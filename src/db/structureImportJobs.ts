import { db } from "./client.js";
import type { BBox } from "../types.js";
import type { StructureLayerKey } from "../structures/types.js";

export interface CreateImportJobOptions {
  provider: string;
  scope: "launch_site" | "country" | "global";
  launchSiteId?: string;
  country?: string;
  layerKeys: StructureLayerKey[];
  bbox: BBox;
}

export async function createImportJob(opts: CreateImportJobOptions): Promise<string> {
  const { data, error } = await db
    .from("marine_structure_import_jobs")
    .insert({
      provider: opts.provider,
      scope: opts.scope,
      launch_site_id: opts.launchSiteId ?? null,
      country: opts.country ?? null,
      layer_keys: opts.layerKeys,
      status: "RUNNING",
      started_at: new Date().toISOString(),
      bbox_west: opts.bbox.west,
      bbox_south: opts.bbox.south,
      bbox_east: opts.bbox.east,
      bbox_north: opts.bbox.north,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`createImportJob failed: ${error?.message}`);
  return data.id as string;
}

/**
 * Looks up an already-COMPLETED scope='global' job for the exact bbox — the
 * world grid (src/geo/worldGrid.ts) is static, so an exact match is a safe
 * "has this cell already been imported" check. Used by `--global` to resume
 * a sweep after an interruption without re-querying cells it already has.
 */
export async function findCompletedGlobalJobForBBox(bbox: BBox): Promise<boolean> {
  const { data, error } = await db
    .from("marine_structure_import_jobs")
    .select("id")
    .eq("scope", "global")
    .eq("status", "COMPLETED")
    .eq("bbox_west", bbox.west)
    .eq("bbox_south", bbox.south)
    .eq("bbox_east", bbox.east)
    .eq("bbox_north", bbox.north)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findCompletedGlobalJobForBBox failed: ${error.message}`);
  return data !== null;
}

export interface CompleteImportJobInfo {
  providerVersion: string;
  featuresFound: number;
  featuresInserted: number;
  featuresUpdated: number;
  featuresUnchanged: number;
  durationMs: number;
}

export async function completeImportJob(jobId: string, info: CompleteImportJobInfo): Promise<void> {
  const { error } = await db
    .from("marine_structure_import_jobs")
    .update({
      status: "COMPLETED",
      completed_at: new Date().toISOString(),
      provider_version: info.providerVersion,
      features_found: info.featuresFound,
      features_inserted: info.featuresInserted,
      features_updated: info.featuresUpdated,
      features_unchanged: info.featuresUnchanged,
      duration_ms: info.durationMs,
    })
    .eq("id", jobId);
  if (error) throw new Error(`completeImportJob(${jobId}) failed: ${error.message}`);
}

export async function failImportJob(jobId: string, message: string, stack: string | undefined, durationMs: number): Promise<void> {
  const { error } = await db
    .from("marine_structure_import_jobs")
    .update({
      status: "FAILED",
      completed_at: new Date().toISOString(),
      error_message: message,
      error_stack: stack ?? null,
      duration_ms: durationMs,
    })
    .eq("id", jobId);
  if (error) throw new Error(`failImportJob(${jobId}) failed: ${error.message}`);
}
