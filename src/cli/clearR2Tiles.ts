// One-off: delete every object under contours/launch-sites/ and
// contour-bands/launch-sites/ from R2 so a full rebuild (after a
// MIN_ZOOM/MAX_ZOOM change) can't leave stale, wrong-zoom-range files
// behind for sites that haven't been requeued/drained yet.
import { ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { r2 } from "../r2/client.js";
import { config } from "../config.js";

const PREFIXES = ["contours/launch-sites/", "contour-bands/launch-sites/"];

async function clearPrefix(prefix: string) {
  let continuationToken: string | undefined;
  let deleted = 0;
  do {
    const list = await r2.send(
      new ListObjectsV2Command({
        Bucket: config.r2BucketPublic,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (list.Contents ?? []).map((o) => o.Key!).filter(Boolean);
    if (keys.length > 0) {
      await r2.send(
        new DeleteObjectsCommand({
          Bucket: config.r2BucketPublic,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
      deleted += keys.length;
      console.log(`  deleted ${keys.length} (running total ${deleted}) under ${prefix}`);
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  console.log(`${prefix}: ${deleted} object(s) deleted`);
  return deleted;
}

async function main() {
  let total = 0;
  for (const prefix of PREFIXES) {
    console.log(`Clearing ${prefix} ...`);
    total += await clearPrefix(prefix);
  }
  console.log(`Done — ${total} object(s) deleted total.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
