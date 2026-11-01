import { DomainError } from '@nickhosting/core';

/** Paper's recommended Java baselines, independently of Vanilla's requirements.
 * https://docs.papermc.io/paper/getting-started/#requirements
 * Historical Fill metadata can declare Java 6; supported images start at Java 8.
 * Newer provider or Mojang requirements always take precedence over this baseline. */
export function paperJavaMajor(release: string, minimum: number, officialMajor?: number): number {
  if (
    !Number.isInteger(minimum) ||
    minimum < 6 ||
    minimum > 100 ||
    (officialMajor !== undefined &&
      (!Number.isInteger(officialMajor) || officialMajor < 6 || officialMajor > 100))
  )
    throw new DomainError('integration_unavailable', 503, { reason: 'minecraft_java_unknown' });
  let recommended = 8;
  if (/^\d+\.\d+(?:\.\d+)?$/.test(release)) {
    const [major = 0, minor = 0, patch = 0] = release.split('.').map(Number);
    if (major > 26 || (major === 26 && minor >= 1)) recommended = 25;
    else if (major === 1) {
      if (minor === 20 || (minor === 21 && patch <= 11)) recommended = 21;
      else if (minor >= 17 && minor <= 19) recommended = 17;
      else if (minor === 16 && patch === 5) recommended = 16;
      else if (minor >= 12 && (minor < 16 || patch <= 4)) recommended = 11;
    }
  }
  return Math.max(recommended, minimum, officialMajor ?? 8);
}
