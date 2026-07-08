import { parseFlags } from "./args.js";
import { logger } from "../logger.js";
import { fetchLaunchSite } from "../db/launchSites.js";
import { buildCoveragePolygon, padBBox } from "../geo/polygon.js";
import { importFromOsmOverpass } from "../providers/structures/osmOverpass.js";
import { storeStructureFeatures } from "../db/structureFeatures.js";
import { createImportJob, completeImportJob, failImportJob } from "../db/structureImportJobs.js";
import { OSM_TAG_RULES } from "../structures/osmTags.js";

// Same padding rationale as the bathymetry source cache: nearby launch sites
// (Cape Vidal / St Lucia / Mapelane / Sodwana) get overlapping structure
// queries, so padding the bbox a little makes a future overlapping import
// more likely to be answerable from the Overpass cache without a live call.
const STRUCTURE_QUERY_PADDING_KM = 5;

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const launchSiteId = flags["launch-site"];
  if (typeof launchSiteId !== "string") {
    throw new Error("Usage: npm run structures:import -- --launch-site <launch_site_id>");
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
  const layerKeys = [...new Set(OSM_TAG_RULES.map((r) => r.layerKey))];

  const jobId = await createImportJob({ provider: "osm", scope: "launch_site", launchSiteId: site.id, layerKeys, bbox });
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

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("structures:import failed:", err);
    process.exit(1);
  });
