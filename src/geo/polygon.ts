import type { BBox, CoveragePolygon } from "../types.js";

const KM_PER_DEG_LAT = 111.32;
const DEFAULT_FACING_DEG = 90; // east — matches the admin form's default beach_facing_deg

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Builds the launch site's offshore-biased coverage polygon: a quadrilateral
 * facing `beach_facing_deg` (the same bearing the admin form already collects
 * for wind/swell exposure — see src/routes/super-admin.data-setup.tsx), NOT a
 * radius circle. Most fishing happens offshore, so the seaward dimension
 * dominates while the landward one stays small (the app's coverage defaults
 * are 20/20/20 offshore-left-right and 1 inland).
 *
 * Uses a flat-earth (equirectangular) approximation, which is more than
 * accurate enough at the ~20-40km scale these polygons operate at.
 */
export function buildCoveragePolygon(
  latitude: number,
  longitude: number,
  beachFacingDeg: number | null | undefined,
  coverage: { offshoreKm: number; leftKm: number; rightKm: number; inlandKm: number },
): CoveragePolygon {
  const facingRad = toRad(beachFacingDeg ?? DEFAULT_FACING_DEG);
  const kmPerDegLng = KM_PER_DEG_LAT * Math.cos(toRad(latitude));

  // Forward = unit vector towards the sea (bearing convention: 0=N, 90=E).
  const forward = { east: Math.sin(facingRad), north: Math.cos(facingRad) };
  // Right = forward rotated 90° clockwise (angler's right hand facing the sea).
  const right = { east: Math.cos(facingRad), north: -Math.sin(facingRad) };

  const { offshoreKm, leftKm, rightKm, inlandKm } = coverage;

  // Corners expressed as (rightComponent, forwardComponent) km offsets, then
  // projected into (east, north) km, then into lat/lng degrees.
  const corners: [number, number][] = [
    [rightKm, offshoreKm], // seaward-right
    [-leftKm, offshoreKm], // seaward-left
    [-leftKm, -inlandKm], // landward-left
    [rightKm, -inlandKm], // landward-right
  ];

  const ring: [number, number][] = corners.map(([r, f]) => {
    const eastKm = r * right.east + f * forward.east;
    const northKm = r * right.north + f * forward.north;
    const lng = longitude + eastKm / kmPerDegLng;
    const lat = latitude + northKm / KM_PER_DEG_LAT;
    return [lng, lat];
  });
  ring.push(ring[0]!); // close the ring

  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const bbox: BBox = {
    west: Math.min(...lngs),
    south: Math.min(...lats),
    east: Math.max(...lngs),
    north: Math.max(...lats),
  };

  return { ring, bbox };
}

// cos(latitude) used below to convert an east-west margin from km to degrees
// shrinks toward 0 near the poles, which would blow dLng up toward infinity
// for a site placed there — clamping the latitude used for that conversion
// (never resolving as if we were closer to the pole than this) bounds dLng
// to a sane maximum instead of producing a pathologically wide bbox that a
// downstream gdalwarp/gdal_rasterize call would try to rasterize in full.
const MAX_ABS_LATITUDE_FOR_PADDING_DEG = 85;

/** Expands a bbox by a fixed margin (km) in every direction — used before downloading source data so the cached extent is more likely to fully cover future nearby requests. */
export function padBBox(bbox: BBox, marginKm: number, latitude: number): BBox {
  const clampedLatitude = Math.max(-MAX_ABS_LATITUDE_FOR_PADDING_DEG, Math.min(MAX_ABS_LATITUDE_FOR_PADDING_DEG, latitude));
  const dLat = marginKm / KM_PER_DEG_LAT;
  const dLng = marginKm / (KM_PER_DEG_LAT * Math.cos(toRad(clampedLatitude)));
  return {
    west: bbox.west - dLng,
    south: bbox.south - dLat,
    east: bbox.east + dLng,
    north: bbox.north + dLat,
  };
}

/** Writes a GeoJSON Polygon Feature for the coverage ring — used as a `-cutline` input to gdalwarp for true polygon (not just bbox) clipping. */
export function polygonToGeoJSON(polygon: CoveragePolygon): object {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [polygon.ring] },
      },
    ],
  };
}
