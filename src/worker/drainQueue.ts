import { config } from "../config.js";
import { logger } from "../logger.js";
import { claimNextJob } from "../db/jobs.js";
import { processJob } from "./processJob.js";
import { finishWorkerRun, failWorkerRun, updateWorkerRunProgress, type WorkerRunCounts } from "../db/workerRuns.js";

/**
 * Claims and processes every currently-QUEUED bathymetry job, finalizing the
 * given (already-inserted/claimed) marine_data_worker_runs row with the
 * outcome. Shared by both entry points that can trigger a run:
 *
 * - cli/drain.ts (hourly cron) — inserts a fresh RUNNING row itself, then
 *   calls this.
 * - cli/checkForceRun.ts (every-minute cron) — claims an admin-requested
 *   PENDING row via claim_next_pending_worker_run(), then calls this.
 *
 * Both end up recording jobs_claimed/completed/failed/skipped_unchanged the
 * same way, so the admin UI can't tell (and doesn't need to care) which path
 * produced a given run — only marine_data_worker_runs.trigger distinguishes them.
 */
export async function drainBathymetryQueue(runId: string): Promise<void> {
  const counts: WorkerRunCounts = { jobsClaimed: 0, jobsCompleted: 0, jobsFailed: 0, jobsSkippedUnchanged: 0 };
  const active = new Map<string, Promise<void>>();

  try {
    while (true) {
      while (active.size < config.maxConcurrentJobs) {
        const job = await claimNextJob();
        if (!job) break;
        counts.jobsClaimed++;
        logger.info("claimed job", { jobId: job.id, launchSiteId: job.launch_site_id, activeCount: active.size + 1 });
        await updateWorkerRunProgress(runId, counts).catch((err) =>
          logger.warn("failed to record worker run progress", { jobId: job.id, error: String(err) }),
        );
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
          .finally(() => {
            active.delete(job.id);
            void updateWorkerRunProgress(runId, counts).catch((err) =>
              logger.warn("failed to record worker run progress", { jobId: job.id, error: String(err) }),
            );
          });
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
