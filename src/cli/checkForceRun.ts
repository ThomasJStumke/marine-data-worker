import { logger } from "../logger.js";
import { claimPendingWorkerRun } from "../db/workerRuns.js";
import { drainBathymetryQueue } from "../worker/drainQueue.js";

/**
 * Every-minute cron entry point: checks for an admin-requested "Force Run"
 * (a PENDING marine_data_worker_runs row inserted directly by the
 * super-admin UI). Near-instant no-op when there isn't one — this is what
 * lets a manual trigger run within ~1 minute instead of waiting for the
 * next hourly worker:drain.
 */
async function main() {
  const run = await claimPendingWorkerRun();
  if (!run) {
    logger.info("no force-run requested — nothing to do");
    return;
  }
  logger.info("claimed force-run request", { runId: run.id });
  await drainBathymetryQueue(run.id);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("worker:check-force-run failed:", err);
    process.exit(1);
  });
