import { db } from "./client.js";
import type { NormalizedStructureFeature, StructureImportOutcome } from "../structures/types.js";

/**
 * Upserts one normalized feature via upsert_marine_structure_feature() (see
 * 20260711000000_marine_structure_platform.sql) — the RPC builds
 * geom/centroid server-side from GeoJSON and does the ON CONFLICT
 * (provider, provider_feature_id) dedup, so this is a thin typed wrapper,
 * not a second place that constructs geometry.
 */
async function upsertFeature(feature: NormalizedStructureFeature): Promise<"inserted" | "updated" | "unchanged"> {
  // Read-before-write only to classify the outcome for import-job stats —
  // the upsert itself is atomic regardless of this check.
  const { data: existing } = await db
    .from("marine_structure_features")
    .select("checksum")
    .eq("provider", feature.provider)
    .eq("provider_feature_id", feature.providerFeatureId)
    .maybeSingle();

  const { error } = await db.rpc("upsert_marine_structure_feature", {
    p_layer_key: feature.layerKey,
    p_provider: feature.provider,
    p_provider_version: feature.providerVersion,
    p_provider_feature_id: feature.providerFeatureId,
    p_name: feature.name,
    p_geom_geojson: feature.geometry,
    p_depth_m: feature.depthM,
    p_metadata: feature.metadata,
    p_checksum: feature.checksum,
    p_attribution: feature.attribution,
    p_licence: feature.licence,
  });
  if (error) throw new Error(`upsert_marine_structure_feature(${feature.providerFeatureId}) failed: ${error.message}`);

  if (!existing) return "inserted";
  return existing.checksum === feature.checksum ? "unchanged" : "updated";
}

// Dense coastal cells in a `--global` sweep can hold hundreds of features —
// fully sequential upserts (one at a time) make those cells the slow path.
// Bounded concurrency (no queue library needed for a fixed-size worker pool
// this small) keeps a cap on concurrent Supabase round-trips without
// changing the per-feature read-then-upsert logic in upsertFeature().
const UPSERT_CONCURRENCY = 8;

async function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Upserts a batch of normalized features with bounded concurrency and tallies insert/update/unchanged counts for import-job reporting. */
export async function storeStructureFeatures(features: NormalizedStructureFeature[]): Promise<StructureImportOutcome> {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  await runWithConcurrency(features, UPSERT_CONCURRENCY, async (feature) => {
    const outcome = await upsertFeature(feature);
    if (outcome === "inserted") inserted++;
    else if (outcome === "updated") updated++;
    else unchanged++;
  });

  return {
    featuresFound: features.length,
    featuresInserted: inserted,
    featuresUpdated: updated,
    featuresUnchanged: unchanged,
    providerVersion: features[0]?.providerVersion ?? "",
  };
}
