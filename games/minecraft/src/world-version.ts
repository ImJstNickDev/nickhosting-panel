import catalog from './world-data-versions.json' with { type: 'json' };

/** Exact upstream world-format metadata, bundled with the integration. No network,
 * per-server attestation or inference from the world being imported. The catalog
 * excludes upstream's synthetic pre-15w32a numbers: those worlds lack DataVersion. */
const versions = new Map<string, number>(Object.entries(catalog.versions));
const releasesByVersion = new Map<number, string[]>();
for (const [release, dataVersion] of versions) {
  const releases = releasesByVersion.get(dataVersion) ?? [];
  releases.push(release);
  releasesByVersion.set(dataVersion, releases);
}

// Actual version.json / PrimaryLevelData writer inspected in the official client
// bd354bbd46835d7c7753e0b19c718777fb2386ba. Do not normalize names speculatively.
const displayNames = new Map([['26.1 Snapshot 1', '26.1-snapshot-1']]);

function releaseForName(name: string): string | undefined {
  return versions.has(name) ? name : displayNames.get(name);
}

export function minecraftWorldDataVersion(release: string): number | undefined {
  return versions.get(release);
}

/** Identify only an unambiguous catalog identity. An unfamiliar observed name
 * must not be overwritten with a guess based on its numeric data version. */
export function identifyMinecraftWorldRelease(
  dataVersion?: number,
  versionName?: string,
  versionSeries?: string,
): string | undefined {
  if (versionName) {
    const release = releaseForName(versionName);
    return release && (dataVersion === undefined || versions.get(release) === dataVersion)
      ? release
      : undefined;
  }
  if (versionSeries !== undefined && versionSeries !== 'main') return undefined;
  const candidates = dataVersion === undefined ? undefined : releasesByVersion.get(dataVersion);
  return candidates?.length === 1 ? candidates[0] : undefined;
}

export type MinecraftWorldCompatibility = 'verified' | 'incompatible' | 'unknown';

/** The same metadata assessment gates selection and labels discovery. It does
 * not certify every chunk or perform Minecraft's conversions. */
export function assessMinecraftWorldCompatibility(
  observation: {
    dataVersion?: number;
    versionName?: string;
    detectedRelease?: string;
    versionSeries?: string;
    storageVersion?: number;
  },
  target: { expectedDataVersion?: number; release?: string; expectedSeries?: string },
): MinecraftWorldCompatibility {
  if (target.expectedDataVersion === undefined) return 'unknown';
  if (
    observation.dataVersion !== undefined &&
    target.expectedDataVersion !== undefined &&
    observation.dataVersion !== target.expectedDataVersion
  )
    return 'incompatible';
  const observedRelease = observation.versionName
    ? releaseForName(observation.versionName)
    : observation.detectedRelease;
  if (observedRelease && target.release && observedRelease !== target.release)
    return 'incompatible';
  if (
    observation.versionSeries !== undefined &&
    target.expectedSeries !== undefined &&
    observation.versionSeries !== target.expectedSeries
  )
    return 'incompatible';
  if (
    observation.dataVersion === undefined ||
    (observation.storageVersion !== undefined && observation.storageVersion !== 19133) ||
    (observation.versionSeries !== undefined &&
      observation.versionSeries !== 'main' &&
      target.expectedSeries === undefined) ||
    (target.expectedSeries !== undefined &&
      target.expectedSeries !== 'main' &&
      observation.versionSeries === undefined)
  )
    return 'unknown';
  if (target.release) {
    if (observedRelease === target.release || observation.versionName === target.release)
      return 'verified';
    return 'unknown';
  }
  // Without a selected release, a shared number cannot disambiguate experimental
  // branches or releases sharing the same schema number.
  return releasesByVersion.get(observation.dataVersion)?.length === 1 ? 'verified' : 'unknown';
}
