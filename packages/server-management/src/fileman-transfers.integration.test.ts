import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadNotDispatched } from '../../pterodactyl-adapter/src/upload-dispatch.js';
import { createFilemanJobServices } from './fileman-transfers.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { managementFixture } from './test-fixtures.js';

describe('Fileman durable integration transfers', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeEach(async () => {
    database = await createTestDatabase();
  });
  afterEach(async () => {
    await database?.destroy();
  });
  async function fixture(db = database.db) {
    const f = await managementFixture(db);
    const serverId = await f.server();
    const server = await db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    const operation = await db
      .selectFrom('server_operations')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('managed_servers')
      .set({ active_operation_id: operation.job_id })
      .where('id', '=', serverId)
      .execute();
    await db
      .updateTable('operation_jobs')
      .set({ state: 'running', completed_at: null })
      .where('id', '=', operation.job_id)
      .execute();
    await db
      .updateTable('physical_hosts')
      .set({
        local_disk_path: resolve('.'),
        disk_headroom_mib: '0',
        upload_policy: JSON.stringify({
          providerMaxFileBytes: 1024 ** 2,
          temporaryDiskPath: resolve('.'),
          temporaryDiskBudgetBytes: 16 * 1024 ** 2,
          temporaryDiskHeadroomBytes: 0,
        }),
      })
      .where('id', '=', f.hostId)
      .execute();
    await sql`update platform_settings set value = value || '{"uploadConcurrency":2}'::jsonb where key='platform'`.execute(
      db,
    );
    const directories = new Set<string>();
    const uploaded = new Map<string, Uint8Array>();
    let active = 0;
    let peak = 0;
    const send = vi.fn(
      async (
        path: string,
        input: Parameters<Awaited<ReturnType<PterodactylAdapter['prepareUpload']>>>[0],
      ) => {
        active++;
        peak = Math.max(peak, active);
        try {
          await input.authorize?.();
          const bytes = new Uint8Array(await new Response(input.body).arrayBuffer());
          await new Promise((resolve) => setTimeout(resolve, 2));
          // Native Wings uploads create missing parent directories via Touch/MkdirAll.
          const parts = path.split('/');
          for (let index = 1; index < parts.length; index++)
            directories.add(parts.slice(0, index).join('/'));
          uploaded.set(path, bytes);
        } finally {
          active--;
        }
      },
    );
    const adapter = {
      getResources: vi.fn(async () => ({ resources: { disk_bytes: 0 } })),
      listFiles: vi.fn(async (_id: string, parent: string) =>
        [...directories]
          .filter((path) => path.split('/').slice(0, -1).join('/') === parent)
          .map((path) => ({
            name: path.split('/').at(-1),
            is_file: false,
            is_symlink: false,
            size: 0,
          })),
      ),
      createDirectory: vi.fn(async (_id: string, parent: string, name: string) => {
        directories.add([parent, name].filter(Boolean).join('/'));
      }),
      prepareUploadBatch: vi.fn(async (_id: string, paths: string[]) => ({
        expiresAt: Date.now() + 300_000,
        uploads: paths.map(
          (path) =>
            (input: Parameters<Awaited<ReturnType<PterodactylAdapter['prepareUpload']>>>[0]) =>
              send(path, input),
        ),
      })),
      prepareUpload: vi.fn(),
      downloadFile: vi.fn(),
    };
    const context = {
      db,
      server,
      adapter: adapter as unknown as PterodactylAdapter,
      operation: () => operation,
      authorize: async () => {},
      assertStopped: async () => {},
      event: async () => {},
      backup: async () => false,
      update: async (patch) => {
        Object.assign(operation, patch);
      },
      effect: vi.fn(async (_phase, perform) => {
        await perform();
        return true;
      }),
    } satisfies GameLifecycleContext;
    const files = createFilemanJobServices(context, {
      env: { NH_OBSERVER_ID: 'isolated-observer' },
      authorize: async () => f.context,
    });
    const input = (count = 3) => {
      const contents = new Map(
        Array.from({ length: count }, (_, i) => [
          `new-world/region/${i}.mca`,
          Buffer.alloc(i + 1, i),
        ]),
      );
      return {
        id: 'fixture.import',
        destinationRoot: 'new-world',
        files: [...contents].map(([path, body]) => ({
          path,
          size: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
        })),
        open: vi.fn(
          async (path: string) =>
            new Response(contents.get(path)).body as ReadableStream<Uint8Array>,
        ),
      };
    };
    const claims = () =>
      db
        .selectFrom('upload_ingestion_claims')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute();
    return {
      context,
      adapter,
      files,
      input,
      send,
      uploaded,
      directories,
      claims,
      peak: () => peak,
      active: () => active,
    };
  }
  it('uses one bounded bulk grant and lifecycle effect for 101 files, confirms without rereads, and never replays a receipt', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input(101);
      const result = await f.files.uploadStaged(input);
      expect(result.files).toBe(101);
      expect(f.uploaded.size).toBe(101);
      expect(f.peak()).toBe(2);
      expect(f.adapter.listFiles).toHaveBeenCalledTimes(1);
      expect(f.adapter.createDirectory).toHaveBeenCalledTimes(1);
      expect(f.adapter.getResources).toHaveBeenCalledTimes(1);
      expect(f.adapter.prepareUploadBatch).toHaveBeenCalledTimes(1);
      expect(f.adapter.prepareUpload).not.toHaveBeenCalled();
      expect(f.adapter.downloadFile).not.toHaveBeenCalled();
      expect(f.context.effect).toHaveBeenCalledTimes(1);
      expect(f.context.operation().plan.fileTransfer).toMatchObject({
        completedFiles: 101,
        totalFiles: 101,
        completedBytes: 5151,
        totalBytes: 5151,
      });
      expect(await f.claims()).toEqual([]);
      expect(await f.files.uploadStaged(input)).toEqual(result);
      expect(f.send).toHaveBeenCalledTimes(101);
    });
  });
  it('releases admission when bulk grant preparation fails before any stream opens', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      f.adapter.prepareUploadBatch.mockRejectedValueOnce(new Error('grant unavailable'));
      await expect(f.files.uploadStaged(input)).rejects.toMatchObject({
        code: 'operation_uncertain',
      });
      expect(input.open).not.toHaveBeenCalled();
      expect(await f.claims()).toEqual([]);
      expect([...f.directories]).toEqual(['new-world']);
      // Root ownership survives the failed grant: recovery does not recreate it.
      await f.files.uploadStaged(input);
      expect(f.adapter.createDirectory).toHaveBeenCalledTimes(1);
      expect(f.uploaded.size).toBe(3);
      expect(await f.claims()).toEqual([]);
    });
  });
  it('lets native uploads create nested parents without preparatory descendant requests', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input(4);
      const open = input.open.getMockImplementation();
      const paths = new Map(
        input.files.map((file, index) => [`new-world/part${index}/region/file.mca`, file.path]),
      );
      input.files = input.files.map((file, index) => ({
        ...file,
        path: [...paths.keys()][index] as string,
      }));
      input.open.mockImplementation(
        (path) => open?.(paths.get(path) as string) as Promise<ReadableStream<Uint8Array>>,
      );
      const grants = f.adapter.prepareUploadBatch.getMockImplementation();
      f.adapter.prepareUploadBatch.mockImplementation(async (id, paths) => {
        expect([...f.directories]).toEqual(['new-world']);
        expect(input.open).not.toHaveBeenCalled();
        return grants?.(id, paths) as ReturnType<NonNullable<typeof grants>>;
      });
      await f.files.uploadStaged(input);
      expect(f.peak()).toBe(2);
      expect(f.active()).toBe(0);
      expect(f.adapter.createDirectory).toHaveBeenCalledExactlyOnceWith(
        f.context.server.pterodactyl_identifier,
        '',
        'new-world',
      );
      expect(f.adapter.prepareUploadBatch).toHaveBeenCalledOnce();
      expect(f.directories.size).toBe(9);
      for (const path of paths.keys())
        expect(f.directories.has(path.split('/').slice(0, -1).join('/'))).toBe(true);
      expect(f.uploaded.size).toBe(4);
      expect(await f.claims()).toEqual([]);
    });
  });
  it('does not issue grants or dispatch uploads if the destination root cannot be created', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input(4);
      f.adapter.createDirectory.mockRejectedValueOnce(new Error('root mkdir failed'));
      await expect(f.files.uploadStaged(input)).rejects.toThrow('root mkdir failed');
      expect(f.adapter.createDirectory).toHaveBeenCalledTimes(1);
      expect(f.adapter.prepareUploadBatch).not.toHaveBeenCalled();
      expect(input.open).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      expect(await f.claims()).toEqual([]);
    });
  });
  it('rechecks current authority after root preparation before opening any source', async () => {
    const f = await fixture();
    const input = f.input();
    const beforeWrite = vi
      .fn(async () => {})
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new DomainError('forbidden'));
    await expect(f.files.uploadStaged({ ...input, beforeWrite })).rejects.toMatchObject({
      code: 'operation_uncertain',
    });
    expect([...f.directories]).toEqual(['new-world']);
    expect(input.open).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.claims()).toEqual([]);
  });
  it('skips per-server disk telemetry for shared-pool storage while retaining batch admission', async () => {
    const f = await fixture();
    f.context.server.limits.disk = 0;
    f.adapter.getResources.mockRejectedValueOnce(new Error('unused telemetry'));
    await f.files.uploadStaged(f.input());
    expect(f.adapter.getResources).not.toHaveBeenCalled();
    expect(f.uploaded.size).toBe(3);
    expect(await f.claims()).toEqual([]);
  });
  it('waits for active streams and retains the fence after a lost acknowledgement without replaying it', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input(4);
      const normal = f.send.getMockImplementation();
      f.send.mockImplementationOnce(async (path, upload) => {
        await normal?.(path, upload);
        throw new Error('lost reply');
      });
      await expect(f.files.uploadStaged(input)).rejects.toMatchObject({
        code: 'operation_uncertain',
      });
      expect(f.active()).toBe(0);
      expect(await f.claims()).toHaveLength(1);
      const calls = f.send.mock.calls.length;
      await expect(f.files.uploadStaged(input)).rejects.toMatchObject({
        code: 'operation_uncertain',
      });
      expect(f.send).toHaveBeenCalledTimes(calls);
    });
  });
  it('cancels open sources and stops a waiting lane when another dispatch fails', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input(2);
      let opened!: () => void;
      const ready = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let unblock!: () => void;
      const wait = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const cancel = vi.fn();
      const normal = input.open.getMockImplementation();
      input.open.mockImplementation(async (path) => {
        if (path.endsWith('/0.mca')) {
          opened();
          await wait;
          return new ReadableStream({ cancel });
        }
        return normal?.(path) as Promise<ReadableStream<Uint8Array>>;
      });
      f.send.mockImplementationOnce(async () => {
        await ready;
        unblock();
        throw uploadNotDispatched(new DomainError('forbidden'));
      });
      await expect(f.files.uploadStaged(input)).rejects.toMatchObject({
        code: 'operation_uncertain',
      });
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledOnce();
      expect(await f.claims()).toEqual([]);
      expect(
        await db
          .selectFrom('job_steps')
          .select('step')
          .where('job_id', '=', f.context.operation().job_id)
          .where('step', 'like', '%.sent.%')
          .execute(),
      ).toEqual([]);
    });
  });
  it('refuses a foreign destination and invalid or changed manifests before writes', async () => {
    const f = await fixture();
    const input = f.input();
    f.directories.add('new-world');
    await expect(f.files.uploadStaged(input)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.claims()).toEqual([]);
    await expect(
      f.files.uploadStaged({
        ...input,
        files: [{ path: '../escape', size: 1, sha256: 'a'.repeat(64) }],
      }),
    ).rejects.toBeDefined();
    await expect(f.files.uploadStaged({ ...input, id: 'another.transfer' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
