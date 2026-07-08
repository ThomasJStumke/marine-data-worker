import { config } from "../config.js";
import { logger } from "../logger.js";
import { claimNextJob } from "../db/jobs.js";
import { processJob } from "../worker/processJob.js";
import { startWorkerRun, finishWorkerRun, failWorkerRun, type WorkerRunCounts } from "../db/workerRuns.js";

/**
 * Claims and processes every currently-QUEUED job, then exits — unlike
 * `run.ts`'s never-ending poll loop. Intended for a scheduled (e.g. hourly
 * cron) invocation that drains whatever accumulated since the last run
 * rather than holding a container open indefinitely between jobs. Records
 * one marine_data_worker_runs row per invocation so the admin UI can show
 * whether the scheduled run is actually happening.
 */
async function main() {
  const runId = await startWorkerRun();
  const counts: WorkerRunCounts = { jobsClaimed: 0, jobsCompleted: 0, jobsFailed: 0, jobsSkippedUnchanged: 0 };
  const active = new Map<string, Promise<void>>();

  try {
    while (true) {
      while (active.size < config.maxConcurrentJobs) {
        const job = await claimNextJob();
        if (!job) break;
        counts.jobsClaimed++;
        logger.info("claimed job", { jobId: job.id, launchSiteId: job.launch_site_id, activeCount: active.size + 1 });
        const p = processJob(job)
          .then((outcome) => {
            if (outcome === "COMPLETED") counts.jobsCompleted++;
            else if (outcome === "SKIPPED_UNCHANGED") counts.jobsSkippedUnchanged++;
            else counts.jobsFailed++;
          })
          .catch((err) => {
            counts.jobsFailed++;
            logger.error("unexpected error escaped processJob", { jobId: job.id, error: String(err) });
          })
          .finally(() => active.delete(job.id));
        active.set(job.id, p);
      }
      if (active.size === 0) break;
      await Promise.race(active.values());
    }

    await finishWorkerRun(runId, counts);
    logger.info("queue drained", { ...counts });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await failWorkerRun(runId, counts, error.message).catch(() => {});
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("worker:drain failed:", err);
    process.exit(1);
  });
