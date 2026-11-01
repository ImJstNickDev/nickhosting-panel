import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareSatisfactoryMods } from './mods.js';
import {
  persistSatisfactoryDownloadCache,
  seedSatisfactoryDownloadCache,
} from './mods-download-cache.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const bytes = Buffer.from('verified-public-mod-archive');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const key = 'Example_1.2.3_LinuxServer.zip';
const lock = {
  version: 1 as const,
  mods: {
    Example: {
      version: '1.2.3',
      dependencies: {},
      targets: { LinuxServer: { hash: sha256, link: 'https://api.ficsit.app/mod.zip' } },
    },
  },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nh-satisfactory-download-cache-'));
  roots.push(root);
  const native = join(root, 'native');
  await mkdir(native);
  await writeFile(join(native, key), bytes);
  const stage = join(root, 'job');
  return { root, native, stage, cache: join(stage, 'download-cache') };
}

describe('Satisfactory verified job-stage cache', () => {
  it('reuses only fresh-lock verified archives without sharing writable inodes', async () => {
    const f = await fixture();
    await writeFile(join(f.native, 'unrelated.zip'), 'untrusted');
    const cachedBytes = await persistSatisfactoryDownloadCache({
      stagingRoot: f.root,
      sourceDirectory: f.native,
      destinationDirectory: f.cache,
      lock,
    });
    expect(cachedBytes).toBeGreaterThan(bytes.length);
    await expect(readFile(join(f.native, key))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(f.cache)).sort()).toEqual([key, 'index.json'].sort());
    const destination = join(f.root, 'next/cache/downloadCache');
    expect(
      await seedSatisfactoryDownloadCache({
        stagingRoot: f.root,
        sourceDirectories: [f.stage],
        destinationDirectory: destination,
      }),
    ).toBe(bytes.length);
    await writeFile(join(destination, key), 'changed-private-copy');
    expect(await readFile(join(f.cache, key))).toEqual(bytes);
  });

  it('drops corrupt cached bytes instead of trusting index metadata', async () => {
    const f = await fixture();
    await persistSatisfactoryDownloadCache({
      stagingRoot: f.root,
      sourceDirectory: f.native,
      destinationDirectory: f.cache,
      lock,
    });
    await writeFile(join(f.cache, key), Buffer.alloc(bytes.length));
    const destination = join(f.root, 'next/cache');
    expect(
      await seedSatisfactoryDownloadCache({
        stagingRoot: f.root,
        sourceDirectories: [f.stage],
        destinationDirectory: destination,
      }),
    ).toBe(0);
    expect(await readdir(destination)).toEqual([]);
  });

  it('rejects published-hash mismatch and permits clean retry of the current cache stage', async () => {
    const f = await fixture();
    await expect(
      persistSatisfactoryDownloadCache({
        stagingRoot: f.root,
        sourceDirectory: f.native,
        destinationDirectory: f.cache,
        lock: {
          ...lock,
          mods: {
            Example: {
              ...lock.mods.Example,
              targets: {
                LinuxServer: { hash: '0'.repeat(64), link: 'https://api.ficsit.app/mod.zip' },
              },
            },
          },
        },
      }),
    ).rejects.toThrow('integrity_failed');
    await persistSatisfactoryDownloadCache({
      stagingRoot: f.root,
      sourceDirectory: f.native,
      destinationDirectory: f.cache,
      lock,
    });
    expect(await readFile(join(f.cache, key))).toEqual(bytes);
  });

  it('rejects an archive when fresh metadata has no verification hash', async () => {
    const f = await fixture();
    await expect(
      persistSatisfactoryDownloadCache({
        stagingRoot: f.root,
        sourceDirectory: f.native,
        destinationDirectory: f.cache,
        lock: {
          ...lock,
          mods: {
            Example: {
              ...lock.mods.Example,
              targets: { LinuxServer: { hash: '', link: 'https://api.ficsit.app/mod.zip' } },
            },
          },
        },
      }),
    ).rejects.toThrow('integrity_failed');
    expect(await readdir(f.cache)).toEqual([]);
  });

  it('does not read outside the staging root or through symbolic cache directories', async () => {
    const f = await fixture();
    await expect(
      seedSatisfactoryDownloadCache({
        stagingRoot: f.root,
        sourceDirectories: ['/etc'],
        destinationDirectory: join(f.root, 'next'),
      }),
    ).rejects.toThrow('cache_path_invalid');
    await mkdir(f.stage);
    await symlink(f.native, f.cache);
    await expect(
      seedSatisfactoryDownloadCache({
        stagingRoot: f.root,
        sourceDirectories: [f.stage],
        destinationDirectory: join(f.root, 'next'),
      }),
    ).rejects.toThrow('cache_path_invalid');
  });

  it('caps reusable archives at 512MiB and ignores unbounded or path-bearing indexes', async () => {
    const f = await fixture();
    const big = await open(join(f.native, key), 'w');
    await big.truncate(536_870_912);
    await big.close();
    expect(
      await persistSatisfactoryDownloadCache({
        stagingRoot: f.root,
        sourceDirectory: f.native,
        destinationDirectory: f.cache,
        lock,
      }),
    ).toBeLessThan(1024);
    await writeFile(
      join(f.cache, 'index.json'),
      JSON.stringify({ version: 1, entries: [{ key: '../escape', sha256, size: 1 }] }),
    );
    const destination = join(f.root, 'next');
    expect(
      await seedSatisfactoryDownloadCache({
        stagingRoot: f.root,
        sourceDirectories: [f.stage],
        destinationDirectory: destination,
      }),
    ).toBe(0);
    await writeFile(join(f.cache, 'index.json'), ' '.repeat(262_145));
    expect(
      await seedSatisfactoryDownloadCache({
        stagingRoot: f.root,
        sourceDirectories: [f.stage],
        destinationDirectory: destination,
      }),
    ).toBe(0);
    await expect(
      seedSatisfactoryDownloadCache({
        stagingRoot: f.root,
        sourceDirectories: [f.stage, f.stage, f.stage],
        destinationDirectory: destination,
      }),
    ).rejects.toThrow('sources_invalid');
  });

  it('seeds native preparation from a previous result while keeping the sandbox cache private', async () => {
    const f = await fixture();
    const executable = join(f.root, 'ficsit');
    await writeFile(executable, 'fixture');
    let calls = 0;
    const input = {
      executable,
      executableSha256: createHash('sha256').update('fixture').digest('hex'),
      stagingRoot: f.root,
      selection: [{ reference: 'Example', version: '>=1.2.3' }],
      versionPath: 'Engine/Binaries/Linux/UnrealServer-Linux-Shipping.version' as const,
      versionFile: Buffer.from(JSON.stringify({ Changelist: 513885 })),
      launcherFile: Buffer.from('#!/bin/sh\n'),
      run: async (_binary: string, args: string[], cwd: string) => {
        const nativeCache = join(cwd, 'cache/downloadCache');
        expect(args[args.indexOf('--cache-dir') + 1]).toBe(join(cwd, 'cache'));
        if (calls++) expect(await readFile(join(nativeCache, key))).toEqual(bytes);
        else await writeFile(join(nativeCache, key), bytes);
        await writeFile(
          join(cwd, 'game/FactoryGame/Mods/nick_hosting-lock.json'),
          JSON.stringify(lock),
        );
      },
    };
    const first = await prepareSatisfactoryMods({
      ...input,
      outputDirectory: f.stage,
      downloadCache: { sourceDirectories: [] },
    });
    expect(first.downloadCacheBytes).toBeGreaterThan(bytes.length);
    const second = await prepareSatisfactoryMods({
      ...input,
      outputDirectory: join(f.root, 'next'),
      downloadCache: { sourceDirectories: [f.stage] },
    });
    expect(second.lock).toEqual(first.lock);
    expect(calls).toBe(2);
    expect((await readdir(f.root)).some((name) => name.startsWith('satisfactory-mods-'))).toBe(
      false,
    );
  });
});
