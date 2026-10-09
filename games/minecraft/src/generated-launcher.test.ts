import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import {
  canonicalMinecraftJarSha256,
  minecraftGeneratedLauncherMaxBytes,
} from './generated-launcher.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function archive(
  options: {
    date?: Date;
    reverse?: boolean;
    extra?: string;
    manifest?: string;
    mode?: number;
    compress?: boolean;
  } = {},
) {
  const zip = new ZipFile();
  const entries = [
    [
      'META-INF/MANIFEST.MF',
      options.manifest ??
        'Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.loader.impl.launch.server.FabricServerLauncher\r\n\r\n',
    ],
    [
      'fabric-server-launch.properties',
      'launch.mainClass=net.fabricmc.loader.impl.launch.knot.KnotServer\n',
    ],
  ];
  if (options.reverse) entries.reverse();
  if (options.extra) entries.push([options.extra, 'unexpected']);
  for (const [path, value] of entries)
    zip.addBuffer(Buffer.from(value ?? ''), path ?? '', {
      mtime: options.date ?? new Date('2020-01-01T00:00:00Z'),
      compress: options.compress ?? false,
      mode: options.mode ?? 0o100644,
    });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
describe('strict generated Fabric launcher content identity', () => {
  it('ignores only ZIP packaging metadata and file order, supporting identical bytes from memory or disk', async () => {
    const first = await archive(),
      second = await archive({
        date: new Date('2026-01-01T00:00:00Z'),
        reverse: true,
        compress: true,
      });
    expect(first.equals(second)).toBe(false);
    const directory = await mkdtemp(join(tmpdir(), 'nh-launcher-'));
    dirs.push(directory);
    const path = join(directory, 'launcher.jar');
    await writeFile(path, first);
    expect(await canonicalMinecraftJarSha256(path)).toBe(await canonicalMinecraftJarSha256(second));
    expect(await canonicalMinecraftJarSha256(first)).not.toBe(
      await canonicalMinecraftJarSha256(
        await archive({ manifest: 'Manifest-Version: 1.0\r\nMain-Class: wrong\r\n\r\n' }),
      ),
    );
  });
  it('rejects shaded/extra executable entries, symlinks, corrupt ZIP bytes and oversized buffers', async () => {
    await expect(
      canonicalMinecraftJarSha256(await archive({ extra: 'untrusted.class' })),
    ).rejects.toThrow();
    await expect(canonicalMinecraftJarSha256(await archive({ mode: 0o120777 }))).rejects.toThrow();
    await expect(canonicalMinecraftJarSha256(Buffer.from('not a zip'))).rejects.toThrow();
    await expect(
      canonicalMinecraftJarSha256(Buffer.alloc(minecraftGeneratedLauncherMaxBytes + 1)),
    ).rejects.toThrow();
    const corrupt = await archive();
    const marker = corrupt.indexOf('Manifest-Version');
    corrupt[marker] = (corrupt[marker] ?? 0) ^ 1;
    await expect(canonicalMinecraftJarSha256(corrupt)).rejects.toThrow();
  });
  it('rejects duplicate canonical entries', async () => {
    await expect(
      canonicalMinecraftJarSha256(await archive({ extra: 'META-INF/MANIFEST.MF' })),
    ).rejects.toThrow();
  });
  it('rejects traversal headers and compressed expansion over the launcher budget', async () => {
    const malformed = await archive();
    const original = Buffer.from('META-INF/MANIFEST.MF');
    const unsafe = Buffer.from(`../${'x'.repeat(original.length - 3)}`);
    for (
      let offset = malformed.indexOf(original);
      offset >= 0;
      offset = malformed.indexOf(original, offset + original.length)
    )
      unsafe.copy(malformed, offset);
    await expect(canonicalMinecraftJarSha256(malformed)).rejects.toThrow();
    const oversized = await archive({ manifest: 'A'.repeat(1024 ** 2 + 1), compress: true });
    expect(oversized.length).toBeLessThan(minecraftGeneratedLauncherMaxBytes);
    await expect(canonicalMinecraftJarSha256(oversized)).rejects.toThrow();
  });
});
