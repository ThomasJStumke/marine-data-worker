import { S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";

// Cloudflare R2 is S3-compatible — same SDK the main app's own R2 upload
// path uses (see src/lib/r2-client.ts in the DareToFish app), just
// configured for the worker's own credentials/bucket.
export const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
  },
});
