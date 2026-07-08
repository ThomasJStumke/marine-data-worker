import { readFile } from "node:fs/promises";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { r2 } from "./client.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics left behind by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function bathymetryKey(country: string | null, launchSiteName: string): string {
  return `bathymetry/launch-sites/${slugify(country || "unknown")}/${slugify(launchSiteName)}.pmtiles`;
}

export function contourKey(country: string | null, launchSiteName: string): string {
  return `contours/launch-sites/${slugify(country || "unknown")}/${slugify(launchSiteName)}.pmtiles`;
}

export interface UploadResult {
  uploaded: boolean;
  url: string;
  key: string;
}

/**
 * Uploads a file to R2 UNLESS an object already exists at that key with the
 * same checksum (checked via the object's `checksum` custom metadata,
 * populated by a prior upload) — in which case the existing object is left
 * untouched and reused. This is the second half of the checksum-comparison
 * guarantee: the job processor already short-circuits BEFORE this point
 * when the newly generated file matches the launch site's currently-live
 * checksum (see worker/processJob.ts); this HeadObject check additionally
 * covers the case where the DB's stored checksum was reset/unknown but the
 * object in R2 is still there unchanged (e.g. re-running against a fresh
 * launch_locations row pointed at an existing dataset).
 */
export async function uploadIfChanged(key: string, filePath: string, checksum: string): Promise<UploadResult> {
  const url = `${config.r2PublicBaseUrl}/${key}`;

  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: config.r2BucketPublic, Key: key }));
    if (head.Metadata?.checksum === checksum) {
      logger.info("R2 object already up to date by checksum — skipping upload", { key });
      return { uploaded: false, url, key };
    }
  } catch {
    // Object doesn't exist yet (404) or HEAD failed — fall through to upload.
  }

  const body = await readFile(filePath);
  await r2.send(
    new PutObjectCommand({
      Bucket: config.r2BucketPublic,
      Key: key,
      Body: body,
      ContentType: "application/vnd.pmtiles",
      Metadata: { checksum },
    }),
  );
  logger.info("uploaded to R2", { key, bytes: body.length });
  return { uploaded: true, url, key };
}
