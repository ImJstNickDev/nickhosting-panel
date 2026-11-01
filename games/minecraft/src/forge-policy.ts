import { DomainError } from '@nickhosting/core';

/** Scope of Forge Enhanced's supplied installer: earlier installers use a
 * minecraftforge-universal filename, while 26.x isn't in its unix_args branch.
 * This declares installation support, not a claim of real-client testing. */
export function forgeEnhancedSupportedRelease(release: string): boolean {
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(release);
  if (!match) return false;
  const minor = Number(match[1]);
  const patch = Number(match[2] ?? 0);
  return (minor > 7 || (minor === 7 && patch >= 2)) && minor <= 21;
}

/** Forge's historical Java baselines differ from Fabric's recommended Java 17
 * for 1.17. Old Forge/mods require Java 8, not a newer convenient default.
 * https://docs.minecraftforge.net/en/1.17.x/gettingstarted/
 * https://docs.minecraftforge.net/en/1.20.1/gettingstarted/
 * https://docs.minecraftforge.net/en/latest/gettingstarted/
 */
export function forgeJavaMajor(release: string, officialMajor?: number): number {
  if (
    !forgeEnhancedSupportedRelease(release) ||
    (officialMajor !== undefined &&
      (!Number.isInteger(officialMajor) || officialMajor < 8 || officialMajor > 100))
  )
    throw new DomainError('integration_unavailable', 503, { reason: 'forge_release_unsupported' });
  const [, minor = 0, patch = 0] = release.split('.').map(Number);
  const required =
    minor < 17 ? 8 : minor === 17 ? 16 : minor < 20 || (minor === 20 && patch <= 4) ? 17 : 21;
  return Math.max(required, officialMajor ?? 8);
}

export function forgeUsesArguments(release: string): boolean {
  return forgeEnhancedSupportedRelease(release) && Number(release.split('.')[1]) >= 17;
}
