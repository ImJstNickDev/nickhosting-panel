import { readArchiveFile, visitArchive } from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';

export const quiltInstalledLauncherMaxBytes = 512 * 1024;

/** Quilt installer 0.15.1 generates a manifest-only launcher. Its ZIP timestamps
 * and classpath order vary; every executable target must match pinned metadata. */
export async function verifyQuiltInstalledLauncher(
  bytes: Uint8Array,
  libraryPaths: readonly string[],
): Promise<void> {
  let manifest: string | undefined;
  let entries = 0;
  await visitArchive(
    bytes,
    async (entry) => {
      entries++;
      if (entry.path !== 'META-INF/MANIFEST.MF' || manifest !== undefined)
        throw new DomainError('conflict');
      manifest = (await readArchiveFile(entry, 256 * 1024)).toString('utf8');
    },
    {
      maxArchiveBytes: quiltInstalledLauncherMaxBytes,
      maxExpandedBytes: quiltInstalledLauncherMaxBytes,
      maxFileBytes: 256 * 1024,
      maxEntries: 8,
      maxCompressionRatio: 200,
    },
  );
  if (entries !== 1 || !manifest) throw new DomainError('conflict');
  const fields = new Map<string, string>();
  for (const line of manifest.replace(/\r?\n /g, '').split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([A-Za-z-]+): ([^\r\n]+)$/.exec(line);
    if (!match?.[1] || match[2] === undefined || fields.has(match[1]))
      throw new DomainError('conflict');
    fields.set(match[1], match[2]);
  }
  const paths = fields.get('Class-Path')?.split(' ') ?? [];
  if (
    fields.size !== 3 ||
    fields.get('Manifest-Version') !== '1.0' ||
    fields.get('Main-Class') !== 'org.quiltmc.loader.impl.launch.server.QuiltServerLauncher' ||
    libraryPaths.length === 0 ||
    libraryPaths.length > 128 ||
    new Set(libraryPaths).size !== libraryPaths.length ||
    paths.length !== libraryPaths.length ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !libraryPaths.includes(path))
  )
    throw new DomainError('conflict');
}
