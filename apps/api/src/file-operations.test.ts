import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, gzipSync, zstdCompressSync } from 'node:zlib';
import type { PterodactylAdapter, ServerFile } from '@nickhosting/pterodactyl-adapter';
import { pack } from 'tar-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import {
  applyFileChunks,
  planFileCopy,
  stageFileArchive,
  validateFileDeletes,
  validateFileMoves,
} from './file-operations.js';
import { rar5, tarBz2, tarXz } from './viewer-archive-fixtures.js';

const roots: string[] = [];
describe('bounded provider file batches', () => {
  it('rejects duplicate, nested and invalid deletions anywhere in the full selection before dispatch', () => {
    const files = Array.from({ length: 1001 }, (_, i) => `file-${i}`);
    expect(() => validateFileDeletes('world', files)).not.toThrow();
    for (const final of ['file-0', 'FILE-0', 'file-0/child', '../escape'])
      expect(() => validateFileDeletes('world', [...files, final])).toThrow();
    expect(() => validateFileDeletes('', ['world/config', 'world'])).toThrow();
    expect(() => validateFileDeletes('', ['world-file', 'world'])).not.toThrow();
  });
  it('dispatches sequential chunks after authorization, not one request per file', async () => {
    const events: string[] = [];
    await applyFileChunks(
      Array.from({ length: 2501 }, (_, i) => i),
      async () => {
        events.push('authorize');
      },
      async (entries) => {
        events.push(`${entries[0]}:${entries.length}`);
      },
    );
    expect(events).toEqual([
      'authorize',
      '0:1000',
      'authorize',
      '1000:1000',
      'authorize',
      '2000:501',
    ]);
  });
  it('never retries a partly completed operation or labels failed chunks as confirmed', async () => {
    const apply = vi.fn(async (_entries: number[]) => {});
    apply.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('lost response'));
    await expect(
      applyFileChunks(
        Array.from({ length: 2501 }, (_, i) => i),
        async () => {},
        apply,
      ),
    ).rejects.toMatchObject({ code: 'operation_uncertain', details: { completed: 1000 } });
    expect(apply).toHaveBeenCalledTimes(2);
    apply.mockClear().mockRejectedValueOnce(new Error('partial first chunk'));
    await expect(applyFileChunks([1, 2], async () => {}, apply)).rejects.toMatchObject({
      code: 'operation_uncertain',
      details: { completed: 0 },
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('leaves pre-dispatch authorization failures unchanged and marks later revocation uncertain', async () => {
    const { DomainError } = await import('@nickhosting/core');
    const authorize = vi.fn<() => Promise<void>>(async () => {
      throw new DomainError('forbidden');
    });
    const apply = vi.fn(async (_entries: number[]) => {});
    await expect(applyFileChunks([1], authorize, apply)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(apply).not.toHaveBeenCalled();
    authorize.mockImplementationOnce(async () => {});
    await expect(
      applyFileChunks(
        Array.from({ length: 1001 }, (_, i) => i),
        authorize,
        apply,
      ),
    ).rejects.toMatchObject({
      code: 'operation_uncertain',
      details: { completed: 1000, cause: 'forbidden' },
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
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
  it('plans more than 100 selected roots with one listing per directory and keeps the tree budget', async () => {
    const names = Array.from({ length: 1001 }, (_, i) => `file-${i}.txt`);
    const list = vi.fn(async (path: string) =>
      path === 'source'
        ? names.map((name) => file(name))
        : path === ''
          ? [file('source', true), file('target', true)]
          : [],
    );
    expect(await planFileCopy(list, 'source', names, 'target')).toHaveLength(1001);
    expect(list.mock.calls.map(([path]) => path).sort()).toEqual(['', 'source', 'target']);
    const oversized = Array.from({ length: 20_001 }, (_, i) => `file-${i}.txt`);
    await expect(
      planFileCopy(
        async (path) =>
          path === 'target' ? [] : [file('target', true), ...oversized.map((name) => file(name))],
        '',
        oversized,
        'target',
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
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
  const copyListing =
    (targets: ServerFile[] = [file('a.txt')], sources = [file('a.txt')]) =>
    async (path: string) =>
      ({ '': [file('source', true), file('target', true)], source: sources, target: targets })[
        path
      ] ?? [];
  it('allows only the explicitly approved regular-file collision at its exact root-relative path', async () => {
    await expect(planFileCopy(copyListing(), 'source', ['a.txt'], 'target')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(
      await planFileCopy(copyListing(), 'source', ['a.txt'], 'target', ['target/a.txt']),
    ).toEqual([{ source: 'source/a.txt', path: 'target/a.txt', directory: false, size: 4 }]);
    expect(
      await planFileCopy(copyListing([]), 'source', ['a.txt'], 'target', ['target/a.txt']),
    ).toHaveLength(1);
  });
  it.each([
    ['unrelated target', ['target/other.txt']],
    ['relative to source instead of server root', ['a.txt']],
    ['case mismatch', ['target/A.txt']],
    ['duplicate approval', ['target/a.txt', 'target/a.txt']],
    ['nested approval', ['target/a.txt/child']],
  ])('rejects %s overwrite consent', async (_label, approvals) => {
    await expect(
      planFileCopy(copyListing(), 'source', ['a.txt'], 'target', approvals as string[]),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it.each([
    ['directory target', [file('a.txt', true)], [file('a.txt')]],
    ['symlink target', [file('a.txt', false, true)], [file('a.txt')]],
    ['differently cased target', [file('A.txt')], [file('a.txt')]],
    ['ambiguous target', [file('a.txt'), file('A.txt')], [file('a.txt')]],
    ['directory source', [file('a.txt')], [file('a.txt', true)]],
    ['symlink source', [file('a.txt')], [file('a.txt', false, true)]],
    ['ambiguous source', [file('a.txt')], [file('a.txt'), file('A.txt')]],
  ] as const)('rejects replacement with %s', async (_label, targets, sources) => {
    await expect(
      planFileCopy(copyListing([...targets], [...sources]), 'source', ['a.txt'], 'target', [
        'target/a.txt',
      ]),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('preflights all collisions instead of accepting blanket consent', async () => {
    await expect(
      planFileCopy(
        copyListing([file('a.txt'), file('b.txt')], [file('a.txt'), file('b.txt')]),
        'source',
        ['a.txt', 'b.txt'],
        'target',
        ['target/a.txt'],
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each([
    ['self', 'source', ['a.txt'], 'source', ['source/a.txt']],
    ['descendant', '', ['source'], 'source/nested', []],
    ['ancestor', 'source/nested', ['source'], '', ['source']],
  ])(
    'rejects %s overlap even with overwrite approval',
    async (_label, root, names, target, approvals) => {
      await expect(
        planFileCopy(
          copyListing(),
          root as string,
          names as string[],
          target as string,
          approvals as string[],
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
    },
  );
});
describe('validated file archive staging', () => {
  it.each(['zip', 'tar', 'tgz', 'tar.bz2', 'tar.xz', 'tar.zst', '7z', 'rar'] as const)(
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

  it.each([
    ['tar.xz', tarXz, 'folder/hello.txt', 'hello'],
    ['tar.bz2', tarBz2, 'folder/hello.txt', 'hello'],
    ['rar', rar5, 'helloworld.txt', 'hello libarchive test suite!\n'],
  ] as const)(
    'stages %s using the shared decoder with exact output',
    async (format, bytes, path, expected) => {
      const f = await fixture();
      const archive = join(f.root, `source.${format}`);
      await writeFile(archive, Buffer.from(bytes, 'base64'));
      const result = await stageFileArchive(archive, format, f.stage, undefined, {
        minimumFreeBytes: 0,
        minimumFreePercent: 0,
      });
      expect(await readFile(result.find((entry) => entry.path === path)?.local ?? '', 'utf8')).toBe(
        expected,
      );
    },
  );

  it('stages Zstandard TAR with the existing validation and no decoded TAR copy', async () => {
    const f = await fixture();
    const raw = await tar(f.root, [{ name: 'nested/settings.txt', content: 'safe zstd' }]);
    const archive = join(f.root, 'source.tar.zst');
    await writeFile(archive, zstdCompressSync(await readFile(raw)));
    const result = await stageFileArchive(archive, 'tar.zst', f.stage, undefined, {
      minimumFreeBytes: 0,
      minimumFreePercent: 0,
    });
    expect(await readFile(result[0]?.local ?? '', 'utf8')).toBe('safe zstd');
  });

  it('stages an LZMA2 7z archive and preserves nested files and empty directories', async () => {
    const f = await fixture();
    const factory = createRequire(import.meta.url)('sevenzip-wasm') as (
      options: object,
    ) => Promise<{
      FS: {
        mkdir(path: string): void;
        writeFile(path: string, bytes: Uint8Array): void;
        readFile(path: string): Uint8Array;
      };
      callMain(args: string[]): number;
    }>;
    const module = await factory({ print() {}, printErr() {} });
    module.FS.mkdir('/folder');
    module.FS.mkdir('/empty');
    module.FS.writeFile('/folder/hello.txt', Buffer.from('hello 7z'));
    expect(module.callMain(['a', '-t7z', '/fixture.7z', '/folder', '/empty'])).toBe(0);
    const archive = join(f.root, 'source.7z');
    await writeFile(archive, module.FS.readFile('/fixture.7z'));
    const result = await stageFileArchive(archive, '7z', f.stage, undefined, {
      minimumFreeBytes: 0,
      minimumFreePercent: 0,
    });
    expect(result).toContainEqual({ path: 'empty', size: 0, directory: true, local: '' });
    expect(
      await readFile(
        result.find((entry) => entry.path === 'folder/hello.txt')?.local ?? '',
        'utf8',
      ),
    ).toBe('hello 7z');
  });

  it('rejects dangerous members through the additional compressed TAR decoder', async () => {
    const f = await fixture();
    const raw = await tar(f.root, [{ name: '../escape', content: 'unsafe' }]);
    const archive = join(f.root, 'source.tar.zst');
    await writeFile(archive, zstdCompressSync(await readFile(raw)));
    await expect(stageFileArchive(archive, 'tar.zst', f.stage)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

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
  it('validates more than 1000 moves using each directory once and detects a conflict at the end', async () => {
    const names = Array.from({ length: 1001 }, (_, i) => `file-${i}`);
    const listings = {
      '': [file('source', true), file('target', true)],
      source: names.map((name) => file(name)),
      target: [] as ServerFile[],
    };
    const a = adapter(listings);
    const moves = names.map((name) => ({ from: `source/${name}`, to: `target/${name}` }));
    await expect(validateFileMoves(a, 'server', '', moves)).resolves.toBeUndefined();
    expect(
      vi
        .mocked(a.listFiles)
        .mock.calls.map(([, path]) => path)
        .sort(),
    ).toEqual(['', 'source', 'target']);
    listings.target.push(file('file-1000'));
    await expect(validateFileMoves(a, 'server', '', moves)).rejects.toMatchObject({
      code: 'conflict',
    });
  });
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
  it('permits only explicitly approved file destinations relative to the supplied root', async () => {
    const a = adapter({
      '': [file('config', true)],
      config: [file('a'), file('target', true)],
      'config/target': [file('a')],
    });
    await expect(
      validateFileMoves(a, 'server', 'config', [{ from: 'a', to: 'target/a' }], ['target/a']),
    ).resolves.toBeUndefined();
    await expect(
      validateFileMoves(a, 'server', 'config', [{ from: 'a', to: 'target/a' }]),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each([['elsewhere/a'], ['target/A'], ['target/a', 'target/a']])(
    'rejects unrelated, differently cased or duplicated overwrite consent: %j',
    async (...overwrite) => {
      const a = adapter({ '': [file('a'), file('target', true)], target: [file('a')] });
      await expect(
        validateFileMoves(a, 'server', '', [{ from: 'a', to: 'target/a' }], overwrite),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      expect(a.listFiles).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['directory destination', file('a'), [file('a', true)]],
    ['directory source', file('a', true), [file('a')]],
    ['symlink destination', file('a'), [file('a', false, true)]],
    ['case-only destination', file('a'), [file('A')]],
    ['ambiguous destination', file('a'), [file('a'), file('A')]],
  ] as const)('rejects approved overwrite with a %s', async (_reason, source, targets) => {
    const a = adapter({ '': [source, file('target', true)], target: [...targets] });
    await expect(
      validateFileMoves(a, 'server', '', [{ from: 'a', to: 'target/a' }], ['target/a']),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects a second unapproved collision even if the first target is approved', async () => {
    const a = adapter({
      '': [file('a'), file('b'), file('target', true)],
      target: [file('a'), file('b')],
    });
    await expect(
      validateFileMoves(
        a,
        'server',
        '',
        [
          { from: 'a', to: 'target/a' },
          { from: 'b', to: 'target/b' },
        ],
        ['target/a'],
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
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
