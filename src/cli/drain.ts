import { startWorkerRun } from "../db/workerRuns.js";
import { drainBathymetryQueue } from "../worker/drainQueue.js";

/**
 * Hourly-cron entry point: inserts a fresh RUNNING marine_data_worker_runs
 * row (trigger=SCHEDULED, the DB default), then drains the queue — see
 * worker/drainQueue.ts. Distinct from cli/checkForceRun.ts, which claims an
 * admin-requested row instead of inserting one.
 */
async function main() {
  const runId = await startWorkerRun();
  await drainBathymetryQueue(runId);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("worker:drain failed:", err);
    process.exit(1);
  });
