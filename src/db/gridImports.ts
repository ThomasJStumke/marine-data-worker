import { db } from "./client.js";
import type { GridImportJob } from "../types.js";

/** Same SETOF-returning-RPC shape as claimNextJob() in jobs.ts — see the 20260712030000 migration for why. */
export async function claimNextGridImport(): Promise<GridImportJob | null> {
  const { data, error } = await db.rpc("claim_next_grid_import");
  if (error) throw new Error(`claim_next_grid_import failed: ${error.message}`);
  const rows = (data as GridImportJob[] | null) ?? [];
  return rows[0] ?? null;
}

export async function markGridImportStage(id: string, stage: string): Promise<void> {
  const { error } = await db.from("marine_data_grid_imports").update({ current_stage: stage }).eq("id", id);
  if (error) throw new Error(`update marine_data_grid_imports(${id}) failed: ${error.message}`);
}

export interface GridImportCompletionInfo {
  filePath: string;
  fileSizeBytes: number;
  checksum: string;
  rasterSummary: string;
}

export async function markGridImportCompleted(id: string, info: GridImportCompletionInfo): Promise<void> {
  const { error } = await db
    .from("marine_data_grid_imports")
    .update({
      status: "COMPLETED",
      completed_at: new Date().toISOString(),
      current_stage: "completed",
      file_path: info.filePath,
      file_size_bytes: info.fileSizeBytes,
      checksum: info.checksum,
      raster_summary: info.rasterSummary,
    })
    .eq("id", id);
  if (error) throw new Error(`update marine_data_grid_imports(${id}) failed: ${error.message}`);
}

export async function markGridImportFailed(id: string, stage: string, message: string): Promise<void> {
  await db
    .from("marine_data_grid_imports")
    .update({
      status: "FAILED",
      completed_at: new Date().toISOString(),
      current_stage: stage,
      error_message: message,
    })
    .eq("id", id);
}
