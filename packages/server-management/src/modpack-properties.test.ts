import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMinecraftProperties } from '../../../games/minecraft/src/management.js';
import { mergeModpackProperties, prepareModpackProperties } from './modpack-properties.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture(pack: string, current: string | undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'nh-pack-properties-'));
  roots.push(directory);
  await writeFile(join(directory, 'server.properties'), pack);
  const list = vi.fn(async () =>
    current === undefined
      ? []
      : [
          {
            name: 'server.properties',
            kind: 'file' as const,
            size: Buffer.byteLength(current),
            modifiedAt: '2026-10-21T00:00:00Z',
          },
        ],
  );
  const read = vi.fn(async () => (current === undefined ? undefined : Buffer.from(current)));
  const files: FilemanReadService = {
    list,
    read,
    listMany: vi.fn(),
    readMany: vi.fn(),
    prepare: vi.fn(),
  };
  const staged = {
    directory,
    target: { minecraftVersion: '1.21.1', loader: 'fabric' as const, loaderVersion: '0.16.10' },
    files: [{ path: 'server.properties', size: Buffer.byteLength(pack), sha256: hash(pack) }],
    excludedFiles: 0,
  };
  return { directory, staged, files, list, read };
}
describe('modpack server.properties preparation', () => {
  it('merges validated gameplay while preserving authentication, ports and world identity/generation', () => {
    const current =
      '#Owner\nserver-port=28000\nserver-ip=0.0.0.0\nonline-mode=true\nrcon.password=private\nwhite-list=true\nlevel-name=world\nlevel-type=minecraft:normal\nlevel-seed=123\ngenerator-settings={}\npvp=true\n';
    const pack =
      'server-port=123\nserver-ip=other\nonline-mode=false\nrcon.password=stolen\nwhite-list=false\nlevel-name=other\nlevel-type=flat\nlevel-seed=999\ngenerator-settings=changed\npvp=false\ndifficulty=hard\nenable-command-block=true\n';
    const result = mergeModpackProperties(current, pack, '1.21.1');
    expect(result).toContain('#Owner');
    expect(parseMinecraftProperties(result)).toEqual({
      ...parseMinecraftProperties(current),
      pvp: 'false',
      difficulty: 'hard',
      'enable-command-block': 'true',
    });
  });
  it('preserves legacy enum representation and validates injected values', () => {
    expect(
      parseMinecraftProperties(
        mergeModpackProperties(
          'difficulty=1\ngamemode=0\n',
          'difficulty=3\ngamemode=1\n',
          '1.7.10',
        ),
      ),
    ).toEqual({ difficulty: '3', gamemode: '1' });
    expect(() => mergeModpackProperties('', 'enable-command-block=maybe', '1.21.1')).toThrow();
    expect(() => mergeModpackProperties('', 'max-players=-1', '1.21.1')).toThrow();
    expect(() =>
      mergeModpackProperties('', 'difficulty=hard\ndifficulty=easy', '1.21.1'),
    ).toThrow();
  });
  it('reseals merged private bytes and binds the baseline with one Fileman content read', async () => {
    const f = await fixture(
      'pvp=false\nenable-command-block=true\n',
      'online-mode=true\npvp=true\n',
    );
    const result = await prepareModpackProperties(f.staged, f.files);
    const content = await readFile(join(f.directory, 'server.properties'));
    expect(parseMinecraftProperties(content.toString())).toEqual({
      'online-mode': 'true',
      pvp: 'false',
      'enable-command-block': 'true',
    });
    expect(result.propertiesMerged).toBe(true);
    expect(result.propertiesSource).toEqual({
      size: Buffer.byteLength('online-mode=true\npvp=true\n'),
      modifiedAt: '2026-10-21T00:00:00Z',
    });
    expect(result.files[0]).toMatchObject({ size: content.length, sha256: hash(content) });
    expect(f.list).toHaveBeenCalledExactlyOnceWith('');
    expect(f.read).toHaveBeenCalledExactlyOnceWith({
      path: 'server.properties',
      maxBytes: 1024 * 1024,
      missing: 'allow',
    });
  });
  it('omits an unchanged or wholly protected pack properties file from publication', async () => {
    const f = await fixture('online-mode=false\n', 'online-mode=true\n');
    const result = await prepareModpackProperties(f.staged, f.files);
    expect(result.files).toEqual([]);
    expect(result.propertiesMerged).toBeUndefined();
  });
  it('supports missing initial properties without granting unreviewed fields', async () => {
    const f = await fixture('enable-command-block=true\nonline-mode=false\n', undefined);
    const result = await prepareModpackProperties(f.staged, f.files);
    expect(result.propertiesSource).toBeNull();
    expect(await readFile(join(f.directory, 'server.properties'), 'utf8')).toBe(
      'enable-command-block=true\n',
    );
  });
  it('rejects a changed source snapshot and a changed private staged file', async () => {
    const f = await fixture('pvp=false', 'pvp=true');
    f.read.mockResolvedValueOnce(Buffer.from('pvp=true\nchanged=true'));
    await expect(prepareModpackProperties(f.staged, f.files)).rejects.toThrow();
    const g = await fixture('pvp=false', 'pvp=true');
    await writeFile(join(g.directory, 'server.properties'), 'pvp=other');
    await expect(prepareModpackProperties(g.staged, g.files)).rejects.toThrow();
    expect(g.read).not.toHaveBeenCalled();
  });
  it('does no remote read when the pack has no properties file', async () => {
    const f = await fixture('pvp=false', 'pvp=true');
    expect((await prepareModpackProperties({ ...f.staged, files: [] }, f.files)).files).toEqual([]);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
});
