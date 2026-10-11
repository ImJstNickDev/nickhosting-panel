import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, gzipSync } from 'node:zlib';
import type { PterodactylAdapter, ServerFile } from '@nickhosting/pterodactyl-adapter';
import { pack } from 'tar-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { planFileCopy, stageFileArchive, validateFileMoves } from './file-operations.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nh-file-ops-'));
  roots.push(root);
  const stage = join(root, 'stage');
  await mkdir(stage);
  return { root, stage };
}
function file(name: string, directory = false, symlink = false): ServerFile {
  return {
    name,
    size: directory ? 0 : 4,
    is_file: !directory,
    is_symlink: symlink,
    mode: '0644',
    mimetype: 'text/plain',
    created_at: '',
    modified_at: '',
  };
}
async function tar(
  root: string,
  entries: {
    name: string;
    content?: string;
    type?: 'file' | 'directory' | 'symlink';
    linkname?: string;
  }[],
  gzip = false,
) {
  const archive = join(root, gzip ? 'test.tar.gz' : 'test.tar');
  const writer = pack();
  const output = gzip
    ? pipeline(writer, createGzip(), createWriteStream(archive))
    : pipeline(writer, createWriteStream(archive));
  for (const entry of entries)
    await new Promise<void>((resolve, reject) =>
      writer.entry(
        { name: entry.name, type: entry.type ?? 'file', linkname: entry.linkname },
        entry.content ?? '',
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  writer.finalize();
  await output;
  return archive;
}
describe('safe file copy planning', () => {
  it('enumerates directories before effects and maintains structure', async () => {
    const list = vi.fn(
      async (path: string) =>
        ({
          '': [file('world', true), file('copies', true)],
          world: [file('level.dat'), file('empty', true)],
          'world/empty': [],
          copies: [],
        })[path] ?? [],
    );
    expect(await planFileCopy(list, '', ['world'], 'copies')).toEqual([
      { source: 'world', path: 'copies/world', directory: true, size: 0 },
      { source: 'world/level.dat', path: 'copies/world/level.dat', directory: false, size: 4 },
      { source: 'world/empty', path: 'copies/world/empty', directory: true, size: 0 },
    ]);
  });
  it.each(['../world', 'world/config', '/world', 'world\\config'])(
    'rejects ambiguous selection %s',
    async (name) => {
      await expect(planFileCopy(async () => [], '', [name], 'copies')).rejects.toThrow();
    },
  );
  it('rejects destination conflicts and symbolic links before any writes', async () => {
    await expect(
      planFileCopy(async () => [file('settings.txt')], '', ['settings.txt'], 'target'),
    ).rejects.toThrow();
    await expect(
      planFileCopy(
        async (path) => (path ? [] : [file('alias', false, true)]),
        '',
        ['alias'],
        'target',
      ),
    ).rejects.toThrow();
  });
  it('rejects copying a directory into itself', async () => {
    await expect(
      planFileCopy(
        async (path) => (path ? [] : [file('world', true)]),
        '',
        ['world'],
        'world/inside',
      ),
    ).rejects.toThrow();
  });
});
describe('validated file archive staging', () => {
  it.each(['zip', 'tar', 'tgz'] as const)(
    'returns a validation error for malformed %s data',
    async (format) => {
      const f = await fixture();
      const archive = join(f.root, 'invalid');
      await writeFile(archive, 'not an archive');
      await expect(stageFileArchive(archive, format, f.stage)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    },
  );

  it('preserves empty directories in ZIP and TAR archives', async () => {
    const f = await fixture();
    const archive = await tar(f.root, [{ name: 'empty/', type: 'directory' }]);
    expect(await stageFileArchive(archive, 'tar', f.stage)).toMatchObject([
      { path: 'empty', size: 0, directory: true },
    ]);
    const g = await fixture();
    const zip = new ZipFile();
    const path = join(g.root, 'empty.zip');
    const output = pipeline(zip.outputStream, createWriteStream(path));
    zip.addEmptyDirectory('empty');
    zip.end();
    await output;
    expect(await stageFileArchive(path, 'zip', g.stage)).toMatchObject([
      { path: 'empty', size: 0, directory: true },
    ]);
  });
  it('bounds decompressed padding and metadata even without file entries', async () => {
    const f = await fixture();
    const archive = join(f.root, 'padding.tar.gz');
    await writeFile(archive, gzipSync(Buffer.alloc(8 * 1024 * 1024)));
    await expect(stageFileArchive(archive, 'tar.gz', f.stage)).rejects.toThrow();
  });

  it.each([false, true])('stages a TAR archive (gzip %s) without remote effects', async (gzip) => {
    const f = await fixture();
    const archive = await tar(f.root, [{ name: 'world/level.dat', content: 'world-data' }], gzip);
    const result = await stageFileArchive(archive, gzip ? 'tar.gz' : 'tar', f.stage, undefined, {
      minimumFreeBytes: 0,
      minimumFreePercent: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe('world/level.dat');
    expect(await readFile(result[0]?.local ?? '', 'utf8')).toBe('world-data');
  });
  it('stages ZIP with checksum validation', async () => {
    const f = await fixture();
    const archive = join(f.root, 'test.zip');
    const zip = new ZipFile();
    const output = pipeline(zip.outputStream, createWriteStream(archive));
    zip.addBuffer(Buffer.from('safe-data'), 'settings.json');
    zip.end();
    await output;
    const result = await stageFileArchive(archive, 'zip', f.stage, undefined, {
      minimumFreeBytes: 0,
      minimumFreePercent: 0,
    });
    expect(result[0]?.size).toBe(9);
    expect(await readFile(result[0]?.local ?? '', 'utf8')).toBe('safe-data');
  });
  it.each(['../server.jar', '/server.jar', 'a/../../server.jar', 'a\\server.jar'])(
    'rejects archive escape %s',
    async (name) => {
      const f = await fixture();
      const archive = await tar(f.root, [{ name, content: 'unsafe' }]);
      await expect(
        stageFileArchive(archive, 'tar', f.stage, undefined, {
          minimumFreeBytes: 0,
          minimumFreePercent: 0,
        }),
      ).rejects.toThrow();
    },
  );
  it('rejects symbolic links and duplicate names', async () => {
    const f = await fixture();
    const archive = await tar(f.root, [
      { name: 'link', type: 'symlink', linkname: '../server.jar' },
    ]);
    await expect(
      stageFileArchive(archive, 'tar', f.stage, undefined, {
        minimumFreeBytes: 0,
        minimumFreePercent: 0,
      }),
    ).rejects.toThrow();
    const g = await fixture();
    const duplicate = await tar(g.root, [
      { name: 'test', content: 'a' },
      { name: 'TEST', content: 'b' },
    ]);
    await expect(
      stageFileArchive(duplicate, 'tar', g.stage, undefined, {
        minimumFreeBytes: 0,
        minimumFreePercent: 0,
      }),
    ).rejects.toThrow();
  });
  it('rejects file/directory collisions and compression bombs', async () => {
    const f = await fixture();
    const archive = await tar(f.root, [
      { name: 'a', content: 'a' },
      { name: 'a/b', content: 'b' },
    ]);
    await expect(
      stageFileArchive(archive, 'tar', f.stage, undefined, {
        minimumFreeBytes: 0,
        minimumFreePercent: 0,
      }),
    ).rejects.toThrow();
    const g = await fixture();
    const bomb = await tar(g.root, [{ name: 'bomb', content: '0'.repeat(2 * 1024 * 1024) }], true);
    await expect(
      stageFileArchive(bomb, 'tar.gz', g.stage, undefined, {
        minimumFreeBytes: 0,
        minimumFreePercent: 0,
      }),
    ).rejects.toThrow();
  });
});

describe('batch move preflight', () => {
  it('rejects targets inside another simultaneously moved source', async () => {
    const a = { listFiles: vi.fn(async () => []) } as unknown as PterodactylAdapter;
    await expect(
      validateFileMoves(a, 'server', '', [
        { from: 'a', to: 'b/new' },
        { from: 'b', to: 'c' },
      ]),
    ).rejects.toThrow();
    expect(a.listFiles).not.toHaveBeenCalled();
  });

  function adapter(list: Record<string, ServerFile[]>) {
    return {
      listFiles: vi.fn(async (_id: string, path: string) => list[path] ?? []),
    } as unknown as PterodactylAdapter;
  }
  it('allows a move to an existing safe folder without an existing target', async () => {
    await expect(
      validateFileMoves(
        adapter({ '': [file('a'), file('target', true)], target: [] }),
        'server',
        '',
        [{ from: 'a', to: 'target/a' }],
      ),
    ).resolves.toBeUndefined();
  });
  it('rejects an existing destination and all duplicate batch targets', async () => {
    const a = adapter({ '': [file('a'), file('b'), file('target', true)], target: [file('a')] });
    await expect(
      validateFileMoves(a, 'server', '', [{ from: 'a', to: 'target/a' }]),
    ).rejects.toThrow();
    await expect(
      validateFileMoves(a, 'server', '', [
        { from: 'a', to: 'target/c' },
        { from: 'b', to: 'target/c' },
      ]),
    ).rejects.toThrow();
  });
  it('rejects subtree moves, overlapping selections and symbolic-link ancestors', async () => {
    const a = adapter({ '': [file('world', true), file('alias', true, true)], world: [file('a')] });
    await expect(
      validateFileMoves(a, 'server', '', [{ from: 'world', to: 'world/deeper' }]),
    ).rejects.toThrow();
    await expect(
      validateFileMoves(a, 'server', '', [
        { from: 'world', to: 'new' },
        { from: 'world/a', to: 'a' },
      ]),
    ).rejects.toThrow();
    await expect(
      validateFileMoves(a, 'server', '', [{ from: 'world/a', to: 'alias/a' }]),
    ).rejects.toThrow();
  });
});
