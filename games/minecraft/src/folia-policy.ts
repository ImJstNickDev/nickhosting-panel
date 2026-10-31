import { paperJavaMajor } from './paper-policy.js';

/** Folia is a Paper fork. Keep its baseline at least Paper's recommendation,
 * then honor any higher minimum from Fill or the Mojang version metadata. */
export function foliaJavaMajor(release: string, minimum: number, officialMajor?: number): number {
  return paperJavaMajor(release, minimum, officialMajor);
}
