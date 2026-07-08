import type { StructureLayerKey } from "./types.js";

export interface OsmTagRule {
  /** Overpass QL tag filter body, e.g. `"natural"="reef"` (without the enclosing `[ ]`). */
  filter: string;
  layerKey: StructureLayerKey;
}

/**
 * Real OSM/OpenSeaMap tags this importer queries for — no placeholder tags.
 * Order matters only in that the first matching rule wins in
 * `layerKeyForTags`; none of these tag values overlap in practice so that
 * never actually comes up.
 */
export const OSM_TAG_RULES: OsmTagRule[] = [
  { filter: `"natural"="reef"`, layerKey: "reef" },
  { filter: `"natural"="shoal"`, layerKey: "shoal" },
  { filter: `"natural"="rock"`, layerKey: "rock" },
  { filter: `"seamark:type"="wreck"`, layerKey: "wreck" },
  { filter: `"seamark:type"="obstruction"`, layerKey: "obstruction" },
  { filter: `"seamark:type"="reef"`, layerKey: "reef" },
  { filter: `"seamark:type"="rock"`, layerKey: "rock" },
  { filter: `"seamark:type"="foul_ground"`, layerKey: "foul_ground" },
  { filter: `"seamark:type"="weed"`, layerKey: "weed" },
  { filter: `"seamark:type"="kelp"`, layerKey: "kelp" },
];

function parseFilter(filter: string): [string, string] {
  const m = filter.match(/^"([^"]+)"="([^"]+)"$/);
  if (!m) throw new Error(`Unparseable OSM tag filter: ${filter}`);
  return [m[1]!, m[2]!];
}

/** Which structure layer (if any) an OSM element's tags map to — the same rule set that built the Overpass query, so a fetched element can never fail to match. */
export function layerKeyForTags(tags: Record<string, string> | undefined): StructureLayerKey | null {
  if (!tags) return null;
  for (const rule of OSM_TAG_RULES) {
    const [key, value] = parseFilter(rule.filter);
    if (tags[key] === value) return rule.layerKey;
  }
  return null;
}
