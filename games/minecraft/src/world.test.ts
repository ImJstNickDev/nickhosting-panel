import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import * as contentProviders from '@nickhosting/content-providers';
import { DomainError } from '@nickhosting/core';
import { type NBT, writeUncompressed } from 'prismarine-nbt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import {
  discoverMinecraftWorlds,
  inspectMinecraftLevelDat,
  planMinecraftWorldReplacement,
  recoverMinecraftWorldStageLock,
  stageMinecraftWorld,
  validateMinecraftLevelDat,
} from './world.js';

function levelDat(version = 5000, release = '26.1', gzip = true): Buffer {
  const nbt: NBT = {
    type: 'compound',
    name: '',
    value: {
      Data: {
        type: 'compound',
        value: {
          DataVersion: { type: 'int', value: version },
          Version: {
            type: 'compound',
            value: {
              Id: { type: 'int', value: version },
              Name: { type: 'string', value: release },
            },
          },
        },
      },
    },
  };
  const bytes = writeUncompressed(nbt, 'big');
  return gzip ? gzipSync(bytes) : bytes;
}
function metadata(data: NBT['value']): Buffer {
  return gzipSync(
    writeUncompressed(
      { type: 'compound', name: '', value: { Data: { type: 'compound', value: data } } },
      'big',
    ),
  );
}
it('observes an actual bounded DataVersion without guessing while exact validation still rejects mismatches', () => {
  expect(
    inspectMinecraftLevelDat(levelDat(12345, 'future-release'), { release: 'future-release' }),
  ).toMatchObject({ dataVersion: 12345, versionName: 'future-release' });
  expect(() => validateMinecraftLevelDat(levelDat(12345), 5000)).toThrow();
  expect(() => inspectMinecraftLevelDat(levelDat(-1))).toThrow();
  expect(inspectMinecraftLevelDat(levelDat(), { release: '1.21.1' }).versionName).toBe('26.1');
  expect(() =>
    inspectMinecraftLevelDat(levelDat(), { limits: { maxUncompressedBytes: 16 } }),
  ).toThrow();
});
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function environment() {
  const parent = await mkdtemp(join(tmpdir(), 'nh-m4-world-'));
  temporary.push(parent);
  const root = join(parent, 'mountdata');
  await mkdir(root);
  return { root, parent };
}
async function makeZip(
  root: string,
  entries: Record<string, Buffer>,
  options: { mode?: number; compress?: boolean; largeRegion?: boolean } = {},
) {
  const path = join(root, 'archive.zip');
  const zip = new ZipFile();
  for (const [name, buffer] of Object.entries(entries))
    zip.addBuffer(buffer, name, {
      compress: options.compress ?? false,
      mode: options.mode ?? 0o100644,
    });
  if (options.largeRegion) {
    const chunk = Buffer.alloc(64 * 1024, 0x51);
    zip.addReadStream(
      Readable.from(
        (function* () {
          for (let i = 0; i < 256; i++) yield chunk;
        })(),
      ),
      'source/region/r.0.0.mca',
      { size: 16 * 1024 ** 2, compress: false },
    );
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path, { flags: 'wx' }));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, sha256: hash.digest('hex') };
}
function options(root: string, sha256: string) {
  return {
    mountdataRoot: root,
    jobId: 'job-one',
    targetWorld: 'imported',
    release: '26.1',
    expectedDataVersion: 5000,
    archiveSha256: sha256,
    diskPolicy: { minimumFreeBytes: 0, minimumFreePercent: 0 },
  };
}
function namedTag(type: number, name: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(Buffer.byteLength(name));
  return Buffer.concat([Buffer.from([type]), length, Buffer.from(name), payload]);
}
function rootWith(dataPayload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([10, 0, 0]), dataPayload, Buffer.from([0])]);
}

describe('bounded Java level.dat validation', () => {
  it.each([19132, 19133])(
    'recognizes legacy storage %s without inventing an exact release',
    (storage) => {
      const bytes = metadata({
        version: { type: 'int', value: storage },
        LevelName: { type: 'string', value: 'Old map' },
      });
      const observation = inspectMinecraftLevelDat(bytes);
      expect(observation).toMatchObject({ storageVersion: storage });
      expect(observation.dataVersion).toBeUndefined();
      expect(observation.versionName).toBeUndefined();
      expect(observation.detectedRelease).toBeUndefined();
      expect(() => validateMinecraftLevelDat(bytes, 4786, { release: '26.1' })).toThrow();
    },
  );
  it('recognizes markerless Alpha/Beta metadata using its typed core fields', () => {
    const legacy = {
      RandomSeed: { type: 'long' as const, value: [0, 123] as [number, number] },
      Time: { type: 'long' as const, value: [0, 0] as [number, number] },
      SpawnX: { type: 'int' as const, value: 0 },
      SpawnY: { type: 'int' as const, value: 64 },
      SpawnZ: { type: 'int' as const, value: 0 },
    };
    expect(inspectMinecraftLevelDat(metadata(legacy)).dataVersion).toBeUndefined();
    const { RandomSeed: _seed, ...insufficient } = legacy;
    expect(() => inspectMinecraftLevelDat(metadata(insufficient))).toThrow();
    expect(() => inspectMinecraftLevelDat(metadata({}))).toThrow();
  });
  it('preserves Series, Snapshot and 26.3 version history while resolving a known display alias', () => {
    const bytes = metadata({
      version: { type: 'int', value: 19133 },
      DataVersion: { type: 'int', value: 4764 },
      Version: {
        type: 'compound',
        value: {
          Id: { type: 'int', value: 4764 },
          Name: { type: 'string', value: '26.1 Snapshot 1' },
          Series: { type: 'string', value: 'main' },
          Snapshot: { type: 'byte', value: 1 },
        },
      },
      version_history: { type: 'list', value: { type: 'int', value: [3700, 4764] } },
    });
    expect(validateMinecraftLevelDat(bytes, 4764, { release: '26.1-snapshot-1' })).toMatchObject({
      dataVersion: 4764,
      versionName: '26.1 Snapshot 1',
      detectedRelease: '26.1-snapshot-1',
      storageVersion: 19133,
      versionSeries: 'main',
      snapshot: true,
      versionHistory: [3700, 4764],
    });
    expect(
      inspectMinecraftLevelDat(
        metadata({
          DataVersion: { type: 'int', value: 5023 },
          version_history: { type: 'list', value: { type: 'int', value: [] } },
        }),
      ),
    ).toMatchObject({ dataVersion: 5023, detectedRelease: '26.3', versionHistory: [] });
  });
  it('rejects malformed version metadata rather than converting it to an unknown version', () => {
    for (const extra of [
      { version: { type: 'string', value: '19133' } },
      { version: { type: 'int', value: 19132 } },
      { Version: { type: 'compound', value: { Id: { type: 'int', value: 1 } } } },
      { Version: { type: 'compound', value: { Snapshot: { type: 'byte', value: 2 } } } },
      { Version: { type: 'compound', value: { Series: { type: 'int', value: 1 } } } },
      { version_history: { type: 'intArray', value: [4786] } },
      { version_history: { type: 'list', value: { type: 'int', value: [0] } } },
      {
        version_history: {
          type: 'list',
          value: { type: 'int', value: new Array(4097).fill(4786) },
        },
      },
    ] as NBT['value'][])
      expect(() =>
        inspectMinecraftLevelDat(
          metadata({
            DataVersion: { type: 'int', value: 4786 },
            ...extra,
          }),
        ),
      ).toThrow();
  });
  it('accepts the empty TAG_End list representation of version history', () => {
    const version = Buffer.alloc(4);
    version.writeInt32BE(5023);
    const bytes = rootWith(
      namedTag(
        10,
        'Data',
        Buffer.concat([
          namedTag(3, 'DataVersion', version),
          namedTag(9, 'version_history', Buffer.from([0, 0, 0, 0, 0])),
          Buffer.from([0]),
        ]),
      ),
    );
    expect(inspectMinecraftLevelDat(bytes).versionHistory).toEqual([]);
  });
  it('does not infer a mainline release from a nameless experimental-series save', () => {
    const observed = inspectMinecraftLevelDat(
      metadata({
        DataVersion: { type: 'int', value: 4786 },
        Version: {
          type: 'compound',
          value: { Series: { type: 'string', value: 'custom-series' } },
        },
      }),
    );
    expect(observed.versionSeries).toBe('custom-series');
    expect(observed.detectedRelease).toBeUndefined();
  });
  it('validates gzip and raw big-endian NBT against exact trusted DataVersion, never release semver', () => {
    for (const gzip of [true, false]) {
      const bytes = levelDat(5000, '26.1', gzip);
      expect(validateMinecraftLevelDat(bytes, 5000, { release: '26.1' })).toMatchObject({
        dataVersion: 5000,
        versionName: '26.1',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      expect(() => validateMinecraftLevelDat(bytes, 5001)).toThrow();
      expect(() => validateMinecraftLevelDat(bytes, 5000, { release: '26.2' })).toThrow();
    }
  });
  it('rejects malformed/truncated/compressed bombs and trailing NBT documents', () => {
    for (const bytes of [
      Buffer.from('bad'),
      Buffer.from([0x1f, 0x8b, 0, 0]),
      levelDat(5000, '26.1', false).subarray(0, 25),
      Buffer.concat([levelDat(5000, '26.1', false), Buffer.from([0])]),
    ])
      expect(() => validateMinecraftLevelDat(bytes, 5000)).toThrow();
    expect(() =>
      validateMinecraftLevelDat(gzipSync(Buffer.alloc(100_000)), 5000, {
        limits: { maxUncompressedBytes: 100 },
      }),
    ).toThrow();
    expect(() =>
      validateMinecraftLevelDat(levelDat(), 5000, { limits: { maxCompressedBytes: 16 } }),
    ).toThrow();
  });
  it('rejects negative/huge arrays, recursion, duplicate names and prototype keys before decoding', () => {
    const integer = Buffer.alloc(4);
    integer.writeInt32BE(5000);
    const duplicate = Buffer.concat([
      namedTag(3, 'DataVersion', integer),
      namedTag(3, 'DataVersion', integer),
      Buffer.from([0]),
    ]);
    expect(() =>
      validateMinecraftLevelDat(rootWith(namedTag(10, 'Data', duplicate)), 5000),
    ).toThrow();
    expect(() =>
      validateMinecraftLevelDat(rootWith(namedTag(3, '__proto__', integer)), 5000),
    ).toThrow();
    expect(() =>
      validateMinecraftLevelDat(
        rootWith(namedTag(7, 'array', Buffer.from([255, 255, 255, 255]))),
        5000,
      ),
    ).toThrow();
    expect(() =>
      validateMinecraftLevelDat(
        rootWith(namedTag(11, 'array', Buffer.from([127, 255, 255, 255]))),
        5000,
      ),
    ).toThrow();
    let payload = Buffer.from([0]);
    for (let i = 0; i < 40; i++)
      payload = Buffer.concat([namedTag(10, 'nested', payload), Buffer.from([0])]);
    expect(() => validateMinecraftLevelDat(rootWith(payload), 5000)).toThrow();
    expect(() => validateMinecraftLevelDat(levelDat(), 5000, { limits: { maxTags: 2 } })).toThrow();
  });
  it('rejects Bedrock little-endian data and missing DataVersion without inventing compatibility', () => {
    const fixture: NBT = {
      type: 'compound',
      name: '',
      value: { Data: { type: 'compound', value: { DataVersion: { type: 'int', value: 5000 } } } },
    };
    expect(() => validateMinecraftLevelDat(writeUncompressed(fixture, 'little'), 5000)).toThrow();
    expect(() => validateMinecraftLevelDat(Buffer.from([10, 0, 0, 0]), 5000)).toThrow();
  });
});
describe('streamed isolated world staging', () => {
  it('reuses a trusted current source hash while inflating exact world bytes', async () => {
    const { root } = await environment();
    const region = randomBytes(2 * 1024 ** 2);
    const archive = await makeZip(
      root,
      {
        'source/level.dat': levelDat(),
        'source/region/r.0.0.mca': region,
      },
      { compress: true },
    );
    const verifiedArchive = {
      path: archive.path,
      sha256: archive.sha256,
      identity: await lstat(archive.path, { bigint: true }),
    };
    const staged = await stageMinecraftWorld(archive.path, {
      ...options(root, archive.sha256),
      verifiedArchive,
    });
    expect(staged.manifest).toHaveLength(2);
    expect(await readFile(join(staged.directory, 'imported/region/r.0.0.mca'))).toEqual(region);
    expect(staged.manifest.find((file) => file.path.endsWith('.mca'))?.sha256).toBe(
      createHash('sha256').update(region).digest('hex'),
    );
    for (const invalid of [
      { ...verifiedArchive, path: join(root, 'other.zip') },
      { ...verifiedArchive, sha256: 'a'.repeat(64) },
    ]) {
      await expect(
        stageMinecraftWorld(archive.path, {
          ...options(root, archive.sha256),
          verifiedArchive: invalid,
        }),
      ).rejects.toMatchObject({ details: { reason: 'minecraft_world_archive_changed' } });
    }
    await expect(
      stageMinecraftWorld(archive.path, {
        ...options(root, archive.sha256),
        verifiedArchive,
        limits: { maxArchiveBytes: 1024 },
      }),
    ).rejects.toMatchObject({ details: { reason: 'minecraft_world_archive_changed' } });
    await writeFile(archive.path, await readFile(archive.path));
    await expect(
      stageMinecraftWorld(archive.path, {
        ...options(root, archive.sha256),
        verifiedArchive,
      }),
    ).rejects.toMatchObject({ details: { reason: 'minecraft_world_archive_changed' } });
  });
  it('reserves only the validated world bytes before extraction and checks disk space in batches', async () => {
    const { root } = await environment();
    const level = levelDat();
    const entries: Record<string, Buffer> = {
      'source/level.dat': level,
      'source/session.lock': Buffer.from('ignored lock'),
    };
    for (let index = 0; index < 70; index++)
      entries[`source/region/r.${index}.mca`] = Buffer.from('region');
    const archive = await makeZip(root, entries);
    const reserve = vi.fn(async (bytes: number) => {
      expect(bytes).toBe(level.length + 70 * 6);
      await expect(lstat(join(root, 'world-staging/job-one/files'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    const disk = vi.spyOn(contentProviders, 'assertContentDiskSpace');
    try {
      const staged = await stageMinecraftWorld(archive.path, {
        ...options(root, archive.sha256),
        reserve,
      });
      expect(staged.manifest).toHaveLength(71);
      expect(reserve).toHaveBeenCalledOnce();
      // One full-budget check and bounded refreshes, never a syscall for every small file.
      expect(disk.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(disk.mock.calls.length).toBeLessThan(10);
      expect(disk.mock.calls[0]?.[1]).toBe(level.length + 70 * 6);
    } finally {
      disk.mockRestore();
    }
  });
  it('does not extract when reservation is denied or the verified source changes', async () => {
    const { root } = await environment();
    const archive = await makeZip(root, { 'source/level.dat': levelDat() });
    const denied = new Error('staging capacity unavailable');
    await expect(
      stageMinecraftWorld(archive.path, {
        ...options(root, archive.sha256),
        reserve: async () => {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
    await expect(lstat(join(root, 'world-staging/job-one/files'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      stageMinecraftWorld(archive.path, {
        ...options(root, archive.sha256),
        reserve: async () => {
          const bytes = await readFile(archive.path);
          await rm(archive.path);
          await writeFile(archive.path, bytes);
        },
      }),
    ).rejects.toMatchObject({ details: { reason: 'minecraft_world_archive_changed' } });
    await expect(lstat(join(root, 'world-staging/job-one/files'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('rejects corrupt entry bytes even when the outer archive hash matches', async () => {
    const { root } = await environment();
    const payload = Buffer.from('unchanged-region-fixture');
    const archive = await makeZip(root, {
      'source/level.dat': levelDat(),
      'source/region/r.0.0.mca': payload,
    });
    const bytes = await readFile(archive.path);
    const index = bytes.indexOf(payload);
    expect(index).toBeGreaterThan(0);
    bytes[index] = (bytes[index] ?? 0) ^ 1;
    await writeFile(archive.path, bytes);
    await expect(
      stageMinecraftWorld(
        archive.path,
        options(root, createHash('sha256').update(bytes).digest('hex')),
      ),
    ).rejects.toMatchObject({ details: { reason: 'minecraft_world_archive_integrity' } });
    await expect(lstat(join(root, 'world-staging/job-one/manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('does not publish a manifest if the source is edited during extraction', async () => {
    const { root } = await environment();
    const entries: Record<string, Buffer> = { 'source/level.dat': levelDat() };
    for (let index = 0; index < 40; index++)
      entries[`source/region/r.${index}.mca`] = Buffer.from('region');
    const archive = await makeZip(root, entries);
    const checkDisk = contentProviders.assertContentDiskSpace;
    let checks = 0;
    const disk = vi
      .spyOn(contentProviders, 'assertContentDiskSpace')
      .mockImplementation(async (...args) => {
        await checkDisk(...args);
        if (++checks !== 2) return;
        // Same bytes and size still constitute a concurrent source edit; CRC alone cannot see it.
        await writeFile(archive.path, await readFile(archive.path));
      });
    try {
      await expect(
        stageMinecraftWorld(archive.path, options(root, archive.sha256)),
      ).rejects.toMatchObject({ details: { reason: 'minecraft_world_archive_changed' } });
      await expect(lstat(join(root, 'world-staging/job-one/manifest.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      disk.mockRestore();
    }
  });
  it('rejects pre-existing symlinks below the cached staging directory boundary', async () => {
    const { root, parent } = await environment();
    const archive = await makeZip(root, {
      'source/level.dat': levelDat(),
      'source/region/r.0.0.mca': Buffer.from('region'),
    });
    const stagedWorld = join(root, 'world-staging/job-one/files/imported');
    const outside = join(parent, 'outside');
    await mkdir(stagedWorld, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(stagedWorld, 'region'));
    await expect(
      stageMinecraftWorld(archive.path, options(root, archive.sha256)),
    ).rejects.toMatchObject({ details: { reason: 'minecraft_world_stage_symlink' } });
    await expect(lstat(join(outside, 'r.0.0.mca'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('streams a 16MiB region file, preserves dimensions, discards ephemeral locks and verifies recovery', async () => {
    const { root } = await environment();
    const archive = await makeZip(
      root,
      {
        'source/level.dat': levelDat(),
        'source/session.lock': Buffer.from('ephemeral'),
        'source/dimensions/minecraft/the_nether/data/map.dat': Buffer.from('fixture'),
      },
      { largeRegion: true },
    );
    const staged = await stageMinecraftWorld(archive.path, options(root, archive.sha256));
    expect(staged.manifest).toHaveLength(3);
    expect(staged.manifest.some((file) => file.path.endsWith('session.lock'))).toBe(false);
    expect(staged.manifest.find((file) => file.path.endsWith('.mca'))?.size).toBe(16 * 1024 ** 2);
    expect(staged.validation.dataVersion).toBe(5000);
    expect((await lstat(join(staged.directory, 'imported/region/r.0.0.mca'))).size).toBe(
      16 * 1024 ** 2,
    );
    expect(
      (await stageMinecraftWorld(archive.path, options(root, archive.sha256))).manifest,
    ).toEqual(staged.manifest);
    await writeFile(join(staged.directory, 'imported/level.dat'), Buffer.from('tampered'));
    await expect(
      stageMinecraftWorld(archive.path, options(root, archive.sha256)),
    ).rejects.toMatchObject({ details: { reason: 'minecraft_world_stage_existing_mismatch' } });
  });
  it('checks archive digest, preserves mismatched source metadata, plan identity and cancellation', async () => {
    const { root } = await environment();
    const archive = await makeZip(root, { 'level.dat': levelDat() });
    await expect(
      stageMinecraftWorld(archive.path, options(root, 'a'.repeat(64))),
    ).rejects.toThrow();
    await expect(
      stageMinecraftWorld(archive.path, {
        ...options(root, archive.sha256),
        expectedDataVersion: 5001,
      }),
    ).resolves.toMatchObject({ validation: { dataVersion: 5000, targetRelease: '26.1' } });
    await expect(
      stageMinecraftWorld(archive.path, options(root, archive.sha256)),
    ).rejects.toMatchObject({ details: { reason: 'minecraft_world_stage_plan_conflict' } });
    const controller = new AbortController();
    controller.abort();
    await expect(
      stageMinecraftWorld(archive.path, {
        ...options(root, archive.sha256),
        jobId: 'cancelled',
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
  it('stages a wrapped legacy world and unknown target without converting its bytes', async () => {
    const { root } = await environment();
    const original = metadata({ version: { type: 'int', value: 19133 } });
    const archive = await makeZip(root, {
      'FCTN/level.dat': original,
      'FCTN/region/r.0.0.mca': Buffer.from('opaque chunk bytes'),
    });
    const staged = await stageMinecraftWorld(archive.path, {
      ...options(root, archive.sha256),
      expectedDataVersion: undefined,
      release: 'unknown-future-server',
    });
    expect(staged.validation).toMatchObject({
      storageVersion: 19133,
      targetRelease: 'unknown-future-server',
    });
    expect(staged.validation.dataVersion).toBeUndefined();
    expect(staged.validation.versionName).toBeUndefined();
    expect(await readFile(join(staged.directory, 'imported/level.dat'))).toEqual(original);
  });
  it('does not follow staging/source symlinks or accept browser-like paths outside mountdata', async () => {
    const { root, parent } = await environment();
    const archive = await makeZip(root, { 'level.dat': levelDat() });
    const alias = join(root, 'alias.zip');
    await symlink(archive.path, alias);
    await expect(stageMinecraftWorld(alias, options(root, archive.sha256))).rejects.toThrow();
    await expect(
      stageMinecraftWorld(join(parent, 'outside.zip'), options(root, archive.sha256)),
    ).rejects.toThrow();
    await mkdir(join(parent, 'elsewhere'));
    await rm(join(root, 'world-staging'), { recursive: true, force: true });
    await symlink(join(parent, 'elsewhere'), join(root, 'world-staging'));
    await expect(
      stageMinecraftWorld(archive.path, options(root, archive.sha256)),
    ).rejects.toThrow();
  });
  it('rejects ZIP traversal, symlinks, unsafe nested code and expansion bombs', async () => {
    for (const scenario of ['traversal', 'symlink', 'code', 'bomb']) {
      const { root } = await environment();
      let archive = await makeZip(
        root,
        {
          'good/level.dat': levelDat(),
          ...(scenario === 'code'
            ? { 'good/plugins/bad.jar': Buffer.from('unsafe') }
            : scenario === 'bomb'
              ? { 'good/data/huge.dat': Buffer.alloc(100_000) }
              : {}),
        },
        { mode: scenario === 'symlink' ? 0o120777 : undefined, compress: scenario === 'bomb' },
      );
      if (scenario === 'traversal') {
        const bytes = await readFile(archive.path);
        const original = Buffer.from('good/level.dat');
        const replacement = Buffer.from('../x/level.dat');
        for (
          let offset = bytes.indexOf(original);
          offset !== -1;
          offset = bytes.indexOf(original, offset + original.length)
        )
          replacement.copy(bytes, offset);
        await writeFile(archive.path, bytes);
        archive = { path: archive.path, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      await expect(
        stageMinecraftWorld(archive.path, {
          ...options(root, archive.sha256),
          limits: scenario === 'bomb' ? { maxCompressionRatio: 10 } : {},
        }),
      ).rejects.toThrow();
    }
  });
  it('rejects multiple worlds and file/directory aliases', async () => {
    for (const extras of [
      { 'second/level.dat': levelDat() },
      { 'source/data': Buffer.from('file'), 'source/data/item.dat': Buffer.from('child') },
    ] as Record<string, Buffer>[]) {
      const { root } = await environment();
      const archive = await makeZip(root, { 'source/level.dat': levelDat(), ...extras });
      await expect(
        stageMinecraftWorld(archive.path, options(root, archive.sha256)),
      ).rejects.toThrow();
    }
  });
  it('recovers crash-left locks only after exclusive DB job assertion and matching plan', async () => {
    const { root } = await environment();
    const archive = await makeZip(root, { 'level.dat': levelDat() });
    const staged = await stageMinecraftWorld(archive.path, options(root, archive.sha256));
    const lock = join(root, 'world-staging/job-one/.lock');
    await writeFile(lock, 'crashed');
    const denied = vi.fn(async () => {
      throw new Error('another worker owns job');
    });
    await expect(
      recoverMinecraftWorldStageLock({
        mountdataRoot: root,
        jobId: 'job-one',
        expectedPlanDigest: staged.planDigest,
        assertExclusiveJob: denied,
      }),
    ).rejects.toThrow();
    expect((await lstat(lock)).isFile()).toBe(true);
    const granted = vi.fn(async () => {});
    await recoverMinecraftWorldStageLock({
      mountdataRoot: root,
      jobId: 'job-one',
      expectedPlanDigest: staged.planDigest,
      assertExclusiveJob: granted,
    });
    expect(granted).toHaveBeenCalledOnce();
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
describe('world operation consent and discovery', () => {
  it('requires explicit exact replacement consent and retains requested backup requirement', () => {
    expect(() => planMinecraftWorldReplacement('existing', true)).toThrow();
    expect(() =>
      planMinecraftWorldReplacement('existing', true, {
        wipeConsent: true,
        expectedDeletePaths: ['other'],
        backupBefore: true,
      }),
    ).toThrow();
    expect(
      planMinecraftWorldReplacement('existing', true, {
        wipeConsent: true,
        expectedDeletePaths: ['existing'],
        backupBefore: true,
      }),
    ).toMatchObject({ deletePaths: ['existing'], backupBefore: true, requiresStoppedServer: true });
    expect(planMinecraftWorldReplacement('new_world', false)).toMatchObject({
      deletePaths: [],
      backupBefore: false,
      requiresStoppedServer: false,
    });
    expect(() =>
      planMinecraftWorldReplacement('new', false, {
        wipeConsent: true,
        expectedDeletePaths: ['new'],
        backupBefore: false,
      }),
    ).toThrow();
  });
  it('discovers only safe directory worlds and distinguishes incompatible from unavailable', async () => {
    const reads: string[] = [];
    const discovered = await discoverMinecraftWorlds(
      {
        listRoot: async () =>
          ['valid', 'old', 'missing', 'broken', 'plugins', '../bad'].map((name) => ({
            name,
            isDirectory: true,
          })),
        readLevelDat: async (name) => {
          reads.push(name);
          if (name === 'missing') return undefined;
          if (name === 'broken') throw new Error('provider unavailable');
          return levelDat(name === 'old' ? 4999 : 5000);
        },
      },
      { expectedDataVersion: 5000, release: '26.1' },
    );
    expect(discovered.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'valid', status: 'verified' },
      { name: 'old', status: 'incompatible' },
      { name: 'broken', status: 'unavailable' },
    ]);
    expect(reads).not.toContain('plugins');
    expect(reads).not.toContain('../bad');
  });
});

describe('world inventory observations', () => {
  it('retains actual version metadata without granting compatibility when evidence is unavailable', async () => {
    const worlds = await discoverMinecraftWorlds(
      {
        listRoot: async () => [{ name: 'legacy', isDirectory: true }],
        readLevelDat: async () => levelDat(1234, '1.9'),
      },
      { release: '26.1' },
    );
    expect(worlds).toEqual([
      expect.objectContaining({
        name: 'legacy',
        status: 'unknown',
        validation: expect.objectContaining({ dataVersion: 1234, versionName: '1.9' }),
      }),
    ]);
    const known = await discoverMinecraftWorlds(
      {
        listRoot: async () => [{ name: 'legacy', isDirectory: true }],
        readLevelDat: async () => levelDat(1234, '1.9'),
      },
      { release: '26.1', expectedDataVersion: 5000 },
    );
    expect(known[0]).toMatchObject({ status: 'incompatible', validation: { versionName: '1.9' } });
  });
  it('distinguishes unknown legacy/future identity, malformed metadata and unavailable reads', async () => {
    const worlds = await discoverMinecraftWorlds(
      {
        listRoot: async () =>
          ['legacy', 'future', 'ambiguous', 'invalid', 'offline'].map((name) => ({
            name,
            isDirectory: true,
          })),
        readLevelDat: async (name) => {
          if (name === 'offline') throw new Error('unavailable');
          if (name === 'invalid') return metadata({});
          if (name === 'legacy') return metadata({ version: { type: 'int', value: 19133 } });
          if (name === 'ambiguous') return metadata({ DataVersion: { type: 'int', value: 111 } });
          return levelDat(77777, 'future-custom');
        },
      },
      { release: 'unknown-server' },
    );
    expect(worlds.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'legacy', status: 'unknown' },
      { name: 'future', status: 'unknown' },
      { name: 'ambiguous', status: 'unknown' },
      { name: 'invalid', status: 'invalid' },
      { name: 'offline', status: 'unavailable' },
    ]);
  });

  it('uses at most two readers, scans each candidate once and preserves provider order', async () => {
    let active = 0;
    let maximum = 0;
    const names = ['one', 'two', 'three', 'four', 'five'];
    const root = vi.fn(async () => names.map((name) => ({ name, isDirectory: true })));
    const read = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return levelDat();
    });
    const worlds = await discoverMinecraftWorlds(
      { listRoot: root, readLevelDat: read },
      {
        release: '26.1',
        expectedDataVersion: 5000,
      },
    );
    expect(worlds.map((world) => world.name)).toEqual(names);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(root).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(names.length);
  });

  it('propagates revoked authorization instead of returning a misleading partial inventory', async () => {
    await expect(
      discoverMinecraftWorlds(
        {
          listRoot: async () => [{ name: 'world', isDirectory: true }],
          readLevelDat: async () => {
            throw new DomainError('forbidden');
          },
        },
        { release: '26.1' },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects excessive candidates and case aliases before starting remote metadata reads', async () => {
    const read = vi.fn();
    for (const names of [
      ['one', 'two'],
      ['one', 'ONE'],
    ]) {
      await expect(
        discoverMinecraftWorlds(
          {
            listRoot: async () => names.map((name) => ({ name, isDirectory: true })),
            readLevelDat: read,
          },
          { release: '26.1', maxWorlds: names[1] === 'two' ? 1 : 2 },
        ),
      ).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalled();
  });
});
