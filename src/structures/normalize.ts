import { createHash } from "node:crypto";
import { layerKeyForTags } from "./osmTags.js";
import type { NormalizedStructureFeature, StructureGeometry } from "./types.js";

export interface OverpassElement {

  type: "node" | "way";
  id: number;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

const ATTRIBUTION = "© OpenStreetMap contributors (via OpenSeaMap seamark tagging)";
const LICENCE = "ODbL 1.0 — https://www.openstreetmap.org/copyright";

/**
 * Normalizes one raw Overpass element into a `marine_structure_features` row
 * shape. Returns null for elements that don't match a known structure tag
 * (shouldn't happen given the query only asks for those tags, but Overpass
 * can return a superset in edge cases) or that lack usable geometry.
 */
export function normalizeOverpassElement(el: OverpassElement, providerVersion: string): NormalizedStructureFeature | null {
  const layerKey = layerKeyForTags(el.tags);
  if (!layerKey) return null;

  const geometry = buildGeometry(el);
  if (!geometry) return null;

  const name = el.tags?.name ?? el.tags?.["seamark:name"] ?? null;
  const depthM = parseDepth(el.tags);
  const metadata = el.tags ?? {};
  const providerFeatureId = `${el.type}/${el.id}`;

  const checksum = createHash("sha256")
    .update(JSON.stringify({ geometry, tags: sortedEntries(metadata) }))
    .digest("hex");

  return {
    layerKey,
    provider: "osm",
    providerVersion,
    providerFeatureId,
    name,
    geometry,
    depthM,
    metadata,
    checksum,
    attribution: ATTRIBUTION,
    licence: LICENCE,
  };
}

function buildGeometry(el: OverpassElement): StructureGeometry | null {
  if (el.type === "node") {
    if (el.lat == null || el.lon == null) return null;
    return { type: "Point", coordinates: [el.lon, el.lat] };
  }

  const coords = (el.geometry ?? [])
    .filter((p) => p.lat != null && p.lon != null)
    .map((p): [number, number] => [p.lon, p.lat]);
  if (coords.length < 2) return null;

  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  const isClosedRing = coords.length >= 4 && first[0] === last[0] && first[1] === last[1];
  if (isClosedRing) return { type: "Polygon", coordinates: [coords] };
  return { type: "LineString", coordinates: coords };
}

function parseDepth(tags: Record<string, string> | undefined): number | null {
  const raw = tags?.["seamark:depth"] ?? tags?.depth;
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function sortedEntries(obj: Record<string, string>): [string, string][] {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}
