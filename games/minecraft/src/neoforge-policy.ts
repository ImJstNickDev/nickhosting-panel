import { DomainError } from '@nickhosting/core';

/** Explicit installer scope; future version schemes require a reviewed contract. */
export function neoforgeSupportedRelease(release: string): boolean {
  return (
    /^1\.20\.[1-9]\d*$/.test(release) ||
    /^1\.21(?:\.[1-9]\d*)?$/.test(release) ||
    /^26\.[1-9]\d*(?:\.[1-9]\d*)?$/.test(release)
  );
}

/** NeoForge's published version identifies the exact Minecraft minor/patch.
 * Calendar versions follow https://docs.neoforged.net/docs/gettingstarted/versioning/.
 * Snapshot coordinates containing '+' are intentionally excluded: the supplied
 * egg interpolates them unescaped into grep -E and cannot select their installer.
 * 1.20.1 predates the modern numbering scheme and uses the forge artifact. */
export function neoforgeMinecraftVersion(version: string): string | undefined {
  if (/^1\.20\.1-47\.1\.\d+$/.test(version)) return '1.20.1';
  const calver = /^(26)\.([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta)?$/.exec(version);
  if (calver) return `${calver[1]}.${calver[2]}${calver[3] === '0' ? '' : `.${calver[3]}`}`;
  const match = /^(20|21)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta)?$/.exec(version);
  if (!match) return undefined;
  const release = `1.${match[1]}${match[2] === '0' ? '' : `.${match[2]}`}`;
  return release !== '1.20.1' && neoforgeSupportedRelease(release) ? release : undefined;
}

export function neoforgeArtifact(release: string): 'forge' | 'neoforge' {
  if (!neoforgeSupportedRelease(release))
    throw new DomainError('integration_unavailable', 503, {
      reason: 'neoforge_release_unsupported',
    });
  return release === '1.20.1' ? 'forge' : 'neoforge';
}

/** https://docs.neoforged.net/user/docs/: Java 21 from Minecraft 1.20.5. */
export function neoforgeJavaMajor(release: string, officialMajor?: number): number {
  if (
    !neoforgeSupportedRelease(release) ||
    (officialMajor !== undefined &&
      (!Number.isInteger(officialMajor) || officialMajor < 8 || officialMajor > 100))
  )
    throw new DomainError('integration_unavailable', 503, {
      reason: 'neoforge_release_unsupported',
    });
  const [, minor = 0, patch = 0] = release.split('.').map(Number);
  return Math.max(
    release.startsWith('26.') ? 25 : minor === 20 && patch <= 4 ? 17 : 21,
    officialMajor ?? 8,
  );
}
