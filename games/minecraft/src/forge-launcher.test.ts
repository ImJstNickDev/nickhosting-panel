import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { verifyForgeInstalledJar } from './forge-launcher.js';
import type { ResolvedMinecraftRuntime } from './runtime.js';

const runtime: ResolvedMinecraftRuntime = {
  profile: 'forge',
  release: '1.16.5',
  releaseType: 'release',
  javaMajor: 8,
  loaderVersion: '36.2.42',
  artifacts: [],
  installation: { kind: 'forge-installer', args: ['--installServer'] },
  evidence: [],
};
async function launcher(
  args = '--gameDir . --launchTarget fmlserver --fml.forgeVersion 36.2.42 --fml.mcVersion 1.16.5',
  main = 'net.minecraftforge.server.ServerMain',
) {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      `Manifest-Version: 1.0\r\nMain-Class: ${main}\r\nServerLaunchArgs: ${args.replace('36.2.42', '36.2.\r\n 42')}\r\n\r\n`,
    ),
    'META-INF/MANIFEST.MF',
  );
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
it('validates the generated pre-modules launcher from folded manifest metadata', async () => {
  await expect(verifyForgeInstalledJar(await launcher(), runtime)).resolves.toBeUndefined();
  for (const args of [
    '--launchTarget fmlserver --fml.forgeVersion 36.2.41 --fml.mcVersion 1.16.5',
    '--launchTarget fmlserver --fml.forgeVersion 36.2.42 --fml.mcVersion 1.16.4',
    '--launchTarget fmlclient --fml.forgeVersion 36.2.42 --fml.mcVersion 1.16.5',
    '--launchTarget fmlserver --fml.forgeVersion 36.2.42 --fml.mcVersion 1.16.5 --fml.mcVersion 1.16.5',
  ])
    await expect(verifyForgeInstalledJar(await launcher(args), runtime)).rejects.toThrow();
  await expect(
    verifyForgeInstalledJar(
      await launcher(undefined, 'net.minecraftforge.installer.SimpleInstaller'),
      runtime,
    ),
  ).rejects.toThrow();
});
it('uses the pinned universal digest for old Forge, never accepts the Vanilla or installer JAR', async () => {
  const bytes = Buffer.from('fixture exact installed universal jar');
  const legacy = {
    ...runtime,
    release: '1.12.2',
    loaderVersion: '14.23.5.2860',
    installation: {
      ...runtime.installation,
      serverJarSha1: createHash('sha1').update(bytes).digest('hex'),
    },
  };
  await expect(verifyForgeInstalledJar(bytes, legacy)).resolves.toBeUndefined();
  await expect(verifyForgeInstalledJar(Buffer.from('other'), legacy)).rejects.toThrow();
  await expect(
    verifyForgeInstalledJar(bytes, { ...legacy, installation: runtime.installation }),
  ).rejects.toThrow();
  await expect(verifyForgeInstalledJar(bytes, { ...legacy, release: '1.21.4' })).rejects.toThrow();
});
