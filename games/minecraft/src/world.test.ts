import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
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
it('observes an actual bounded DataVersion without guessing while exact validation still rejects mismatches', () => {
  expect(
    inspectMinecraftLevelDat(levelDat(12345, 'future-release'), { release: 'future-release' }),
  ).toMatchObject({ dataVersion: 12345, versionName: 'future-release' });
  expect(() => validateMinecraftLevelDat(levelDat(12345), 5000)).toThrow();
  expect(() => inspectMinecraftLevelDat(levelDat(-1))).toThrow();
  expect(() => inspectMinecraftLevelDat(levelDat(), { release: '1.21.1' })).toThrow();
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
  it('checks archive digest, exact DataVersion, plan identity and cancellation', async () => {
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
    ).rejects.toThrow();
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
