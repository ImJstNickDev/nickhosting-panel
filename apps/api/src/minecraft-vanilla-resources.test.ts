import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getMinecraftVanillaResources } from './minecraft-vanilla-resources.js';

it('loads only installed release resources, bounds reads and follows atomic pack replacements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nh-vanilla-'));
  const directory = join(root, 'minecraft-vanilla-resources');
  const asset = 'assets/minecraft/models/item/diamond_helmet.json';
  const bundle = (release: string, body: string) =>
    JSON.stringify({
      format: 1,
      release,
      clientSha1: 'c'.repeat(40),
      assets: { [asset]: Buffer.from(body).toString('base64') },
    });
  try {
    await mkdir(directory);
    const target = join(directory, '1.16.5.json');
    expect(await getMinecraftVanillaResources('1.16.5', root)).toBeUndefined();
    await writeFile(target, bundle('1.16.5', 'one'));
    const first = await getMinecraftVanillaResources('1.16.5', root);
    expect(first?.has(asset)).toBe(true);
    expect(await first?.read(asset, 2)).toBeUndefined();
    expect(await first?.read(asset, 3)).toEqual(Buffer.from('one'));
    expect(await getMinecraftVanillaResources('1.16.5', root)).toBe(first);
    await writeFile(join(directory, 'next'), bundle('1.16.5', 'two'));
    await rename(join(directory, 'next'), target);
    const next = await getMinecraftVanillaResources('1.16.5', root);
    expect(next?.revision).not.toBe(first?.revision);
    expect(await next?.read(asset, 3)).toEqual(Buffer.from('two'));
    expect(await getMinecraftVanillaResources('1.20.1', root)).toBeUndefined();
    expect(await getMinecraftVanillaResources('../1.16.5', root)).toBeUndefined();
    await symlink(target, join(directory, '1.20.1.json'));
    await expect(getMinecraftVanillaResources('1.20.1', root)).rejects.toMatchObject({
      code: 'integration_unavailable',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
