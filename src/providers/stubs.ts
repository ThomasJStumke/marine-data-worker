import type { BathymetryProvider, SourceFetchRequest, SourceFetchResult } from "../types.js";

/**
 * Placeholder implementations demonstrating that BathymetryProvider is a
 * real, swappable interface — not something only GEBCO can satisfy. Wire one
 * of these up (implement fetchSource for real) and set
 * BATHYMETRY_PROVIDER=noaa|emodnet|commercial|local_hydro in the environment
 * to switch providers; no other worker code changes.
 */
class NotImplementedProvider implements BathymetryProvider {
  constructor(
    readonly name: string,
    readonly version: string,
  ) {}

  fetchSource(_req: SourceFetchRequest, _destDir: string): Promise<SourceFetchResult> {
    throw new Error(
      `Bathymetry provider "${this.name}" is not implemented yet. Implement fetchSource() in src/providers/${this.name}.ts and register it in src/providers/registry.ts.`,
    );
  }
}

export const NOAAProvider: BathymetryProvider = new NotImplementedProvider("noaa", "unversioned");
export const EMODnetProvider: BathymetryProvider = new NotImplementedProvider("emodnet", "unversioned");
export const CommercialChartsProvider: BathymetryProvider = new NotImplementedProvider("commercial", "unversioned");
export const LocalHydrographicOfficeProvider: BathymetryProvider = new NotImplementedProvider("local_hydro", "unversioned");
