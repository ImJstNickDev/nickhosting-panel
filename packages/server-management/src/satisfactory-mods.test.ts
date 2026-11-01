import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { GameLifecycleContext } from './lifecycle.js';
import { processSatisfactoryMods } from './satisfactory-mods.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
    uploadFile: vi.fn(
      async (_id: string, file: string, input: { body: ReadableStream<Uint8Array> }) => {
        files.set(file, Buffer.from(await new Response(input.body).arrayBuffer()));
      },
    ),
    readFile: vi.fn(),
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
  return { root, context, adapter, bytes, files, path, stored };
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
