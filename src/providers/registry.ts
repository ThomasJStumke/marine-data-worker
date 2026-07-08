import type { BathymetryProvider } from "../types.js";
import { GEBCOProvider } from "./gebco.js";
import { NOAAProvider, EMODnetProvider, CommercialChartsProvider, LocalHydrographicOfficeProvider } from "./stubs.js";

const providers: Record<string, BathymetryProvider> = {
  gebco: new GEBCOProvider(),
  noaa: NOAAProvider,
  emodnet: EMODnetProvider,
  commercial: CommercialChartsProvider,
  local_hydro: LocalHydrographicOfficeProvider,
};

/**
 * Single lookup point for bathymetry providers. The job processor and every
 * pipeline step downstream of it depend only on the `BathymetryProvider`
 * interface returned here — never on a concrete provider class — so adding a
 * new source is "implement BathymetryProvider + add one line here", not a
 * change to clip/hillshade/contour/pmtiles/upload logic.
 */
export function getProvider(name: string): BathymetryProvider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown bathymetry provider "${name}". Known providers: ${Object.keys(providers).join(", ")}`);
  }
  return provider;
}
