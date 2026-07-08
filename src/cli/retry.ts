import { parseFlags } from "./args.js";
import { logger } from "../logger.js";
import { requeueJob } from "../db/jobs.js";

/**
 * Requeues a FAILED job for another attempt.
 *
 * Usage:
 *   npm run worker:retry -- --job <job-id>
 */
async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const jobId = typeof flags.job === "string" ? flags.job : undefined;
  if (!jobId) {
    console.error("Usage: npm run worker:retry -- --job <job-id>");
    process.exit(1);
  }
  const job = await requeueJob(jobId);
  logger.info("job requeued", { jobId: job.id, retryCount: job.retry_count });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("worker:retry failed:", err);
    process.exit(1);
  });
