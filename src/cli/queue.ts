import { parseFlags } from "./args.js";
import { logger } from "../logger.js";
import { listNeverGeneratedSites } from "../db/launchSites.js";
import { hasActiveJobForSite, enqueueJob } from "../db/jobs.js";

/**
 * Backfill CLI: queues bathymetry generation for launch sites that have
 * never been generated (bathymetry_status = NOT_GENERATED), i.e. every
 * launch site on first rollout of this feature. Safe to run repeatedly —
 * skips any site that already has an active (QUEUED/GENERATING/UPLOADING)
 * job so re-running never creates duplicate active jobs for the same site.
 *
 * Usage:
 *   npm run worker:queue -- --country ZA
 *   npm run worker:queue -- --launch-site "Cape Vidal"
 *   npm run worker:queue -- --dry-run
 */
async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dryRun = !!flags["dry-run"];
  const country = typeof flags.country === "string" ? flags.country : undefined;
  const launchSiteName = typeof flags["launch-site"] === "string" ? (flags["launch-site"] as string) : undefined;

  const candidates = await listNeverGeneratedSites({ country, launchSiteName });
  if (candidates.length === 0) {
    logger.info("no never-generated launch sites match the given filters");
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
      logger.info(`[dry-run] would queue ${site.name} (${site.country ?? "unknown country"})`, { launchSiteId: site.id });
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
    logger.info(`queued ${site.name}`, { launchSiteId: site.id, jobId: job.id });
    queued++;
  }

  logger.info("backfill summary", { totalCandidates: candidates.length, queued, skipped, dryRun });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("worker:queue failed:", err);
    process.exit(1);
  });
