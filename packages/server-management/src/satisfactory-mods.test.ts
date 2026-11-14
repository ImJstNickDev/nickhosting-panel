import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PterodactylAdapter, PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { afterEach, expect, it, vi } from 'vitest';
import type { GameLifecycleContext } from './lifecycle.js';
import { processSatisfactoryMods } from './satisfactory-mods.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture(old?: Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'nh-mod-job-'));
  roots.push(root);
  const bytes = Buffer.alloc(2 * 1024 * 1024, 1);
  const stage = join(root, 'content-staging', 'job');
  await mkdir(stage, { recursive: true });
  await writeFile(join(stage, '0.bin'), bytes);
  const path = 'FactoryGame/Mods/Example/binary.so';
  await writeFile(
    join(stage, 'receipt.json'),
    JSON.stringify({
      selection: [],
      files: [{ path, sha256: digest(bytes), size: bytes.length }],
      lock: { version: 1, mods: {} },
    }),
  );
  const files = new Map<string, Buffer>(old ? [[path, old]] : []);
  const stored = vi.fn(async () => {});
  const select = {
    selectAll() {
      return this;
    },
    where() {
      return this;
    },
    async executeTakeFirst() {
      return undefined;
    },
  };
  const insert = {
    values() {
      return this;
    },
    onConflict() {
      return this;
    },
    execute: stored,
  };
  const uploadFile = vi.fn(
    async (_id: string, file: string, input: { body: ReadableStream<Uint8Array> }) => {
      files.set(file, Buffer.from(await new Response(input.body).arrayBuffer()));
    },
  );
  const adapter = {
    listFiles: vi.fn(async (_id: string, directory: string) => {
      const directories: Record<string, string> = {
        '': 'FactoryGame',
        FactoryGame: 'Mods',
        'FactoryGame/Mods': 'Example',
      };
      if (directories[directory])
        return [{ name: directories[directory], is_file: false, is_symlink: false }];
      return [...files.keys()]
        .filter((file) => file.slice(0, file.lastIndexOf('/')) === directory)
        .map((file) => ({ name: file.split('/').at(-1), is_file: true, is_symlink: false }));
    }),
    downloadFile: vi.fn(async (_id: string, file: string) => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(files.get(file));
          controller.close();
        },
      }),
    })),
    uploadFile,
    readFile: vi.fn(),
    createDirectory: vi.fn(async (_id: string, _parent: string, _name: string) => {}),
    prepareUploadBatch: vi.fn<PterodactylAdapter['prepareUploadBatch']>(async () => null),
    prepareUpload: vi.fn<PterodactylAdapter['prepareUpload']>(
      async (_id: string, file: string) => (input: { body: ReadableStream<Uint8Array> }) =>
        uploadFile(_id, file, input),
    ),
  };
  const context = {
    db: {
      selectFrom: () => select,
      insertInto: () => insert,
      updateTable: () => ({
        set() {
          return this;
        },
        where() {
          return this;
        },
        execute: async () => {},
      }),
    },
    server: { id: 'server', pterodactyl_identifier: 'provider', limits: { disk: 100 } },
    operation: () => ({
      job_id: 'job',
      plan: { satisfactoryContent: { kind: 'mods', selection: [] } },
    }),
    update: vi.fn(async () => {}),
    authorize: vi.fn(async () => {}),
    assertStopped: vi.fn(async () => {}),
    effect: async (_name: string, perform: () => Promise<void>) => {
      await perform();
      return true;
    },
    adapter,
  } as unknown as GameLifecycleContext;
  return { root, stage, context, adapter, bytes, files, path, stored };
}
it('uploads and verifies a binary larger than the text-file API limit through bounded streaming', async () => {
  const f = await fixture();
  expect(await processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root })).toBe(
    true,
  );
  expect(f.adapter.readFile).not.toHaveBeenCalled();
  expect(f.files.get(f.path)).toEqual(f.bytes);
  expect(f.stored).toHaveBeenCalledOnce();
  expect(f.context.assertStopped).toHaveBeenCalled();
  expect(f.adapter.prepareUploadBatch).toHaveBeenCalledOnce();
  expect(f.adapter.prepareUpload).toHaveBeenCalledOnce();
});
it('does not replace an existing file without a matching managed ownership hash', async () => {
  const f = await fixture(Buffer.from('external file'));
  await expect(
    processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(f.adapter.uploadFile).not.toHaveBeenCalled();
  expect(f.stored).not.toHaveBeenCalled();
});
it('rejects a symlink in an existing ancestor before accessing file contents', async () => {
  const f = await fixture();
  f.adapter.listFiles.mockImplementation(async () => [
    { name: 'FactoryGame', is_file: false, is_symlink: true },
  ]);
  await expect(
    processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(f.adapter.downloadFile).not.toHaveBeenCalled();
});

async function seedUploads(
  f: Awaited<ReturnType<typeof fixture>>,
  count: number,
  pathFor = (index: number) => `FactoryGame/Mods/Example/file-${index}.bin`,
) {
  const entries = Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.from(`mod-file-${index}`);
    return {
      path: pathFor(index),
      size: bytes.length,
      sha256: digest(bytes),
      bytes,
    };
  });
  await Promise.all(
    entries.map((file, index) => writeFile(join(f.stage, `${index}.bin`), file.bytes)),
  );
  await writeFile(
    join(f.stage, 'receipt.json'),
    JSON.stringify({
      selection: [],
      files: entries.map(({ bytes: _bytes, ...file }) => file),
      lock: { version: 1, mods: {} },
    }),
  );
  return entries;
}

it('uses existing bulk handoffs in windows of at most 500 files without native per-file grants', async () => {
  const f = await fixture();
  const entries = await seedUploads(f, 501);
  f.adapter.prepareUploadBatch.mockImplementation(async (_id, paths) => ({
    expiresAt: Date.now() + 900_000,
    uploads: paths.map((path) => async (input) => {
      await input.authorize?.();
      f.files.set(path, Buffer.from(await new Response(input.body).arrayBuffer()));
    }),
  }));
  expect(await processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root })).toBe(
    true,
  );
  expect(f.adapter.prepareUploadBatch.mock.calls.map(([, paths]) => paths.length)).toEqual([
    500, 1,
  ]);
  expect(f.adapter.prepareUpload).not.toHaveBeenCalled();
  expect(f.adapter.uploadFile).not.toHaveBeenCalled();
  expect(f.files.size).toBe(501);
  const last = entries[500];
  if (!last) throw new Error('Missing fixture file');
  expect(f.files.get(last.path)).toEqual(last.bytes);
});

it('renews expired bulk credentials only for the remaining files', async () => {
  const f = await fixture();
  await seedUploads(f, 3);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let sent = 0;
  f.adapter.prepareUploadBatch.mockImplementation(async (_id, paths) => ({
    expiresAt: now + 900_000,
    uploads: paths.map((path) => async (input) => {
      f.files.set(path, Buffer.from(await new Response(input.body).arrayBuffer()));
      if (++sent === 1) now += 900_000;
    }),
  }));
  expect(await processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root })).toBe(
    true,
  );
  expect(f.adapter.prepareUploadBatch.mock.calls.map(([, paths]) => paths)).toEqual([
    [
      'FactoryGame/Mods/Example/file-0.bin',
      'FactoryGame/Mods/Example/file-1.bin',
      'FactoryGame/Mods/Example/file-2.bin',
    ],
    ['FactoryGame/Mods/Example/file-1.bin', 'FactoryGame/Mods/Example/file-2.bin'],
  ]);
  expect(sent).toBe(3);
});

it('defers throttled grants before entering an upload effect and preserves provider deadline', async () => {
  const f = await fixture();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const effect = vi.spyOn(f.context, 'effect');
  f.adapter.prepareUploadBatch.mockRejectedValue(
    new PterodactylError('rate_limited', 'client', 'rejected', 429, 45_000),
  );
  expect(await processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root })).toBe(
    false,
  );
  expect(f.context.update).toHaveBeenCalledWith(
    expect.objectContaining({
      plan: expect.objectContaining({
        providerPreflightRetryAt: new Date(now + 45_000).toISOString(),
      }),
    }),
  );
  expect(effect).not.toHaveBeenCalled();
  expect(f.adapter.uploadFile).not.toHaveBeenCalled();
  expect(f.stored).not.toHaveBeenCalled();
});

it('does not fall back on a rejected bulk capability or replay an uncertain publication', async () => {
  const f = await fixture();
  const rejected = new PterodactylError('permission_denied', 'client', 'rejected', 403);
  f.adapter.prepareUploadBatch.mockRejectedValueOnce(rejected);
  await expect(
    processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root }),
  ).rejects.toBe(rejected);
  expect(f.adapter.prepareUpload).not.toHaveBeenCalled();
  const uncertain = new PterodactylError('unavailable', 'client', 'unknown');
  const send = vi.fn(async (input: { body: ReadableStream<Uint8Array> }) => {
    await input.body.cancel();
    throw uncertain;
  });
  f.adapter.prepareUploadBatch.mockResolvedValue({
    expiresAt: Date.now() + 900_000,
    uploads: [send],
  });
  await expect(
    processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root }),
  ).rejects.toBe(uncertain);
  expect(send).toHaveBeenCalledOnce();
  expect(f.adapter.prepareUpload).not.toHaveBeenCalled();
  expect(f.stored).not.toHaveBeenCalled();
});

it('rechecks stopped authority after preparing credentials and before opening the upload body', async () => {
  const f = await fixture();
  const send = vi.fn(async () => {});
  f.adapter.prepareUploadBatch.mockImplementation(async () => {
    vi.mocked(f.context.assertStopped).mockRejectedValueOnce(new Error('server started'));
    return { expiresAt: Date.now() + 900_000, uploads: [send] };
  });
  await expect(
    processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root }),
  ).rejects.toThrow('server started');
  expect(send).not.toHaveBeenCalled();
  expect(f.adapter.uploadFile).not.toHaveBeenCalled();
  expect(f.stored).not.toHaveBeenCalled();
});

it.each(['stopped', 'started'] as const)(
  'prepares every batch parent with guarded directory effects when the process is %s',
  async (process) => {
    const f = await fixture();
    await seedUploads(f, 3, (index) =>
      index === 0
        ? 'FactoryGame/Mods/Example/file.bin'
        : `FactoryGame/Mods/Example/Resources/${index}/file.bin`,
    );
    const directories = new Set([
      '',
      'FactoryGame',
      'FactoryGame/Mods',
      'FactoryGame/Mods/Example',
    ]);
    f.adapter.listFiles.mockImplementation(async (_id, directory) => {
      if (!directories.has(directory))
        throw new PterodactylError('unavailable', 'client', 'rejected', 500);
      const prefix = directory ? `${directory}/` : '';
      return [
        ...[...directories]
          .filter(
            (path) =>
              path.startsWith(prefix) &&
              path !== directory &&
              !path.slice(prefix.length).includes('/'),
          )
          .map((path) => ({ name: path.slice(prefix.length), is_file: false, is_symlink: false })),
        ...[...f.files.keys()]
          .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          .map((path) => ({ name: path.slice(prefix.length), is_file: true, is_symlink: false })),
      ];
    });
    f.adapter.createDirectory.mockImplementation(async (_id, parent, name) => {
      expect(f.context.authorize).toHaveBeenCalled();
      expect(f.context.assertStopped).toHaveBeenCalled();
      expect(directories.has(parent)).toBe(true);
      directories.add(parent ? `${parent}/${name}` : name);
    });
    f.adapter.prepareUploadBatch.mockImplementation(async (_id, paths) => {
      for (const path of paths) {
        if (!directories.has(path.slice(0, path.lastIndexOf('/'))))
          throw new PterodactylError('unavailable', 'client', 'rejected', 500);
      }
      return {
        expiresAt: Date.now() + 900_000,
        uploads: paths.map((path) => async (input) => {
          f.files.set(path, Buffer.from(await new Response(input.body).arrayBuffer()));
        }),
      };
    });
    if (process === 'started') {
      vi.mocked(f.context.assertStopped)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error('server started'));
      await expect(
        processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root }),
      ).rejects.toThrow('server started');
      expect(f.adapter.createDirectory).not.toHaveBeenCalled();
      expect(f.adapter.prepareUploadBatch).not.toHaveBeenCalled();
      expect(f.files.size).toBe(0);
    } else {
      const effects = vi.spyOn(f.context, 'effect');
      expect(
        await processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root }),
      ).toBe(true);
      expect(f.adapter.prepareUploadBatch).toHaveBeenCalledOnce();
      expect(f.adapter.createDirectory).toHaveBeenCalledTimes(3);
      expect(
        effects.mock.calls.map(([name]) => name).filter((name) => name.includes('.mkdir.')),
      ).toEqual([
        'satisfactory.mods.mkdir.1.3',
        'satisfactory.mods.mkdir.1.4',
        'satisfactory.mods.mkdir.2.4',
      ]);
      expect(f.files.size).toBe(3);
    }
  },
);

it('rejects a destination changed while preparing bulk credentials', async () => {
  const f = await fixture();
  f.adapter.prepareUploadBatch.mockImplementation(async () => {
    f.files.set(f.path, Buffer.from('external write'));
    return { expiresAt: Date.now() + 900_000, uploads: [vi.fn(async () => {})] };
  });
  await expect(
    processSatisfactoryMods(f.context, { NH_SATISFACTORY_MOD_WORK_ROOT: f.root }),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(f.adapter.uploadFile).not.toHaveBeenCalled();
  expect(f.files.get(f.path)?.toString()).toBe('external write');
});
