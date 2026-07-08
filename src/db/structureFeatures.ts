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

/** Upserts a batch of normalized features sequentially and tallies insert/update/unchanged counts for import-job reporting. */
export async function storeStructureFeatures(features: NormalizedStructureFeature[]): Promise<StructureImportOutcome> {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const feature of features) {
    const outcome = await upsertFeature(feature);
    if (outcome === "inserted") inserted++;
    else if (outcome === "updated") updated++;
    else unchanged++;
  }

  return {
    featuresFound: features.length,
    featuresInserted: inserted,
    featuresUpdated: updated,
    featuresUnchanged: unchanged,
    providerVersion: features[0]?.providerVersion ?? "",
  };
}
