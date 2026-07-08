import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

// GEBCO's global grid is ~7GB. This is a sanity cap against a mistyped or
// malicious URL, not a real limit on legitimate bathymetry grid files.
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024 * 1024;

/** Free space (bytes) on the filesystem containing `dir`, via `df` — no native statvfs binding in Node. */
export async function availableBytes(dir: string): Promise<number> {
  const { stdout } = await execFileAsync("df", ["--output=avail", "-B1", dir]);
  const lines = stdout.trim().split("\n");
  return Number.parseInt(lines[lines.length - 1]?.trim() ?? "0", 10);
}

/**
 * Streams a URL straight to disk (never buffers the whole response in
 * memory — required for multi-GB grid files) after checking Content-Length
 * against MAX_DOWNLOAD_BYTES and against actual free disk space.
 */
export async function downloadToFile(url: string, destPath: string): Promise<{ sizeBytes: number }> {
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`Refusing to download non-HTTPS URL: ${url}`);
  }

  await mkdir(path.dirname(destPath), { recursive: true });

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`);
  }

  const contentLength = res.headers.get("content-length");
  const totalBytes = contentLength ? Number.parseInt(contentLength, 10) : null;

  if (totalBytes && totalBytes > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Refusing to download ${totalBytes} bytes (exceeds ${MAX_DOWNLOAD_BYTES}-byte sanity cap) — is this really a bathymetry grid file?`);
  }

  if (totalBytes) {
    const free = await availableBytes(path.dirname(destPath));
    if (free < totalBytes * 1.05) {
      throw new Error(`Not enough free disk space to download: need ~${totalBytes} bytes (+5% margin), only ${free} available at ${path.dirname(destPath)}`);
    }
  }

  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  await streamPipeline(nodeStream, createWriteStream(destPath));

  return { sizeBytes: totalBytes ?? 0 };
}
