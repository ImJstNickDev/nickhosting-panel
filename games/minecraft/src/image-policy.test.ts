import { describe, expect, it } from 'vitest';
import { minecraftRuntimeImagePolicy, resolveMinecraftImage } from './image-policy.js';
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
      'ghcr.io/ptero-eggs/yolks:java_21',
    );
    expect(resolveMinecraftImage(runtime(17, '1.20.1', 'vanilla')).image).toBe(
      'ghcr.io/pterodactyl/yolks:java_17',
    );
  });
  it('does not guess future or unavailable major tags', () => {
    for (const major of [26, 20, 0, Number.NaN])
      expect(() => resolveMinecraftImage(runtime(major))).toThrow();
  });
  it('uses only the FabricUpdated image family and declared majors for Fabric', () => {
    for (const major of [8, 11, 16, 17, 21, 22, 23, 24, 25])
      expect(resolveMinecraftImage(runtime(major, 'fixture', 'fabric')).image).toBe(
        `ghcr.io/ptero-eggs/yolks:java_${major}`,
      );
    for (const major of [18, 19, 20, 26])
      expect(() => resolveMinecraftImage(runtime(major, 'fixture', 'fabric'))).toThrow();
  });
  it('uses Forge Enhanced Java 8/16/17/21 images without guessing unverified requirements', () => {
    for (const major of [8, 16, 17, 21])
      expect(resolveMinecraftImage(runtime(major, 'fixture', 'forge')).image).toBe(
        `ghcr.io/ptero-eggs/yolks:java_${major}`,
      );
    for (const major of [11, 18, 20, 25, 26])
      expect(() => resolveMinecraftImage(runtime(major, 'fixture', 'forge'))).toThrow();
  });
  it('declares image policies for all profiles without advertising verified versions', () => {
    for (const profile of minecraftManifest.runtimes) {
      expect(profile.imagePolicy?.mode).toBe('rules');
      expect(profile.imagePolicy).toEqual(
        minecraftRuntimeImagePolicy(profile.id as ResolvedMinecraftRuntime['profile']),
      );
      expect(profile.supportedGameVersions).toEqual([]);
    }
  });
  it('uses only the PaperUpdated image family and its explicitly advertised majors', () => {
    for (const major of [8, 11, 16, 17, 21, 22, 25])
      expect(resolveMinecraftImage(runtime(major, 'fixture', 'paper')).image).toBe(
        `ghcr.io/ptero-eggs/yolks:java_${major}`,
      );
    for (const major of [18, 19, 20, 23, 24, 26])
      expect(() => resolveMinecraftImage(runtime(major, 'fixture', 'paper'))).toThrow();
  });
});
