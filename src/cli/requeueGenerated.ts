import { parseFlags } from "./args.js";
import { logger } from "../logger.js";
import { listGeneratedSites } from "../db/launchSites.js";
import { hasActiveJobForSite, enqueueJob } from "../db/jobs.js";

/**
 * Re-generation CLI: queues bathymetry generation for launch sites that
 * already have a COMPLETED dataset, so a pipeline/coverage change (e.g. the
 * land-cutoff ramp fix, or a widened coverage radius) reaches sites that
 * were generated before the change — `worker:queue` only picks up sites
 * that have never been generated. Safe to run repeatedly — skips any site
 * that already has an active (QUEUED/GENERATING/UPLOADING) job.
 *
 * The coverage snapshot used is always the site's CURRENT
 * bathymetry_coverage_*_km columns at the time this runs, not whatever was
 * used for its last completed generation — so re-running this after
 * widening a site's coverage picks up the new, wider extent.
 *
 * Usage:
 *   npm run worker:requeue-generated -- --country ZA
 *   npm run worker:requeue-generated -- --launch-site "Cape Vidal"
 *   npm run worker:requeue-generated -- --dry-run
 */
async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dryRun = !!flags["dry-run"];
  const country = typeof flags.country === "string" ? flags.country : undefined;
  const launchSiteName = typeof flags["launch-site"] === "string" ? (flags["launch-site"] as string) : undefined;

  const candidates = await listGeneratedSites({ country, launchSiteName });
  if (candidates.length === 0) {
    logger.info("no completed launch sites match the given filters");
    return;
  }

  let queued = 0;
  let skipped = 0;
  for (const site of candidates) {
    if (await hasActiveJobForSite(site.id)) {
      logger.info(`skipping ${site.name} — already has an active job`, { launchSiteId: site.id });
      skipped++;
      continue;
    }
    if (dryRun) {
      logger.info(`[dry-run] would requeue ${site.name} (${site.country ?? "unknown country"})`, { launchSiteId: site.id });
      continue;
    }
    const job = await enqueueJob({
      launchSiteId: site.id,
      coverage: {
        offshoreKm: site.bathymetry_coverage_offshore_km,
        leftKm: site.bathymetry_coverage_left_km,
        rightKm: site.bathymetry_coverage_right_km,
        inlandKm: site.bathymetry_coverage_inland_km,
      },
    });
    logger.info(`requeued ${site.name}`, { launchSiteId: site.id, jobId: job.id });
    queued++;
  }

  logger.info("requeue-generated summary", { totalCandidates: candidates.length, queued, skipped, dryRun });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("worker:requeue-generated failed:", err);
    process.exit(1);
  });
