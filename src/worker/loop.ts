import { config } from "../config.js";
import { logger } from "../logger.js";
import { claimNextJob } from "../db/jobs.js";
import { processJob } from "./processJob.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Continuous polling loop. Horizontally scalable by construction: every
 * claim goes through claim_next_bathymetry_job()'s FOR UPDATE SKIP LOCKED
 * (see db/jobs.ts#claimNextJob and the 20260710000000 migration), so running
 * this loop in 1 process or 100 processes/containers/instances at once
 * cannot result in two of them processing the same job — each claim call
 * atomically owns at most one row, and any other concurrent caller either
 * gets a different QUEUED row or NULL. There is no other job-claiming path
 * anywhere in this worker.
 */
export async function runWorkerLoop(): Promise<void> {
  let shuttingDown = false;
  const onSignal = (sig: string) => {
    logger.info(`received ${sig}, finishing in-flight jobs then exiting`);
    shuttingDown = true;
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const active = new Map<string, Promise<void>>();

  logger.info("marine-data worker started", {
    maxConcurrentJobs: config.maxConcurrentJobs,
    pollIntervalMs: config.pollIntervalMs,
    provider: config.bathymetryProvider,
    workerVersion: config.workerVersion,
  });

  while (!shuttingDown) {
    while (active.size < config.maxConcurrentJobs) {
      const job = await claimNextJob();
      if (!job) break;
      logger.info("claimed job", { jobId: job.id, launchSiteId: job.launch_site_id, activeCount: active.size + 1 });
      const p: Promise<void> = processJob(job)
        .then(() => undefined)
        .catch((err) => logger.error("unexpected error escaped processJob", { jobId: job.id, error: String(err) }))
        .finally(() => active.delete(job.id));
      active.set(job.id, p);
    }
    await sleep(config.pollIntervalMs);
  }

  logger.info("waiting for in-flight jobs to finish", { count: active.size });
  await Promise.all(active.values());
  logger.info("worker shut down cleanly");
}
