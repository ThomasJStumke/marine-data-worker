import os from "node:os";
import { db } from "./client.js";
import { config } from "../config.js";

export interface WorkerRunCounts {
  jobsClaimed: number;
  jobsCompleted: number;
  jobsFailed: number;
  jobsSkippedUnchanged: number;
}

/** Insert the RUNNING row for a `worker:drain` invocation. Returns its id so the run can be finalized on exit. */
export async function startWorkerRun(): Promise<string> {
  const nextRunExpectedAt = new Date(Date.now() + config.workerRunIntervalMinutes * 60_000).toISOString();
  const { data, error } = await db
    .from("marine_data_worker_runs")
    .insert({
      status: "RUNNING",
      next_run_expected_at: nextRunExpectedAt,
      worker_version: config.workerVersion,
      host: os.hostname(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to record worker run start: ${error?.message}`);
  return data.id as string;
}

export async function finishWorkerRun(runId: string, counts: WorkerRunCounts): Promise<void> {
  const { error } = await db
    .from("marine_data_worker_runs")
    .update({
      status: "COMPLETED",
      completed_at: new Date().toISOString(),
      jobs_claimed: counts.jobsClaimed,
      jobs_completed: counts.jobsCompleted,
      jobs_failed: counts.jobsFailed,
      jobs_skipped_unchanged: counts.jobsSkippedUnchanged,
    })
    .eq("id", runId);
  if (error) throw new Error(`Failed to record worker run completion: ${error.message}`);
}

export async function failWorkerRun(runId: string, counts: WorkerRunCounts, errorMessage: string): Promise<void> {
  await db
    .from("marine_data_worker_runs")
    .update({
      status: "FAILED",
      completed_at: new Date().toISOString(),
      jobs_claimed: counts.jobsClaimed,
      jobs_completed: counts.jobsCompleted,
      jobs_failed: counts.jobsFailed,
      jobs_skipped_unchanged: counts.jobsSkippedUnchanged,
      error_message: errorMessage,
    })
    .eq("id", runId);
}
