import { describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { verifyFabricInstalledLauncher } from './fabric-launcher.js';

async function launcher(options: { shaded?: boolean; main?: string; launch?: string } = {}) {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      `Manifest-Version: 1.0\r\nMain-Class: ${options.main ?? 'net.fabricmc.loader.impl.launch.server.FabricServerLauncher'}\r\n\r\n`,
    ),
    'META-INF/MANIFEST.MF',
  );
  zip.addBuffer(
    Buffer.from(
      `launch.mainClass=${options.launch ?? 'net.fabricmc.loader.impl.launch.knot.KnotServer'}\n`,
    ),
    'fabric-server-launch.properties',
  );
  if (options.shaded)
    zip.addBuffer(
      Buffer.from('class bytes'),
      'net/fabricmc/loader/launch/server/FabricServerLauncher.class',
    );
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
describe('FabricUpdated generated launcher contract', () => {
  it('accepts modern library-reference and old shaded launchers without an exact-combination report', async () => {
    await expect(verifyFabricInstalledLauncher(await launcher())).resolves.toBeUndefined();
    await expect(
      verifyFabricInstalledLauncher(
        await launcher({
          shaded: true,
          main: 'net.fabricmc.loader.launch.server.FabricServerLauncher',
          launch: 'net.minecraft.launchwrapper.Launch',
        }),
      ),
    ).resolves.toBeUndefined();
  });
  it('rejects wrong entrypoints and files that are not launcher jars', async () => {
    await expect(
      verifyFabricInstalledLauncher(await launcher({ main: 'foreign.Main' })),
    ).rejects.toThrow();
    await expect(
      verifyFabricInstalledLauncher(await launcher({ launch: 'foreign.Main' })),
    ).rejects.toThrow();
    await expect(verifyFabricInstalledLauncher(Buffer.from('not a jar'))).rejects.toThrow();
  });
});
