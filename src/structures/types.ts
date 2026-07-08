export type StructureLayerKey =
  | "reef"
  | "wreck"
  | "rock"
  | "shoal"
  | "obstruction"
  | "foul_ground"
  | "kelp"
  | "weed";

// Minimal local GeoJSON geometry types — avoids pulling in a full @types/geojson
// dependency for the three shapes this platform actually produces.
export interface GeoJSONPoint {
  type: "Point";
  coordinates: [number, number];
}
export interface GeoJSONLineString {
  type: "LineString";
  coordinates: [number, number][];
}
export interface GeoJSONPolygon {
  type: "Polygon";
  coordinates: [number, number][][];
}
export type StructureGeometry = GeoJSONPoint | GeoJSONLineString | GeoJSONPolygon;

export interface NormalizedStructureFeature {
  layerKey: StructureLayerKey;
  provider: string;
  providerVersion: string;
  providerFeatureId: string;
  name: string | null;
  geometry: StructureGeometry;
  depthM: number | null;
  metadata: Record<string, unknown>;
  checksum: string;
  attribution: string;
  licence: string;
}

export interface StructureImportOutcome {
  featuresFound: number;
  featuresInserted: number;
  featuresUpdated: number;
  featuresUnchanged: number;
  providerVersion: string;
}
