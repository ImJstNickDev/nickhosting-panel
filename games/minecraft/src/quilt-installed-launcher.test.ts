import { describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { verifyQuiltInstalledLauncher } from './quilt-installed-launcher.js';

const libraries = [
  'libraries/org/quiltmc/quilt-loader/0.30.2/quilt-loader-0.30.2.jar',
  'libraries/test/helper/1/helper-1.jar',
];
async function jar(
  options: { paths?: string[]; main?: string; extra?: boolean; duplicate?: boolean } = {},
) {
  const zip = new ZipFile();
  const cp = (options.paths ?? libraries).join(' ');
  zip.addBuffer(
    Buffer.from(
      `Manifest-Version: 1.0\r\nMain-Class: ${options.main ?? 'org.quiltmc.loader.impl.launch.server.QuiltServerLauncher'}\r\nClass-Path: ${cp.slice(0, 50)}\r\n ${cp.slice(50)}\r\n${options.duplicate ? 'Main-Class: evil.Main\r\n' : ''}\r\n`,
    ),
    'META-INF/MANIFEST.MF',
  );
  if (options.extra) zip.addBuffer(Buffer.from('unexpected bytecode'), 'evil/Main.class');
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
describe('Quilt generated launcher', () => {
  it('accepts exact classpath regardless of manifest wrapping/order', async () => {
    await expect(
      verifyQuiltInstalledLauncher(await jar({ paths: [...libraries].reverse() }), libraries),
    ).resolves.toBeUndefined();
  });
  it.each([
    { paths: [libraries[0] ?? ''] },
    { paths: [...libraries, 'https://evil.invalid/x.jar'] },
    { paths: [libraries[0] ?? '', libraries[0] ?? ''] },
    { main: 'evil.Main' },
    { extra: true },
    { duplicate: true },
  ])('rejects altered executable target %j', async (options) => {
    await expect(verifyQuiltInstalledLauncher(await jar(options), libraries)).rejects.toThrow();
  });
});
