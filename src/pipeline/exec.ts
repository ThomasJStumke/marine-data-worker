import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

/**
 * Runs a GIS CLI tool (gdalwarp, gdaldem, gdal_contour, gdal_translate,
 * gdaladdo, tippecanoe, pmtiles — all expected to be present on PATH inside
 * the worker's Docker image, see Dockerfile) and surfaces stderr in the
 * thrown error so pipeline failures are debuggable from bathymetry_jobs /
 * marine_data_job_logs without needing shell access to the container.
 */
export async function runTool(bin: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  try {
    await execFileAsync(bin, args, { cwd: opts.cwd, maxBuffer: 1024 * 1024 * 64 });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error(`${bin} ${args.join(" ")} failed: ${e.stderr || e.stdout || e.message}`);
  }
}

/** Same as runTool, but returns stdout — for tools whose output IS the result (gdalinfo), not just a side effect. */
export async function runToolCapture(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, { maxBuffer: 1024 * 1024 * 64 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error(`${bin} ${args.join(" ")} failed: ${e.stderr || e.stdout || e.message}`);
  }
}
