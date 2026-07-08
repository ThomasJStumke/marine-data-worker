import { logger } from "../logger.js";
import { claimNextJob } from "../db/jobs.js";
import { processJob } from "../worker/processJob.js";

async function main() {
  const job = await claimNextJob();
  if (!job) {
    logger.info("no queued jobs — nothing to do");
    return;
  }
  logger.info("claimed job", { jobId: job.id, launchSiteId: job.launch_site_id });
  await processJob(job);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("worker:once failed:", err);
    process.exit(1);
  });
