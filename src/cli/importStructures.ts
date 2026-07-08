import { parseFlags } from "./args.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { fetchLaunchSite } from "../db/launchSites.js";
import { buildCoveragePolygon, padBBox } from "../geo/polygon.js";
import { buildWorldGrid } from "../geo/worldGrid.js";
import { importFromOsmOverpass } from "../providers/structures/osmOverpass.js";
import { storeStructureFeatures } from "../db/structureFeatures.js";
import {
  createImportJob,
  completeImportJob,
  failImportJob,
  findCompletedGlobalJobForBBox,
} from "../db/structureImportJobs.js";
import { OSM_TAG_RULES } from "../structures/osmTags.js";
import type { BBox } from "../types.js";

// Same padding rationale as the bathymetry source cache: nearby launch sites
// (Cape Vidal / St Lucia / Mapelane / Sodwana) get overlapping structure
// queries, so padding the bbox a little makes a future overlapping import
// more likely to be answerable from the Overpass cache without a live call.
const STRUCTURE_QUERY_PADDING_KM = 5;

const USAGE =
  "Usage: npm run structures:import -- --launch-site <launch_site_id>\n" +
  "   or: npm run structures:import -- --bbox <west,south,east,north>\n" +
  "   or: npm run structures:import -- --global [--dry-run]";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseBBoxFlag(value: string): BBox {
  const parts = value.split(",").map((s) => Number.parseFloat(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`--bbox must be "west,south,east,north", got "${value}"`);
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  return { west, south, east, north };
}

/** Runs the full import→store→job-tracking pipeline for one bbox — shared by the launch-site, manual-bbox, and global-grid paths. */
async function importBBox(
  scope: "launch_site" | "country" | "global",
  bbox: BBox,
  extra: { launchSiteId?: string; country?: string } = {},
): Promise<void> {
  const layerKeys = [...new Set(OSM_TAG_RULES.map((r) => r.layerKey))];
  const jobId = await createImportJob({ provider: "osm", scope, layerKeys, bbox, ...extra });
  const startedAt = Date.now();

  try {
    const { providerVersion, features, rawElementCount } = await importFromOsmOverpass(bbox);
    logger.info("Overpass returned elements", { rawElementCount, matchedFeatures: features.length, providerVersion });

    const outcome = await storeStructureFeatures(features);
    await completeImportJob(jobId, { ...outcome, durationMs: Date.now() - startedAt });

    logger.info("import complete", { jobId, ...outcome });
  } catch (err) {
    const e = err as Error;
    await failImportJob(jobId, e.message, e.stack, Date.now() - startedAt);
    throw err;
  }
}

async function runGlobal(dryRun: boolean): Promise<void> {
  const cells = buildWorldGrid();
  if (dryRun) {
    logger.info("dry run — world grid cells", { cellCount: cells.length });
    for (const cell of cells) logger.info("cell", { ...cell });
    return;
  }

  logger.info("starting global structures sweep", { cellCount: cells.length, delayMs: config.overpassRequestDelayMs });
  let skipped = 0;
  let done = 0;
  let failed = 0;

  for (const [i, bbox] of cells.entries()) {
    if (await findCompletedGlobalJobForBBox(bbox)) {
      skipped++;
      continue;
    }

    logger.info("importing global cell", { index: i + 1, of: cells.length, bbox });
    try {
      await importBBox("global", bbox);
      done++;
    } catch (err) {
      // One bad cell (Overpass 5xx after retries, etc.) shouldn't abort the
      // whole sweep — its job row is left FAILED for later inspection/retry,
      // and the sweep moves on to the next cell.
      failed++;
      logger.error("cell import failed, continuing sweep", { bbox, err: String(err) });
    }

    await sleep(config.overpassRequestDelayMs);
  }

  logger.info("global sweep complete", { total: cells.length, done, skipped, failed });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.global) {
    await runGlobal(flags["dry-run"] === true);
    return;
  }

  if (typeof flags.bbox === "string") {
    await importBBox("global", parseBBoxFlag(flags.bbox));
    return;
  }

  const launchSiteId = flags["launch-site"];
  if (typeof launchSiteId !== "string") {
    throw new Error(USAGE);
  }

  const site = await fetchLaunchSite(launchSiteId);
  logger.info("importing marine structures for launch site", { id: site.id, name: site.name });

  const polygon = buildCoveragePolygon(site.latitude, site.longitude, site.beach_facing_deg, {
    offshoreKm: site.bathymetry_coverage_offshore_km,
    leftKm: site.bathymetry_coverage_left_km,
    rightKm: site.bathymetry_coverage_right_km,
    inlandKm: site.bathymetry_coverage_inland_km,
  });
  const bbox = padBBox(polygon.bbox, STRUCTURE_QUERY_PADDING_KM, site.latitude);

  await importBBox("launch_site", bbox, { launchSiteId: site.id });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("structures:import failed:", err);
    process.exit(1);
  });
