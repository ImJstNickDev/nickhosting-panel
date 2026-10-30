import { readArchiveFile, visitArchive } from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import { parseMinecraftProperties } from './management.js';

export const fabricInstalledLauncherMaxBytes = 64 * 1024 ** 2;

/** Recognize both installer layouts: <=0.12.5 embeds its libraries, later
 * launchers reference libraries through their manifest. This is an installation
 * receipt check, not signed evidence of gameplay or library compatibility.
 * https://github.com/FabricMC/fabric-installer/blob/master/src/main/java/net/fabricmc/installer/server/ServerInstaller.java */
export async function verifyFabricInstalledLauncher(bytes: Uint8Array): Promise<void> {
  let manifest: string | undefined;
  let properties: string | undefined;
  await visitArchive(
    bytes,
    async (entry) => {
      if (entry.path === 'META-INF/MANIFEST.MF')
        manifest = (await readArchiveFile(entry, 256 * 1024)).toString('utf8');
      if (entry.path === 'fabric-server-launch.properties')
        properties = (await readArchiveFile(entry, 64 * 1024)).toString('utf8');
    },
    {
      maxArchiveBytes: fabricInstalledLauncherMaxBytes,
      maxExpandedBytes: 256 * 1024 ** 2,
      maxFileBytes: 64 * 1024 ** 2,
      maxEntries: 50_000,
      maxCompressionRatio: 200,
    },
  );
  const unfolded = manifest?.replace(/\r?\n /g, '');
  const mainClass = unfolded?.match(/^Main-Class: ([^\r\n]+)$/m)?.[1];
  const launchClass = properties && parseMinecraftProperties(properties)['launch.mainClass'];
  if (
    !mainClass ||
    !/^net\.fabricmc\.loader\.(?:impl\.)?launch\.server\.FabricServerLauncher$/.test(mainClass) ||
    !launchClass ||
    (!/^net\.fabricmc\.[A-Za-z0-9.$_]+$/.test(launchClass) &&
      launchClass !== 'net.minecraft.launchwrapper.Launch')
  )
    throw new DomainError('conflict');
}
