# Marine Data Worker

Standalone service that processes queued DareToFish launch-site bathymetry/contour
generation jobs. Completely independent from the DareToFish React app: the app only ever
creates rows in `bathymetry_jobs` with `status = 'QUEUED'` (via its "Generate Bathymetry"
button); this worker does every actual GIS operation — acquiring source data, clipping,
generating depth-shading + contours, converting to PMTiles, uploading to Cloudflare R2, and
writing the results back to Supabase.

Full architecture writeup: [`docs/marine-data-worker.md`](../../blue-baboons-compete/docs/marine-data-worker.md)
in the main app repo.

## Requirements

- Node.js >= 20
- GDAL (`gdalwarp`, `gdaldem`, `gdal_contour`, `gdal_translate`, `gdaladdo`) on `PATH`
- [Tippecanoe](https://github.com/felt/tippecanoe) on `PATH`
- [pmtiles CLI](https://github.com/protomaps/go-pmtiles) on `PATH`
- A Supabase service-role key for the DareToFish project
- Cloudflare R2 credentials

The provided `Dockerfile` bundles all of the above into one image — see "Running with
Docker" below if you don't want to install the GIS toolchain locally.

## Setup

```bash
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_* — see .env.example for the full list
npm install
```

## Running locally

```bash
npm run worker            # continuous polling loop (this is what production runs)
npm run worker:once       # claim and process a single job, then exit
npm run worker:queue -- --country ZA           # queue every never-generated ZA launch site
npm run worker:queue -- --launch-site "Cape Vidal"
npm run worker:queue -- --dry-run              # list what would be queued, without writing anything
npm run worker:retry -- --job <job-id>         # requeue a FAILED job
```

## Running with Docker

```bash
docker build -t marine-data-worker .
docker run --env-file .env \
  -v marine-data-cache:/var/lib/marine-data-worker/cache \
  -v marine-data-work:/var/lib/marine-data-worker/work \
  marine-data-worker

# one-off commands:
docker run --env-file .env marine-data-worker node dist/cli/runOnce.js
docker run --env-file .env marine-data-worker node dist/cli/queue.js --country AU
```

Mount the cache volume persistently in production — it's what makes the spatial source
cache useful across worker restarts/redeploys (see docs for details).

## Scaling

Run as many instances of `npm run worker` (or the Docker image) as you want — job claiming
is done via a `FOR UPDATE SKIP LOCKED`-backed Postgres RPC (`claim_next_bathymetry_job`),
so 1 worker or 100 workers polling concurrently can never process the same job twice. See
the "Horizontal scaling" section of the docs.

## Project layout

```
src/
  config.ts            env var loading/validation
  logger.ts            structured JSON logging
  types.ts             shared types (Job, LaunchSite, Provider interface, ...)
  db/                  Supabase access: job claiming/updates, launch site reads
  geo/                 coverage-polygon geometry
  providers/           BathymetryProvider interface + GEBCO impl + stubs for other sources
  cache/               spatial (PostGIS-backed) source cache
  pipeline/            clip / hillshade / contours / pmtiles / checksum / validate
  r2/                  Cloudflare R2 client + checksum-aware uploader
  worker/              job processor (full pipeline) + the polling loop
  cli/                 run / runOnce / queue / retry entry points
```

## What still needs real credentials/infra to actually run

- A live Supabase project with the `20260710000000_marine_data_worker_infra.sql` migration
  applied (adds `claim_next_bathymetry_job`, `find_covering_source_cache`,
  `store_source_cache_entry`, `marine_data_job_logs`, `marine_data_source_cache`, and the
  dataset-versioning columns on `bathymetry_jobs`/`launch_locations`) — this requires the
  PostGIS extension to be enabled on that project.
- Cloudflare R2 bucket + credentials.
- Network access to whichever bathymetry provider is configured (GEBCO's grid-extract
  endpoint by default — `GEBCOProvider` in `src/providers/gebco.ts` is the one part of this
  worker that talks to a specific external API; every other provider in
  `src/providers/stubs.ts` is an unimplemented placeholder until wired up for real).
