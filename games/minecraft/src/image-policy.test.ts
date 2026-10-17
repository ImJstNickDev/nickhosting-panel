import { describe, expect, it } from 'vitest';
import { resolveMinecraftImage } from './image-policy.js';
import { minecraftManifest } from './manifest.js';
import type { ResolvedMinecraftRuntime } from './runtime.js';

function runtime(
  javaMajor: number,
  release = '26.1',
  profile: ResolvedMinecraftRuntime['profile'] = 'vanilla',
): ResolvedMinecraftRuntime {
  return {
    release,
    releaseType: 'release',
    profile,
    javaMajor,
    artifacts: [],
    installation: { kind: 'server-jar', args: [] },
    evidence: [],
  };
}
describe('Minecraft integration-owned images', () => {
  it('selects Java 21 and 25 from resolved metadata without SemVer or release-name guessing', () => {
    expect(resolveMinecraftImage(runtime(21, '1.21.11')).image).toBe(
      'ghcr.io/pterodactyl/yolks:java_21',
    );
    expect(resolveMinecraftImage(runtime(25)).image).toBe('ghcr.io/pterodactyl/yolks:java_25');
    expect(resolveMinecraftImage(runtime(25, '26.1-snapshot-1')).image).toBe(
      'ghcr.io/pterodactyl/yolks:java_25',
    );
  });
  it('honors the resolved loader requirement rather than Vanilla release ranges', () => {
    expect(resolveMinecraftImage(runtime(21, '1.20.1', 'paper')).image).toBe(
      'ghcr.io/pterodactyl/yolks:java_21',
    );
    expect(resolveMinecraftImage(runtime(17, '1.20.1', 'vanilla')).image).toBe(
      'ghcr.io/pterodactyl/yolks:java_17',
    );
  });
  it('does not guess future or unavailable major tags', () => {
    for (const major of [26, 20, 0, Number.NaN])
      expect(() => resolveMinecraftImage(runtime(major))).toThrow();
  });
  it('declares image policies for all profiles without advertising verified versions', () => {
    for (const profile of minecraftManifest.runtimes) {
      expect(profile.imagePolicy?.mode).toBe('rules');
      expect(profile.supportedGameVersions).toEqual([]);
    }
  });
});
