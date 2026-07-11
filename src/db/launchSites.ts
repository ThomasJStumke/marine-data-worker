import { db } from "./client.js";
import type { LaunchSite } from "../types.js";

export async function fetchLaunchSite(id: string): Promise<LaunchSite> {
  const { data, error } = await db
    .from("launch_locations")
    .select(
      "id, name, country, latitude, longitude, beach_facing_deg, bathymetry_tile_url, contour_tile_url, contour_bands_tile_url, bathymetry_checksum, contour_checksum, contour_bands_checksum, bathymetry_coverage_offshore_km, bathymetry_coverage_left_km, bathymetry_coverage_right_km, bathymetry_coverage_inland_km",
    )
    .eq("id", id)
    .single();
  if (error || !data) throw new Error(`Launch site ${id} not found: ${error?.message}`);
  return data as LaunchSite;
}

export interface QueueableSiteFilter {
  country?: string;
  launchSiteName?: string;
}

/** Launch sites with bathymetry_status = NOT_GENERATED (never generated / never attempted) — candidates for the `worker:queue` backfill CLI. */
export async function listNeverGeneratedSites(filter: QueueableSiteFilter = {}): Promise<LaunchSite[]> {
  let query = db
    .from("launch_locations")
    .select(
      "id, name, country, latitude, longitude, beach_facing_deg, bathymetry_tile_url, contour_tile_url, contour_bands_tile_url, bathymetry_checksum, contour_checksum, contour_bands_checksum, bathymetry_coverage_offshore_km, bathymetry_coverage_left_km, bathymetry_coverage_right_km, bathymetry_coverage_inland_km",
    )
    .eq("bathymetry_status", "NOT_GENERATED")
    .order("name");

  if (filter.country) query = query.ilike("country", filter.country);
  if (filter.launchSiteName) query = query.ilike("name", `%${filter.launchSiteName}%`);

  const { data, error } = await query;
  if (error) throw new Error(`listNeverGeneratedSites failed: ${error.message}`);
  return (data ?? []) as LaunchSite[];
}

/** Launch sites with bathymetry_status = COMPLETED — candidates for re-generation (e.g. after a coverage/algorithm change) via the `worker:requeue-generated` CLI. Excludes NOT_GENERATED/QUEUED/GENERATING/UPLOADING/FAILED sites, which have their own dedicated backfill/retry paths. */
export async function listGeneratedSites(filter: QueueableSiteFilter = {}): Promise<LaunchSite[]> {
  let query = db
    .from("launch_locations")
    .select(
      "id, name, country, latitude, longitude, beach_facing_deg, bathymetry_tile_url, contour_tile_url, contour_bands_tile_url, bathymetry_checksum, contour_checksum, contour_bands_checksum, bathymetry_coverage_offshore_km, bathymetry_coverage_left_km, bathymetry_coverage_right_km, bathymetry_coverage_inland_km",
    )
    .eq("bathymetry_status", "COMPLETED")
    .order("name");

  if (filter.country) query = query.ilike("country", filter.country);
  if (filter.launchSiteName) query = query.ilike("name", `%${filter.launchSiteName}%`);

  const { data, error } = await query;
  if (error) throw new Error(`listGeneratedSites failed: ${error.message}`);
  return (data ?? []) as LaunchSite[];
}
