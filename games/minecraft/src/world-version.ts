import catalog from './world-data-versions.json' with { type: 'json' };

/** Exact upstream world-format metadata, bundled with the integration. No network,
 * per-server attestation or inference from the world being imported. The catalog
 * excludes upstream's synthetic pre-15w32a numbers: those worlds lack DataVersion. */
const versions = new Map<string, number>(Object.entries(catalog.versions));

export function minecraftWorldDataVersion(release: string): number | undefined {
  return versions.get(release);
}
