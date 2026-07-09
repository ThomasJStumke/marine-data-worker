import type { BBox } from "../types.js";

export type GridCell = BBox;

/**
 * Resolves the single fixed global grid cell a point falls in — same
 * floor-division tiling as worldGrid.ts's buildWorldGrid (static, so the
 * same point always resolves to the same cell), but for one point instead
 * of enumerating the globe. This is what turns the contour cache lookup
 * into a plain equality match: any two launch sites in the same cell
 * request the identical padded bbox and therefore share the identical
 * cached regional trace, instead of needing a fuzzy spatial containment
 * query against arbitrary per-site windows.
 */
export function resolveContourGridCell(latitude: number, longitude: number, cellSizeDeg: number): GridCell {
  const south = Math.floor(latitude / cellSizeDeg) * cellSizeDeg;
  const west = Math.floor(longitude / cellSizeDeg) * cellSizeDeg;
  return { south, west, north: south + cellSizeDeg, east: west + cellSizeDeg };
}
