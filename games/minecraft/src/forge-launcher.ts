import { createHash } from 'node:crypto';
import { readArchiveFile, visitArchive } from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import { forgeEnhancedSupportedRelease, forgeUsesArguments } from './forge-policy.js';
import type { ResolvedMinecraftRuntime } from './runtime.js';

export const forgeInstalledJarMaxBytes = 64 * 1024 ** 2;
function mismatch(): never {
  throw new DomainError('conflict', 409, { reason: 'minecraft_forge_installation_mismatch' });
}

/** Run only at installation/restore receipt capture. Pre-1.13's output is the
 * unchanged Maven universal JAR renamed by the egg. Later jar-based versions
 * embed exact MC/Forge launch arguments in their small server launcher's manifest.
 * Neither path enumerates or downloads the installed library tree. */
export async function verifyForgeInstalledJar(
  bytes: Uint8Array,
  runtime: ResolvedMinecraftRuntime,
): Promise<void> {
  if (
    runtime.profile !== 'forge' ||
    runtime.installation.kind !== 'forge-installer' ||
    !forgeEnhancedSupportedRelease(runtime.release) ||
    forgeUsesArguments(runtime.release) ||
    !runtime.loaderVersion ||
    bytes.byteLength > forgeInstalledJarMaxBytes ||
    !bytes.byteLength
  )
    mismatch();
  const minor = Number(runtime.release.split('.')[1]);
  if (minor <= 12) {
    const expected = runtime.installation.serverJarSha1;
    if (
      !expected ||
      !/^[a-f0-9]{40}$/.test(expected) ||
      createHash('sha1').update(bytes).digest('hex') !== expected
    )
      mismatch();
    return;
  }
  let manifest: string | undefined;
  await visitArchive(
    bytes,
    async (entry) => {
      if (entry.path === 'META-INF/MANIFEST.MF') {
        if (manifest !== undefined) mismatch();
        manifest = (await readArchiveFile(entry, 512 * 1024)).toString('utf8');
      }
    },
    {
      maxArchiveBytes: forgeInstalledJarMaxBytes,
      maxExpandedBytes: 256 * 1024 ** 2,
      maxFileBytes: 64 * 1024 ** 2,
      maxEntries: 50_000,
      maxCompressionRatio: 200,
    },
  );
  const main = manifest?.replace(/\r?\n /g, '').split(/\r?\n\r?\n/)[0];
  const field = (name: string) => {
    const lines = main?.split(/\r?\n/).filter((line) => line.startsWith(`${name}: `)) ?? [];
    return lines.length === 1 ? lines[0]?.slice(name.length + 2) : undefined;
  };
  if (field('Main-Class') !== 'net.minecraftforge.server.ServerMain') mismatch();
  const tokens = field('ServerLaunchArgs')?.split(/\s+/) ?? [];
  const argument = (flag: string) => {
    const indices = tokens.flatMap((token, index) => (token === flag ? [index] : []));
    return indices.length === 1 ? tokens[(indices[0] ?? -1) + 1] : undefined;
  };
  if (
    argument('--fml.mcVersion') !== runtime.release ||
    argument('--fml.forgeVersion') !== runtime.loaderVersion.split('-')[0] ||
    argument('--launchTarget') !== 'fmlserver'
  )
    mismatch();
}
