# Marine Data Worker — bundles Node.js, GDAL, Tippecanoe, and the PMTiles CLI
# into a single image so the whole clip -> hillshade -> contours -> PMTiles
# -> R2-upload pipeline runs from one container with no external GIS service.

# ── Build stage: compile TypeScript (needs devDependencies) ────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ───────────────────────────────────────────────────────────
# ubuntu-full, not ubuntu-small: the GEBCO grid is distributed as NetCDF, and
# ubuntu-small's GDAL build has no netCDF driver at all (confirmed via
# `gdalinfo --formats`) — it would fail to open GEBCO_LOCAL_GRID_PATH.
FROM ghcr.io/osgeo/gdal:ubuntu-full-3.9.0

ARG NODE_MAJOR=22
ARG PMTILES_VERSION=1.24.1

# The base image ships an Apache Arrow apt source (for GDAL's optional
# Arrow/Parquet driver) whose signing key is missing/expired upstream,
# which fails `apt-get update` outright. We don't install anything from
# it, so drop the source rather than weaken apt's signature checking.
RUN rm -f /etc/apt/sources.list.d/apache-arrow.sources

# Node.js + build tools for compiling Tippecanoe from source (no official
# Debian/Ubuntu package as of writing).
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg build-essential libsqlite3-dev zlib1g-dev git unzip \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Tippecanoe — vector tile generation (contours -> PMTiles)
RUN git clone --depth 1 https://github.com/felt/tippecanoe.git /tmp/tippecanoe \
    && cd /tmp/tippecanoe \
    && make -j"$(nproc)" \
    && make install \
    && rm -rf /tmp/tippecanoe

# pmtiles CLI — convert/inspect PMTiles archives (bathymetry raster -> PMTiles,
# and used by pipeline/validate.ts to sanity-check output before upload).
# Pin/adjust PMTILES_VERSION to match the current go-pmtiles release asset
# naming at https://github.com/protomaps/go-pmtiles/releases.
RUN curl -fsSL \
      "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" \
      -o /tmp/pmtiles.tar.gz \
    && tar -xzf /tmp/pmtiles.tar.gz -C /usr/local/bin pmtiles \
    && rm /tmp/pmtiles.tar.gz \
    && chmod +x /usr/local/bin/pmtiles

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Natural Earth 10m land polygons (public domain) — used by
# pipeline/landmask.ts to mask land out of hillshade/contours/contour-bands
# alongside the raw elevation cutoff. See landmask.ts for why both are needed.
COPY data ./data

ENV NODE_ENV=production
ENV CACHE_DIRECTORY=/var/lib/marine-data-worker/cache
ENV WORK_DIRECTORY=/var/lib/marine-data-worker/work
RUN mkdir -p "$CACHE_DIRECTORY" "$WORK_DIRECTORY"
VOLUME ["/var/lib/marine-data-worker/cache", "/var/lib/marine-data-worker/work"]

# Default command runs the continuous polling loop. Override for one-off
# CLI invocations, e.g.:
#   docker run --env-file .env marine-data-worker node dist/cli/runOnce.js
#   docker run --env-file .env marine-data-worker node dist/cli/queue.js --country ZA
CMD ["node", "dist/cli/run.js"]
