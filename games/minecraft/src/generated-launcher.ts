import { hashArchiveFile, visitArchive } from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import { minecraftDigest } from './compatibility.js';

export const minecraftGeneratedLauncherMaxBytes = 2 * 1024 ** 2;

/** Only the modern two-file Fabric installer launcher is supported. Hash all
 * uncompressed entries, preserving their exact bytes and paths, but omit ZIP
 * timestamps/compression metadata that vary across otherwise identical installs.
 * Callers must separately prove the launch configuration and upstream libraries. */
export async function canonicalMinecraftJarSha256(path: string | Uint8Array): Promise<string> {
  const entries: { path: string; sha256: string; size: number }[] = [];
  await visitArchive(
    path,
    async (entry) => {
      if (!['META-INF/MANIFEST.MF', 'fabric-server-launch.properties'].includes(entry.path))
        throw new DomainError('validation_failed');
      entries.push({ path: entry.path, sha256: await hashArchiveFile(entry), size: entry.size });
    },
    {
      maxArchiveBytes: minecraftGeneratedLauncherMaxBytes,
      maxExpandedBytes: minecraftGeneratedLauncherMaxBytes,
      maxFileBytes: 1024 ** 2,
      maxEntries: 32,
      maxCompressionRatio: 200,
    },
  );
  if (entries.length !== 2) throw new DomainError('validation_failed');
  return minecraftDigest(entries.sort((a, b) => a.path.localeCompare(b.path)));
}
