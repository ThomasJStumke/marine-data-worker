import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be an integer, got "${v}"`);
  return n;
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

// Worker package version — stamped onto every job as `worker_version` so a
// dataset's provenance can always be traced back to the exact worker build
// that produced it. Read from package.json rather than duplicated as a
// literal so it never drifts from the actual released version.
function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf-8")) as { version: string };
  return pkg.version;
}

export const config = {
  supabaseUrl: requireEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),

  r2AccountId: requireEnv("R2_ACCOUNT_ID"),
  r2AccessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
  r2BucketPublic: requireEnv("R2_BUCKET_PUBLIC"),
  r2PublicBaseUrl: requireEnv("R2_PUBLIC_BASE_URL").replace(/\/$/, ""),

  bathymetryProvider: process.env.BATHYMETRY_PROVIDER || "gebco",
  gebcoApiBaseUrl: process.env.GEBCO_API_BASE_URL || "https://www.gebco.net/data_and_products/gebco_web_services/web_map_service/mapserv",
  gebcoGridVersion: process.env.GEBCO_GRID_VERSION || "gebco_2024",
  // Path to a locally-downloaded global GEBCO grid (NetCDF or GeoTIFF, e.g.
  // GEBCO_2024_sub_ice_topo.nc from https://dap.ceda.ac.uk/bodc/gebco/global/).
  // When set, GEBCOProvider clips straight out of this file with gdalwarp
  // instead of calling GEBCO's web service — see docs/marine-data-worker.md.
  // GEBCO's old WCS mapserv endpoint (the GEBCO_API_BASE_URL default above)
  // has been retired/moved (confirmed 404, including on GetCapabilities) in
  // favor of the download app + CEDA archive, so this is the only reliable
  // way to fetch source data as of this writing.
  // Directory (inside the container) that admin-submitted grid imports
  // (worker:import-grid) download into and symlink from. GEBCO_LOCAL_GRID_PATH
  // defaults to the stable `current.nc` symlink inside it, which importGrid.ts
  // atomically re-points on every successful import — so a new grid takes
  // effect on the very next bathymetry job with no restart required.
  gridStorageDir: process.env.GRID_STORAGE_DIR || "/var/lib/marine-data-worker/gebco",
  gebcoLocalGridPath: process.env.GEBCO_LOCAL_GRID_PATH || `${process.env.GRID_STORAGE_DIR || "/var/lib/marine-data-worker/gebco"}/current.nc`,

  cacheDirectory: process.env.CACHE_DIRECTORY || "./.cache",
  workDirectory: process.env.WORK_DIRECTORY || "./.work",

  // Cache retention (worker:cleanup-cache). 0 disables that criterion —
  // both can be enabled together, in which case an entry is evicted as
  // soon as either limit is hit. See src/cli/cleanupCache.ts.
  cacheRetentionDays: envInt("CACHE_RETENTION_DAYS", 90),
  cacheMaxSizeGb: envInt("CACHE_MAX_SIZE_GB", 150),

  maxConcurrentJobs: envInt("MAX_CONCURRENT_JOBS", 2),
  pollIntervalMs: envInt("POLL_INTERVAL_MS", 10_000),
  // How often `worker:drain` is expected to be invoked (e.g. by cron) —
  // used only to stamp `next_run_expected_at` on its marine_data_worker_runs
  // row for the admin UI. Keep in sync with the actual cron schedule.
  workerRunIntervalMinutes: envInt("WORKER_RUN_INTERVAL_MINUTES", 60),

  contourIntervalM: envFloat("CONTOUR_INTERVAL_M", 10),
  // Finer than contourIntervalM (lines) since these polygons get remapped to
  // a user's own custom depth-color ranges client-side (see
  // pipeline/contour-bands.ts) — a coarser band would force chunkier custom
  // shading than the user actually configured.
  contourBandsIntervalM: envFloat("CONTOUR_BANDS_INTERVAL_M", 5),
  minZoom: envInt("MIN_ZOOM", 8),
  maxZoom: envInt("MAX_ZOOM", 14),

  sourceDownloadPaddingKm: envFloat("SOURCE_DOWNLOAD_PADDING_KM", 10),
  sourceResolutionArcSec: envFloat("SOURCE_RESOLUTION_ARC_SEC", 15),
  sourceCacheMinOverlapRatio: envFloat("SOURCE_CACHE_MIN_OVERLAP_RATIO", 0.9),

  // Contours are traced once per fixed global grid cell (not per launch
  // site) so adjacent sites sharing a cell get bit-identical vertices —
  // see src/geo/contourGrid.ts and src/cache/contourCache.ts.
  contourGridCellSizeDeg: envFloat("CONTOUR_GRID_CELL_SIZE_DEG", 9), // ~1000km at the equator, narrower (never wider) toward the poles
  contourRegionPaddingKm: envFloat("CONTOUR_REGION_PADDING_KM", 50), // pad beyond the raw cell so a site near a cell edge is still fully contained in the traced extent

  // Marine Structure Platform — OSM/OpenSeaMap importer (Phase 1). Public
  // API, no credentials needed, so these are plain optional envs with sane
  // defaults rather than requireEnv().
  overpassApiUrl: process.env.OVERPASS_API_URL || "https://overpass-api.de/api/interpreter",
  overpassTimeoutSec: envInt("OVERPASS_TIMEOUT_SEC", 60),
  overpassMaxRetries: envInt("OVERPASS_MAX_RETRIES", 4),
  overpassCacheTtlMs: envInt("OVERPASS_CACHE_TTL_MS", 24 * 60 * 60 * 1000),
  // Pause between cells in a `--global` sweep (src/geo/worldGrid.ts) — the
  // public Overpass instance has no per-account quota, just a fair-use
  // expectation of not hammering it; a few hundred sequential cell queries
  // needs an explicit pace, unlike a single launch-site import.
  overpassRequestDelayMs: envInt("OVERPASS_REQUEST_DELAY_MS", 3000),

  logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",

  workerVersion: readPackageVersion(),
  // Bump when the clip/hillshade/contour parameter set changes materially —
  // independent of the npm package version, which can bump for unrelated
  // (e.g. CLI/logging) changes.
  generatorVersion: "gen-1.0",
} as const;
