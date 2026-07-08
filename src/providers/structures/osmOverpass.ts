import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import type { BBox } from "../../types.js";
import { OSM_TAG_RULES } from "../../structures/osmTags.js";
import { normalizeOverpassElement, type OverpassElement } from "../../structures/normalize.js";
import type { NormalizedStructureFeature } from "../../structures/types.js";

interface OverpassResponse {
  osm3s?: { timestamp_osm_base?: string; copyright?: string };
  elements: OverpassElement[];
}

export interface OsmImportResult {
  providerVersion: string;
  features: NormalizedStructureFeature[];
  rawElementCount: number;
}

// Overpass's usage policy requires a real identifying User-Agent — an
// anonymous/browser-spoofed one risks being rate-limited or blocked.
const USER_AGENT = "DareToFish-MarineDataWorker/1.0 (+https://daretofish.com; marine structure import; contact via repo)";

function buildQuery(bbox: BBox): string {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const clauses = OSM_TAG_RULES.map((rule) => `  node[${rule.filter}](${bboxStr});\n  way[${rule.filter}](${bboxStr});`).join(
    "\n",
  );
  // `out geom;` inlines full node coordinates on ways directly, so a way's
  // polygon/line geometry never needs a second recursive query to resolve.
  return `[out:json][timeout:${config.overpassTimeoutSec}];\n(\n${clauses}\n);\nout geom;`;
}

function cacheKeyFor(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

async function readCache(cacheDir: string, key: string, ttlMs: number): Promise<OverpassResponse | null> {
  try {
    const filePath = path.join(cacheDir, `${key}.json`);
    const s = await stat(filePath);
    if (Date.now() - s.mtimeMs > ttlMs) return null;
    return JSON.parse(await readFile(filePath, "utf-8")) as OverpassResponse;
  } catch {
    return null;
  }
}

async function writeCache(cacheDir: string, key: string, data: OverpassResponse): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify(data));
}

async function fetchWithRetry(url: string, body: string, maxAttempts: number): Promise<OverpassResponse> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": USER_AGENT },
        body,
      });
      if (res.status === 429 || res.status === 504) {
        const waitMs = 2000 * 2 ** (attempt - 1);
        logger.warn("Overpass rate-limited/timed out, backing off", { attempt, waitMs, status: res.status });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Overpass request failed (${res.status} ${res.statusText}): ${await res.text()}`);
      }
      return (await res.json()) as OverpassResponse;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const waitMs = 1000 * 2 ** (attempt - 1);
        logger.warn("Overpass request errored, retrying", { attempt, waitMs, err: String(err) });
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw new Error(`Overpass request failed after ${maxAttempts} attempts: ${String(lastErr)}`);
}

/**
 * Imports marine structure features from OSM/OpenSeaMap within `bbox` via
 * the public Overpass API. Builds a real Overpass QL query from
 * OSM_TAG_RULES, sends it with a proper identifying User-Agent, retries with
 * exponential backoff on 429/504 (and on transport errors), and caches the
 * raw response to disk for OVERPASS_CACHE_TTL_MS so repeated imports of the
 * same/overlapping extent within the TTL reuse one API call — the same
 * cache-first shape as the bathymetry source cache, just file-based rather
 * than PostGIS-indexed since Overpass queries are already bbox-exact.
 */
export async function importFromOsmOverpass(bbox: BBox): Promise<OsmImportResult> {
  const query = buildQuery(bbox);
  const key = cacheKeyFor(query);
  const cacheDir = path.join(config.cacheDirectory, "osm-overpass");

  let response = await readCache(cacheDir, key, config.overpassCacheTtlMs);
  if (response) {
    logger.info("Overpass cache hit", { bbox });
  } else {
    logger.info("Overpass cache miss — querying live API", { bbox, apiUrl: config.overpassApiUrl });
    response = await fetchWithRetry(config.overpassApiUrl, query, config.overpassMaxRetries);
    await writeCache(cacheDir, key, response);
  }

  const providerVersion = response.osm3s?.timestamp_osm_base ?? new Date().toISOString();
  const features = response.elements
    .map((el) => normalizeOverpassElement(el, providerVersion))
    .filter((f): f is NormalizedStructureFeature => f !== null);

  return { providerVersion, features, rawElementCount: response.elements.length };
}
