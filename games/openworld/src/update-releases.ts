import type { OpenworldRelease } from './catalog-source.js';
import { openworldSupportsRuntime } from './version-policy.js';

// Openworld publishes previews as pre-a1.2.10-1. A final release follows
// every preview of the same version and precedes previews of the next version.
function components(version: string) {
  const match = /^(?:(pre)-)?(a|b|v?)(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/i.exec(version);
  if (!match || Boolean(match[1]) !== Boolean(match[6])) return undefined;
  const channel = match[2]?.toLowerCase();
  return [
    channel === 'a' ? 0 : channel === 'b' ? 1 : 2,
    ...match.slice(3, 6).map(Number),
    match[1] ? 0 : 1,
    Number(match[6] ?? 0),
  ];
}
export function compareOpenworldReleases(left: string, right: string) {
  const a = components(left);
  const b = components(right);
  if (!a || !b) return undefined;
  for (const [i, value] of a.entries()) {
    const difference = value - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
export function openworldUpgradeChoices(
  installedVersion: string,
  releases: readonly OpenworldRelease[],
) {
  return releases
    .filter(
      ({ version }) =>
        openworldSupportsRuntime(version) &&
        (compareOpenworldReleases(version, installedVersion) ?? 0) > 0,
    )
    .sort((a, b) => compareOpenworldReleases(b.version, a.version) ?? 0);
}
