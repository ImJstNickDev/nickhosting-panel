import { DomainError } from '@nickhosting/core';
import { paperJavaMajor } from './paper-policy.js';

/** Purpur is a Paper replacement and uses Paper's recommended Java baseline.
 * Mojang's actual release requirement takes precedence when newer.
 * https://purpurmc.org/docs/purpur/
 * https://docs.papermc.io/paper/getting-started/#requirements
 */
export function purpurJavaMajor(release: string, officialMajor?: number): number {
  if (!/^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(release))
    throw new DomainError('integration_unavailable', 503, { reason: 'minecraft_java_unknown' });
  return paperJavaMajor(release, 8, officialMajor);
}
