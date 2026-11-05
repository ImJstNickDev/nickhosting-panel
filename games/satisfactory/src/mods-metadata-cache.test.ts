import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareSatisfactoryMods } from './mods.js';
import {
  persistSatisfactoryMetadataCache,
  seedSatisfactoryMetadataCache,
} from './mods-metadata-cache.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const identity = {
  executableSha256: 'a'.repeat(64),
  gameBuild: 513885,
  targets: ['LinuxServer' as const],
};
const lock = {
  version: 1 as const,
  mods: {
    Example: {
      version: '1.2.3',
      dependencies: {},
      targets: { LinuxServer: { hash: 'b'.repeat(64), link: 'https://api.ficsit.app/mod.zip' } },
    },
  },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nh-meta-cache-'));
  roots.push(root);
  const source = join(root, 'native');
  await mkdir(source);
  await writeFile(join(source, 'registry.db'), 'native-main');
  await writeFile(join(source, 'registry.db-wal'), 'native-wal');
  const stage = join(root, 'stage');
  await persistSatisfactoryMetadataCache({
    stagingRoot: root,
    sourceDirectory: source,
    destinationDirectory: join(stage, 'metadata-cache'),
    identity,
    lock,
    capturedAt: 100000,
    maximumBytes: 64 * 1024 ** 2,
  });
  return {
    root,
    stage,
    options: {
      stagingRoot: root,
      sourceDirectories: [stage],
      destinationDirectory: join(root, 'next/cache'),
      identity,
      selection: [{ reference: 'Example', version: '>=1.2.3' }],
      maximumBytes: 64 * 1024 ** 2,
      now: 110000,
    },
  };
}
describe('bounded trusted native metadata snapshots', () => {
  it('preserves DB and WAL in private copies with the original freshness timestamp', async () => {
    const f = await fixture();
    expect(await seedSatisfactoryMetadataCache({ ...f.options, maximumBytes: 1_048_576 })).toEqual({
      capturedAt: 100000,
    });
    expect(await readFile(join(f.options.destinationDirectory, 'registry.db-wal'), 'utf8')).toBe(
      'native-wal',
    );
    await writeFile(join(f.options.destinationDirectory, 'registry.db'), 'private-mutated');
    expect(await readFile(join(f.stage, 'metadata-cache/registry.db'), 'utf8')).toBe('native-main');
  });
  it('misses expired, changed-build, changed-CLI, changed-target and uncovered constraints', async () => {
    const f = await fixture();
    for (const options of [
      { now: 160000 },
      { identity: { ...identity, gameBuild: 1 } },
      { identity: { ...identity, executableSha256: 'c'.repeat(64) } },
      { identity: { ...identity, targets: ['Windows' as const] } },
      { selection: [{ reference: 'Missing', version: '*' }] },
      { selection: [{ reference: 'Example', version: '>=2.0.0' }] },
    ])
      expect(await seedSatisfactoryMetadataCache({ ...f.options, ...options })).toBeNull();
  });
  it.each(['corrupt', 'symlink'])('discards incomplete metadata when WAL is %s', async (kind) => {
    const f = await fixture();
    const path = join(f.stage, 'metadata-cache/registry.db-wal');
    if (kind === 'corrupt') await writeFile(path, 'bad');
    else {
      await rm(path);
      await symlink('/etc/passwd', path);
    }
    expect(await seedSatisfactoryMetadataCache(f.options)).toBeNull();
    expect(await readdir(f.options.destinationDirectory)).toEqual([]);
  });
  it('retries a failed native offline attempt with a clean online work tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-meta-retry-'));
    roots.push(root);
    const executable = join(root, 'ficsit');
    await writeFile(executable, 'fixture');
    const base = {
      executable,
      executableSha256: createHash('sha256').update('fixture').digest('hex'),
      stagingRoot: root,
      selection: [{ reference: 'Example', version: '>=1.2.3' }],
      versionPath: 'Engine/Binaries/Linux/FactoryServer-Linux-Shipping.version' as const,
      versionFile: Buffer.from(JSON.stringify({ Changelist: 513885 })),
      launcherFile: Buffer.from('#!/bin/sh\n'),
    };
    const writeNative = async (cwd: string) => {
      await mkdir(join(cwd, 'cache'), { recursive: true });
      await writeFile(join(cwd, 'cache/registry.db'), 'native-db');
      await writeFile(
        join(cwd, 'game/FactoryGame/Mods/nick_hosting-lock.json'),
        JSON.stringify(lock),
      );
    };
    const first = join(root, 'first');
    await prepareSatisfactoryMods({
      ...base,
      outputDirectory: first,
      metadataCache: { sourceDirectories: [] },
      run: async (_b, args, cwd) => {
        expect(args).not.toContain('--offline');
        await writeNative(cwd);
      },
    });
    let attempts = 0;
    const result = await prepareSatisfactoryMods({
      ...base,
      outputDirectory: join(root, 'second'),
      metadataCache: { sourceDirectories: [first] },
      run: async (_b, args, cwd) => {
        attempts++;
        if (attempts === 1) {
          expect(args).toContain('--offline');
          await writeFile(join(cwd, 'game/FactoryGame/Mods/partial'), 'untrusted');
          await writeFile(join(cwd, 'config.yaml'), 'api-base: http://untrusted.invalid');
          await writeFile(join(cwd, 'state/profiles.json'), 'untrusted');
          throw new Error('offline resolver failed');
        }
        expect(args).not.toContain('--offline');
        await expect(readFile(join(cwd, 'config.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
          JSON.parse(await readFile(join(cwd, 'state/profiles.json'), 'utf8')).profiles.NickHosting
            .mods.Example.version,
        ).toBe('>=1.2.3');
        expect(await readdir(join(cwd, 'game/FactoryGame/Mods'))).toEqual([]);
        await expect(readFile(join(cwd, 'cache/registry.db'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await writeNative(cwd);
      },
    });
    expect(attempts).toBe(2);
    expect(result.metadataCacheUsed).toBe(false);
    const refreshed = await prepareSatisfactoryMods({
      ...base,
      outputDirectory: join(root, 'fresh'),
      metadataCache: { sourceDirectories: [first], forceRefresh: true },
      run: async (_b, args, cwd) => {
        expect(args).not.toContain('--offline');
        await writeNative(cwd);
      },
    });
    expect(refreshed.metadataCacheUsed).toBe(false);
    let abortedAttempts = 0;
    await expect(
      prepareSatisfactoryMods({
        ...base,
        outputDirectory: join(root, 'aborted'),
        metadataCache: { sourceDirectories: [first] },
        run: async () => {
          abortedAttempts++;
          throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
        },
      }),
    ).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(abortedAttempts).toBe(1);
  });
});
