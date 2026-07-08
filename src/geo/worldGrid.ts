import type { BBox } from "../types.js";

export interface WorldGridOptions {
  /** Cell size in degrees, applied to both latitude and longitude. */
  cellSizeDeg?: number;
  /** Absolute latitude beyond which cells are skipped — polar ice caps have no shipping/reef/wreck data worth querying. */
  maxAbsLat?: number;
}

/**
 * Tiles the whole globe into a static grid of bboxes for a `--global`
 * structures import. Static (not launch-site-shaped) so re-running always
 * produces the exact same cell boundaries — that's what makes
 * findCompletedGlobalJobForBBox()'s exact-match lookup a safe resumability
 * key (see src/db/structureImportJobs.ts).
 */
export function buildWorldGrid(opts: WorldGridOptions = {}): BBox[] {
  const cellSizeDeg = opts.cellSizeDeg ?? 10;
  const maxAbsLat = opts.maxAbsLat ?? 78;

  const cells: BBox[] = [];
  for (let south = -maxAbsLat; south < maxAbsLat; south += cellSizeDeg) {
    const north = Math.min(south + cellSizeDeg, maxAbsLat);
    for (let west = -180; west < 180; west += cellSizeDeg) {
      const east = Math.min(west + cellSizeDeg, 180);
      cells.push({ west, south, east, north });
    }
  }
  return cells;
}
