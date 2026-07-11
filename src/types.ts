export type JobStatus = "QUEUED" | "GENERATING" | "UPLOADING" | "COMPLETED" | "FAILED";

export interface BathymetryJob {
  id: string;
  launch_site_id: string;
  status: JobStatus;
  source_provider: string | null;
  coverage_offshore_km: number;
  coverage_left_km: number;
  coverage_right_km: number;
  coverage_inland_km: number;
  bathymetry_tile_url: string | null;
  contour_tile_url: string | null;
  contour_bands_tile_url: string | null;
  error_message: string | null;
  error_stack: string | null;
  current_stage: string | null;
  retry_count: number;
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  bathymetry_checksum: string | null;
  contour_checksum: string | null;
  contour_bands_checksum: string | null;
  processing_duration_ms: number | null;
  provider_version: string | null;
  generator_version: string | null;
  worker_version: string | null;
  algorithm_version: string | null;
  resolution_arc_sec: number | null;
  contour_interval_m: number | null;
  pmtiles_version: string | null;
  skipped_unchanged: boolean;
}

export interface LaunchSite {
  id: string;
  name: string;
  country: string | null;
  latitude: number;
  longitude: number;
  beach_facing_deg: number | null;
  bathymetry_tile_url: string | null;
  contour_tile_url: string | null;
  contour_bands_tile_url: string | null;
  bathymetry_checksum: string | null;
  contour_checksum: string | null;
  contour_bands_checksum: string | null;
  bathymetry_coverage_offshore_km: number;
  bathymetry_coverage_left_km: number;
  bathymetry_coverage_right_km: number;
  bathymetry_coverage_inland_km: number;
}

/** Geographic bounding box, degrees, WGS84. */
export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** A single ring polygon (closed — first point === last point), [lng, lat] pairs. */
export type PolygonRing = [number, number][];

export interface CoveragePolygon {
  ring: PolygonRing;
  bbox: BBox;
}

export interface SourceFetchRequest {
  bbox: BBox;
  resolutionArcSec: number;
}

export interface SourceFetchResult {
  provider: string;
  providerVersion: string;
  resolutionArcSec: number;
  filePath: string;
  bbox: BBox;
  checksum: string;
  sizeBytes: number;
}

export interface BathymetryProvider {
  readonly name: string;
  /** Current data release/version reported by the provider, e.g. "gebco_2024". */
  readonly version: string;
  fetchSource(req: SourceFetchRequest, destDir: string): Promise<SourceFetchResult>;
}

export type GridImportStatus = "PENDING" | "DOWNLOADING" | "FAILED" | "COMPLETED";

export interface GridImportJob {
  id: string;
  url: string;
  status: GridImportStatus;
  current_stage: string | null;
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  file_path: string | null;
  file_size_bytes: number | null;
  checksum: string | null;
  raster_summary: string | null;
  error_message: string | null;
}

export interface PipelineOutput {
  bathymetryPmtilesPath: string;
  contourPmtilesPath: string;
  bathymetryChecksum: string;
  contourChecksum: string;
  algorithmVersion: string;
  pmtilesVersion: string;
}
