import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createLogger, DomainError, type LogRecord } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { FilemanJobServices } from '@nickhosting/game-sdk';
import {
  createPterodactylAdapter,
  type FileArchiveCommit,
  type FileArchiveReceipt,
  type PterodactylAdapter,
} from '@nickhosting/pterodactyl-adapter';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  uploadCancelled,
  uploadNotDispatched,
} from '../../pterodactyl-adapter/src/upload-dispatch.js';
import {
  assertFilemanArchiveResumable,
  resumeFilemanArchive,
  uploadFilemanArchive,
} from './fileman-archive.js';
import { filemanTransferDigest, filemanTransferReceiptStep } from './fileman-transfers.js';
import { type GameLifecycleContext, processServerOperation } from './lifecycle.js';
import { managementFixture } from './test-fixtures.js';
import { assertNoPendingUpload } from './upload-admission.js';

type ArchiveInput = Parameters<NonNullable<FilemanJobServices['uploadArchive']>>[0];
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

describe('Fileman archive durable transfer', () => {
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
    let operation = await db
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
    const uploaded: Uint8Array[] = [];
    type SendInput = Parameters<Awaited<ReturnType<PterodactylAdapter['prepareUpload']>>>[0];
    const send = vi.fn(async (input: SendInput) => {
      await input.authorize?.();
      uploaded.push(new Uint8Array(await new Response(input.body).arrayBuffer()));
    });
    const adapter = {
      getResources: vi.fn(async () => ({ resources: { disk_bytes: 0 } })),
      listFiles: vi.fn(async () => []),
      prepareUpload: vi.fn(async () => send),
      commitFileArchive: vi.fn(
        async (
          _id: string,
          request: FileArchiveCommit,
          _trace?: boolean,
        ): Promise<FileArchiveReceipt> => ({
          ...request,
          state: 'confirmed' as const,
        }),
      ),
    };
    const update = vi.fn(async (patch: Parameters<GameLifecycleContext['update']>[0]) => {
      await db
        .updateTable('server_operations')
        .set({ ...patch, plan: patch.plan ? JSON.stringify(patch.plan) : undefined })
        .where('job_id', '=', operation.job_id)
        .execute();
      Object.assign(operation, patch);
    });
    const context: GameLifecycleContext = {
      db,
      server,
      adapter: adapter as unknown as PterodactylAdapter,
      operation: () => operation,
      authorize: async () => {},
      assertStopped: async () => {},
      event: async () => {},
      backup: async () => false,
      update,
      effect: vi.fn(async (phase, perform) => {
        await assertNoPendingUpload(db, serverId);
        await update({ phase, effect_started_at: new Date(), effect_state: 'prepared' });
        await perform();
        return true;
      }),
    };
    const options = {
      env: { NH_OBSERVER_ID: 'isolated-observer' },
      authorize: vi.fn(async () => f.context),
    };
    const input = (count = 3) => {
      const payload = Buffer.alloc(128, 42);
      const files = Array.from({ length: count }, (_, i) => ({
        path: `new-world/region/${i}.mca`,
        size: i + 1,
        sha256: sha256(Buffer.alloc(i + 1, i)),
      }));
      const complete = Promise.withResolvers<{ files: typeof files; bytes: number }>();
      void complete.promise.catch(() => {});
      const value = {
        id: 'fixture.archive',
        destinationRoot: 'new-world',
        sourceSha256: 'a'.repeat(64),
        files,
        contentLength: payload.length,
        open: vi.fn(() => {
          let emitted = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!emitted) {
                emitted = true;
                controller.enqueue(payload);
              } else {
                controller.close();
                complete.resolve({ files, bytes: files.reduce((n, f) => n + f.size, 0) });
              }
            },
            cancel(reason) {
              complete.reject(reason);
            },
          });
        }),
        completion: complete.promise,
        cancel: vi.fn((reason?: unknown) => complete.reject(reason)),
        beforeWrite: vi.fn(async () => {}),
        beforePublish: vi.fn(async () => {}),
      } satisfies ArchiveInput;
      return value;
    };
    const claims = () =>
      db
        .selectFrom('upload_ingestion_claims')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute();
    const reload = async () => {
      operation = await db
        .selectFrom('server_operations')
        .selectAll()
        .where('job_id', '=', operation.job_id)
        .executeTakeFirstOrThrow();
    };
    const run = (value: ArchiveInput) => uploadFilemanArchive(context, options, value);
    return {
      context,
      options,
      adapter,
      send,
      uploaded,
      input,
      claims,
      reload,
      update,
      run,
      owner: f.owner,
    };
  }

  it.each([false, true])(
    'resumes an exact retained archive without upload as a replacement Owner, legacy=%s',
    async (legacy) => {
      await database.db.connection().execute(async (db) => {
        const f = await fixture(db);
        const input = f.input();
        input.sourceSha256 = sha256(Buffer.alloc(128, 42));
        f.adapter.commitFileArchive.mockImplementationOnce(async (_id, request) => ({
          ...request,
          state: 'uncertain',
        }));
        await expect(f.run(input)).rejects.toMatchObject({ code: 'operation_uncertain' });
        const original = f.adapter.commitFileArchive.mock.calls[0]?.[1];
        if (legacy) {
          const journal = {
            ...(f.context.operation().plan.fileArchive as Record<string, unknown>),
          };
          delete journal.sourceSha256;
          delete journal.contentLength;
          await f.context.update({ plan: { ...f.context.operation().plan, fileArchive: journal } });
        }
        await f.reload();
        f.options.authorize.mockResolvedValue(f.owner);
        const expected = {
          id: input.id,
          destinationRoot: input.destinationRoot,
          files: input.files,
        };
        await assertFilemanArchiveResumable(f.context, f.options.authorize, expected);
        expect(f.adapter.commitFileArchive).toHaveBeenCalledTimes(1);
        expect(await f.claims()).toHaveLength(1);
        const receipt = await resumeFilemanArchive(f.context, f.options, {
          ...expected,
          beforePublish: input.beforePublish,
          beforeWrite: input.beforeWrite,
        });
        expect(receipt.manifest).toEqual(expected);
        expect(f.adapter.commitFileArchive.mock.calls[1]?.[1]).toEqual(original);
        expect(f.adapter.prepareUpload).toHaveBeenCalledTimes(1);
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(input.open).toHaveBeenCalledTimes(1);
        expect(await f.claims()).toEqual([]);
        expect(f.context.operation().plan.fileArchive).toMatchObject({ completed: true });
      });
    },
  );

  it.each(['manifest', 'claim', 'other-claim', 'authorization', 'guard', 'uncertain'] as const)(
    'keeps archive recovery fenced for %s',
    async (changed) => {
      await database.db.connection().execute(async (db) => {
        const f = await fixture(db);
        const input = f.input();
        f.adapter.commitFileArchive.mockImplementationOnce(async (_id, request) => ({
          ...request,
          state: 'uncertain',
        }));
        await expect(f.run(input)).rejects.toMatchObject({ code: 'operation_uncertain' });
        await f.reload();
        const expected = {
          id: input.id,
          destinationRoot: input.destinationRoot,
          files: input.files.map((file) => ({ ...file })),
          beforePublish: input.beforePublish,
        };
        if (changed === 'manifest')
          expected.files = expected.files.map((file) => ({ ...file, sha256: 'b'.repeat(64) }));
        if (changed === 'claim')
          await db
            .updateTable('upload_ingestion_claims')
            .set({ scope_hash: 'f'.repeat(64) })
            .execute();
        if (changed === 'other-claim') {
          const claim = (await f.claims())[0];
          if (!claim) throw new Error('Missing claim');
          await db
            .updateTable('upload_ingestion_claims')
            .set({ id: randomUUID() })
            .where('id', '=', claim.id)
            .execute();
        }
        if (changed === 'authorization')
          f.options.authorize.mockRejectedValueOnce(new DomainError('forbidden'));
        if (changed === 'guard')
          expected.beforePublish.mockRejectedValueOnce(new DomainError('conflict'));
        if (changed === 'uncertain')
          f.adapter.commitFileArchive.mockImplementationOnce(async (_id, request) => ({
            ...request,
            state: 'uncertain',
          }));
        await expect(resumeFilemanArchive(f.context, f.options, expected)).rejects.toBeInstanceOf(
          DomainError,
        );
        expect(f.adapter.commitFileArchive).toHaveBeenCalledTimes(changed === 'uncertain' ? 2 : 1);
        expect(f.send).toHaveBeenCalledTimes(1);
        expect((await f.claims()).length).toBeGreaterThan(0);
      });
    },
  );

  it('recovers a legacy crash after receipt settlement without a new upload or provider call', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      const originalUpdate = f.context.update;
      f.context.update = async (patch) => {
        if ((patch.plan?.fileArchive as { completed?: boolean })?.completed)
          throw new Error('Crashed after receipt settlement');
        await originalUpdate(patch);
      };
      await expect(f.run(input)).rejects.toMatchObject({ code: 'operation_uncertain' });
      f.context.update = originalUpdate;
      await f.reload();
      const journal = { ...(f.context.operation().plan.fileArchive as Record<string, unknown>) };
      delete journal.contentLength;
      delete journal.sourceSha256;
      await f.context.update({ plan: { ...f.context.operation().plan, fileArchive: journal } });
      const result = await resumeFilemanArchive(f.context, f.options, {
        id: input.id,
        destinationRoot: input.destinationRoot,
        files: input.files,
        beforePublish: input.beforePublish,
      });
      expect(result.files).toBe(3);
      expect(f.adapter.commitFileArchive).toHaveBeenCalledTimes(1);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.context.operation().plan.fileTransfer).toMatchObject({
        completedFiles: 3,
        completedBytes: 6,
      });
    });
  });

  it('streams 101 members through one upload, commits their digest, atomically settles, and returns its receipt without replay', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input(101);
      const receipt = await f.run(input);
      expect(receipt).toMatchObject({ files: 101, bytes: 5151 });
      expect(f.adapter.prepareUpload).toHaveBeenCalledExactlyOnceWith(
        f.context.server.pterodactyl_identifier,
        `.nickhosting-import-${f.context.operation().job_id}/payload.zip`,
        { readDirectory: expect.any(Function) },
      );
      expect(f.adapter.commitFileArchive).toHaveBeenCalledTimes(1);
      expect(f.adapter.commitFileArchive.mock.calls[0]?.[1].archiveSha256).toBe(
        sha256(f.uploaded[0] as Uint8Array),
      );
      expect(f.context.operation().plan.fileArchive).toMatchObject({
        commitDispatched: true,
        completed: true,
      });
      expect(f.context.operation().plan.fileTransfer).toMatchObject({
        completedFiles: 101,
        completedBytes: 5151,
      });
      expect(await f.claims()).toEqual([]);
      await f.reload();
      const replay = f.input(101);
      expect(await f.run(replay)).toEqual(receipt);
      expect(replay.open).not.toHaveBeenCalled();
      expect(f.adapter.commitFileArchive).toHaveBeenCalledTimes(1);
    });
  });

  function nativeUpload(
    f: Awaited<ReturnType<typeof fixture>>,
    hooks: { root?: () => Promise<unknown[]>; grant?: () => Promise<void> } = {},
  ) {
    const directories: string[] = [];
    const mutations: string[] = [];
    const adapter = createPterodactylAdapter({
      baseURL: 'https://panel.example.test',
      applicationKey: 'fixture-application-key',
      clientKey: 'fixture-client-key',
      uploadOrigins: ['https://wings.example.test'],
      fetcher: async (url, init) => {
        const target = new URL(String(url));
        if (target.pathname.endsWith('/files/list')) {
          const directory = target.searchParams.get('directory') ?? '';
          directories.push(directory);
          // Current Wings reports an absent directory as 500 rather than 404.
          if (directory !== '/') return new Response('directory absent', { status: 500 });
          return Response.json({
            object: 'list',
            data: (await hooks.root?.())?.map((attributes) => ({ attributes })) ?? [],
          });
        }
        if (target.pathname.endsWith('/files/upload')) {
          await hooks.grant?.();
          return Response.json({
            attributes: { url: 'https://wings.example.test/upload/file?token=fixture' },
          });
        }
        mutations.push(target.pathname);
        if (target.pathname === '/upload/file') {
          await new Response(init?.body).arrayBuffer();
          return new Response(null, { status: 204 });
        }
        if (target.pathname.endsWith('/files/rename')) return new Response(null, { status: 204 });
        throw new Error('Unexpected fixture request');
      },
    });
    f.context.adapter = {
      ...f.context.adapter,
      listFiles: adapter.listFiles,
      prepareUpload: adapter.prepareUpload,
    };
    return { directories, mutations };
  }

  it('uses the native upload adapter without requesting the missing scratch directory and keeps grant lookup parallel', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      const roots = Promise.withResolvers<unknown[]>();
      const grantEntered = Promise.withResolvers<void>();
      const native = nativeUpload(f, {
        root: () => roots.promise,
        grant: async () => grantEntered.resolve(),
      });
      const running = f.run(input);
      await grantEntered.promise;
      expect(input.open).not.toHaveBeenCalled();
      expect(f.context.effect).not.toHaveBeenCalled();
      expect(native.mutations).toEqual([]);
      roots.resolve([]);
      expect(await running).toMatchObject({ files: 3 });
      expect(native.directories).toEqual(['/']);
      expect(native.mutations).toEqual([
        '/upload/file',
        `/api/client/servers/${f.context.server.pterodactyl_identifier}/files/rename`,
      ]);
      expect(f.adapter.commitFileArchive).toHaveBeenCalledOnce();
      expect(await f.claims()).toEqual([]);
    });
  });

  it.each([
    ['scratch', false, false],
    ['scratch', true, true],
    ['destination', false, false],
    ['destination', true, true],
  ] as const)(
    'rejects existing %s root entries (symlink=%s, different case=%s) before native upload',
    async (kind, symlink, differentCase) => {
      await database.db.connection().execute(async (db) => {
        const f = await fixture(db);
        const input = f.input();
        const name =
          kind === 'scratch'
            ? `.nickhosting-import-${f.context.operation().job_id}`
            : input.destinationRoot;
        const native = nativeUpload(f, {
          root: async () => [
            {
              name: differentCase ? name.toUpperCase() : name,
              mode: 'drwxr-xr-x',
              mode_bits: '755',
              size: 0,
              is_file: false,
              is_symlink: symlink,
              mimetype: 'inode/directory',
              created_at: '',
              modified_at: '',
            },
          ],
        });
        await expect(f.run(input)).rejects.toMatchObject({ code: 'conflict' });
        expect(native.directories).toEqual(['/']);
        expect(native.mutations).toEqual([]);
        expect(input.open).not.toHaveBeenCalled();
        expect(f.context.effect).not.toHaveBeenCalled();
        expect(f.adapter.commitFileArchive).not.toHaveBeenCalled();
        expect(await f.claims()).toEqual([]);
      });
    },
  );

  it('joins the native grant lookup after a root failure without assuming absence or dispatching bytes', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      const releaseGrant = Promise.withResolvers<void>();
      const rootFailed = Promise.withResolvers<void>();
      const native = nativeUpload(f, {
        root: async () => {
          rootFailed.resolve();
          throw new Error('root unavailable');
        },
        grant: () => releaseGrant.promise,
      });
      let finished = false;
      const running = f.run(input);
      const observed = running.finally(() => {
        finished = true;
      });
      void observed.catch(() => {});
      await rootFailed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(native.mutations).toEqual([]);
      expect(input.open).not.toHaveBeenCalled();
      expect(await f.claims()).toEqual([]);
      releaseGrant.resolve();
      await expect(observed).rejects.toMatchObject({
        code: 'integration_unavailable',
        reason: 'unavailable',
      });
      expect(native.directories).toEqual(['/']);
      expect(f.context.effect).not.toHaveBeenCalled();
      expect(f.adapter.commitFileArchive).not.toHaveBeenCalled();
    });
  });

  it('overlaps the independent provider checks and token request, but waits for every gate before admission or streaming', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      const entered = new Set<string>();
      const allEntered = Promise.withResolvers<void>();
      const roots = Promise.withResolvers<never[]>();
      const quota = Promise.withResolvers<{ resources: { disk_bytes: number } }>();
      const token = Promise.withResolvers<typeof f.send>();
      const mark = (name: string) => {
        entered.add(name);
        if (entered.size === 3) allEntered.resolve();
      };
      f.adapter.listFiles.mockImplementationOnce(async () => {
        mark('root');
        return roots.promise;
      });
      f.adapter.getResources.mockImplementationOnce(async () => {
        mark('quota');
        return quota.promise;
      });
      f.adapter.prepareUpload.mockImplementationOnce(async () => {
        mark('token');
        return token.promise;
      });
      const running = f.run(input);
      await allEntered.promise;
      expect(f.options.authorize).toHaveBeenCalled();
      expect(input.beforeWrite).toHaveBeenCalled();
      expect(input.open).not.toHaveBeenCalled();
      expect(await f.claims()).toEqual([]);
      roots.resolve([]);
      token.resolve(f.send);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(input.open).not.toHaveBeenCalled();
      expect(await f.claims()).toEqual([]);
      quota.resolve({ resources: { disk_bytes: 0 } });
      await running;
      expect(input.open).toHaveBeenCalledOnce();
      expect(await f.claims()).toEqual([]);
    });
  });

  it.each(['root', 'quota', 'token'] as const)(
    'joins outstanding preflight work after %s fails and permits a proven undispatched retry',
    async (failed) => {
      await database.db.connection().execute(async (db) => {
        const f = await fixture(db);
        const input = f.input();
        const failure = new DomainError('conflict');
        const entered = new Set<string>();
        const allEntered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const read = async (name: string) => {
          entered.add(name);
          if (entered.size === 3) allEntered.resolve();
          if (name === failed) throw failure;
          await release.promise;
        };
        f.adapter.listFiles.mockImplementationOnce(async () => {
          await read('root');
          return [];
        });
        f.adapter.getResources.mockImplementationOnce(async () => {
          await read('quota');
          return { resources: { disk_bytes: 0 } };
        });
        f.adapter.prepareUpload.mockImplementationOnce(async () => {
          await read('token');
          return f.send;
        });
        const running = f.run(input);
        let finished = false;
        const observed = running.then(
          () => {
            finished = true;
          },
          () => {
            finished = true;
          },
        );
        await allEntered.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(finished).toBe(false);
        expect(input.open).not.toHaveBeenCalled();
        expect(await f.claims()).toEqual([]);
        release.resolve();
        await expect(running).rejects.toBe(failure);
        await observed;
        expect(f.context.effect).not.toHaveBeenCalled();
        expect(f.adapter.commitFileArchive).not.toHaveBeenCalled();
        await f.reload();
        await f.run(f.input());
        expect(f.send).toHaveBeenCalledOnce();
      });
    },
  );

  it('emits separate debug wall-clock upload/validation spans and optional nested provider timing without file paths', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const logs: LogRecord[] = [];
      f.context.logger = createLogger((record) => logs.push(record), { level: 'debug' });
      f.adapter.commitFileArchive.mockImplementationOnce(async (_id, request) => ({
        ...request,
        state: 'confirmed',
        timings: { decompress: 12, rename: 2 },
      }));
      await f.run(f.input());
      const stages = logs
        .filter((record) => record.event === 'servers.file_archive_stage')
        .map((record) => record.data as Record<string, unknown>);
      expect(stages.map((data) => data.stage)).toEqual(
        expect.arrayContaining([
          'preflight',
          'root_listing',
          'quota',
          'upload_token',
          'claim',
          'claim_journal',
          'upload',
          'validation',
          'manifest',
          'commit_journal',
          'before_publish',
          'commit',
          'receipts',
        ]),
      );
      for (const data of stages)
        expect(data).toMatchObject({
          outcome: 'ok',
          measurement: 'wall',
          startOffsetMs: expect.any(Number),
          durationMs: expect.any(Number),
          files: 3,
          archiveBytes: 128,
        });
      for (const stage of ['upload', 'validation'])
        expect(stages.find((data) => data.stage === stage)).toMatchObject({
          concurrentGroup: 'transfer',
        });
      expect(f.adapter.commitFileArchive.mock.calls[0]?.[2]).toBe(true);
      expect(
        logs.find((record) => record.event === 'servers.file_archive_provider')?.data,
      ).toMatchObject({ timings: { decompress: 12, rename: 2 } });
      expect(JSON.stringify(logs)).not.toContain('new-world');
      expect(JSON.stringify(logs)).not.toContain('payload.zip');
    });
  });

  it('preserves terminal quota rejection in the real lifecycle without preparing an effect or dispatching bytes', async () => {
    const f = await fixture();
    const db = database.db;
    const jobId = f.context.operation().job_id;
    const server = f.context.server;
    const input = f.input();
    await db
      .updateTable('server_operations')
      .set({
        action: 'minecraft-content',
        phase: 'planned',
        effect_state: 'none',
        effect_started_at: null,
        plan: JSON.stringify({
          minecraftContent: {
            command: { kind: 'world-import', archiveRef: jobId, targetWorld: 'new-world' },
            world: { existing: false },
            backupBefore: false,
            deletePaths: [],
          },
        }),
      })
      .where('job_id', '=', jobId)
      .execute();
    const node = await db
      .selectFrom('managed_nodes')
      .select('pterodactyl_node_id')
      .where('id', '=', server.node_id)
      .executeTakeFirstOrThrow();
    const allocations = await db
      .selectFrom('server_allocations')
      .selectAll()
      .where('server_id', '=', server.id)
      .execute();
    const primary = allocations.find((entry) => entry.is_primary);
    f.adapter.getResources.mockResolvedValue({
      resources: { disk_bytes: server.limits.disk * 1048576 },
    });
    const adapter = {
      ...f.adapter,
      getApplicationServer: vi.fn(async () => ({
        id: server.pterodactyl_id,
        uuid: server.pterodactyl_uuid,
        identifier: server.pterodactyl_identifier,
        external_id: server.external_id,
        node: node.pterodactyl_node_id,
        user: server.provider_user_id,
        allocation: primary?.pterodactyl_allocation_id,
        relationships: {
          allocations: {
            data: allocations.map((entry) => ({
              attributes: {
                id: entry.pterodactyl_allocation_id,
                assigned: true,
                ip: entry.address,
                port: entry.port,
              },
            })),
          },
        },
      })),
    } as unknown as PterodactylAdapter;
    const checkpoint = vi.fn(async () => {});
    expect(
      await processServerOperation(db, jobId, {
        adapter,
        authorizeEffect: async () => {},
        checkpoint,
        processGameContent: async (context) => {
          await uploadFilemanArchive(context, f.options, input);
          return true;
        },
      }),
    ).toBe('failed');
    expect(
      await db
        .selectFrom('operation_jobs')
        .select(['state', 'error_code'])
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'failed', error_code: 'resources_unavailable' });
    expect(
      await db
        .selectFrom('server_operations')
        .select(['effect_state', 'effect_started_at'])
        .where('job_id', '=', jobId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ effect_state: 'none', effect_started_at: null });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(input.open).not.toHaveBeenCalled();
    expect(f.adapter.prepareUpload).toHaveBeenCalledOnce();
    expect(f.adapter.commitFileArchive).not.toHaveBeenCalled();
    expect(await f.claims()).toEqual([]);
  });

  it('keeps archive diagnostics disabled at info level and tolerates a failing debug sink', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const sink = vi.fn();
      f.context.logger = createLogger(sink, { level: 'info' });
      await f.run(f.input());
      expect(sink).not.toHaveBeenCalled();
      expect(f.adapter.commitFileArchive.mock.calls[0]?.[2]).toBeUndefined();
      f.context.logger = createLogger(
        () => {
          throw new Error('sink failed');
        },
        { level: 'debug' },
      );
      await expect(f.run(f.input())).resolves.toMatchObject({ files: 3 });
    });
  });

  it.each(['not-dispatched', 'cancelled'] as const)(
    'cancels a stalled producer and releases admission only with %s adapter proof',
    async (kind) => {
      await database.db.connection().execute(async (db) => {
        const f = await fixture(db);
        const input = f.input();
        const failure = new DomainError('forbidden');
        f.send.mockRejectedValueOnce(
          kind === 'not-dispatched' ? uploadNotDispatched(failure) : uploadCancelled(failure),
        );
        await expect(f.run(input)).rejects.toBe(failure);
        expect(input.cancel).toHaveBeenCalled();
        expect(await f.claims()).toEqual([]);
        expect(f.context.operation().plan.fileArchive).toMatchObject({ retrySafe: true });
        expect(f.adapter.commitFileArchive).not.toHaveBeenCalled();
        await f.reload();
        await f.run(f.input());
        expect(await f.claims()).toEqual([]);
      });
    },
  );

  it('cancels immediately on an unproven send failure, retains its claim, and never retries the upload', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      f.send.mockRejectedValueOnce(new Error('connection lost before consuming body'));
      await expect(f.run(input)).rejects.toMatchObject({ code: 'operation_uncertain' });
      expect(input.cancel).toHaveBeenCalled();
      expect(await f.claims()).toHaveLength(1);
      await f.reload();
      await expect(f.run(f.input())).rejects.toMatchObject({ code: 'operation_uncertain' });
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.adapter.commitFileArchive).not.toHaveBeenCalled();
    });
  });

  it('replays the exact saved commit after a lost response without listing, admission or source consumption', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      f.adapter.commitFileArchive.mockRejectedValueOnce(
        new Error('response lost after provider confirmation'),
      );
      await expect(f.run(f.input())).rejects.toMatchObject({ code: 'operation_uncertain' });
      const original = structuredClone(f.adapter.commitFileArchive.mock.calls[0]?.[1]);
      expect(f.context.operation().plan.fileArchive).toMatchObject({
        commitDispatched: true,
        completed: false,
      });
      expect(await f.claims()).toHaveLength(1);
      await f.reload(); // JSONB changes object key order: replay must still preserve semantic identity.
      const replay = f.input();
      const receipt = await f.run(replay);
      expect(receipt.files).toBe(3);
      expect(f.adapter.commitFileArchive.mock.calls[1]?.[1]).toEqual(original);
      expect(replay.open).not.toHaveBeenCalled();
      expect(replay.beforePublish).toHaveBeenCalledOnce();
      expect(f.adapter.prepareUpload).toHaveBeenCalledOnce();
      expect(f.adapter.listFiles).toHaveBeenCalledOnce();
      expect(f.context.effect).toHaveBeenCalledOnce();
      expect(await f.claims()).toEqual([]);
    });
  });

  it('repeats the game guard after uploaded bytes were verified and persists dispatch only after it passes', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      input.beforePublish.mockRejectedValueOnce(new DomainError('conflict'));
      await expect(f.run(input)).rejects.toMatchObject({ code: 'operation_uncertain' });
      expect(f.context.operation().plan.fileArchive).toMatchObject({ commitDispatched: false });
      expect(f.adapter.commitFileArchive).not.toHaveBeenCalled();
      await f.reload();
      const replay = f.input();
      await f.run(replay);
      expect(replay.beforePublish).toHaveBeenCalledOnce();
      expect(replay.open).not.toHaveBeenCalled();
      expect(f.send).toHaveBeenCalledOnce();
      expect(await f.claims()).toEqual([]);
    });
  });

  it('never commits when source verification rejects after the body has begun', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      const verification = Promise.withResolvers<Awaited<typeof input.completion>>();
      const failure = new Error('CRC mismatch');
      input.completion = verification.promise;
      input.open.mockImplementationOnce(() => {
        let emitted = false;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!emitted) {
              emitted = true;
              controller.enqueue(Buffer.alloc(64));
            } else {
              verification.reject(failure);
              controller.error(failure);
            }
          },
        });
      });
      await expect(f.run(input)).rejects.toMatchObject({ code: 'operation_uncertain' });
      expect(input.cancel).toHaveBeenCalled();
      expect(f.adapter.commitFileArchive).not.toHaveBeenCalled();
      expect(await f.claims()).toHaveLength(1);
      expect(f.context.operation().plan.fileArchive).not.toHaveProperty('request');
    });
  });

  it('joins a cancelled sender and its delayed authorization before releasing the claim and connection', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      const verification = Promise.withResolvers<Awaited<typeof input.completion>>();
      input.completion = verification.promise;
      const started = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const finishSender = Promise.withResolvers<void>();
      const failure = new DomainError('validation_failed');
      let authorizationFinished = false;
      f.send.mockImplementationOnce(async (request) => {
        request.signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
        started.resolve();
        await aborted.promise;
        await finishSender.promise;
        await request.authorize?.();
        authorizationFinished = true;
        throw uploadCancelled(new Error('confirmed incomplete multipart'));
      });
      const running = f.run(input);
      let finished = false;
      const observed = running.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await started.promise;
      verification.reject(failure);
      await aborted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(authorizationFinished).toBe(false);
      expect(await f.claims()).toHaveLength(1);
      finishSender.resolve();
      await expect(running).rejects.toBe(failure);
      await observed;
      expect(authorizationFinished).toBe(true);
      expect(input.cancel).toHaveBeenCalledOnce();
      expect(await f.claims()).toEqual([]);
      expect(f.adapter.commitFileArchive).not.toHaveBeenCalled();
    });
  });

  it('drains an authorization callback that outlives the sender abort race', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const failure = uploadNotDispatched(new Error('sender aborted its authorization race'));
      let authorizationFinished = false;
      f.send.mockImplementationOnce(async (request) => {
        input.beforeWrite.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          // This query must still use our pinned connection and retained claim.
          expect(await f.claims()).toHaveLength(1);
          authorizationFinished = true;
        });
        void request.authorize?.().catch(() => {});
        await entered.promise;
        throw failure;
      });
      const running = f.run(input);
      let finished = false;
      const observed = running.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      expect(authorizationFinished).toBe(false);
      expect(await f.claims()).toHaveLength(1);
      release.resolve();
      await expect(running).rejects.toBe(failure);
      await observed;
      expect(authorizationFinished).toBe(true);
      expect(await f.claims()).toEqual([]);
    });
  });

  it('releases all session lock counts after failure and refuses recovery while that exact claim is actively held', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      f.adapter.commitFileArchive.mockRejectedValueOnce(new Error('response lost'));
      await expect(f.run(f.input())).rejects.toMatchObject({ code: 'operation_uncertain' });
      const claim = (await f.claims())[0];
      expect(claim).toBeDefined();
      const key = `:nickhosting:upload:${claim?.id}`;
      await database.db.connection().execute(async (other) => {
        const held = await sql<{
          acquired: boolean;
        }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${key},0)) as acquired`.execute(
          other,
        );
        expect(held.rows[0]?.acquired).toBe(true);
        try {
          await f.reload();
          await expect(f.run(f.input())).rejects.toMatchObject({ code: 'operation_uncertain' });
          expect(f.adapter.commitFileArchive).toHaveBeenCalledOnce();
          expect(await f.claims()).toHaveLength(1);
        } finally {
          await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${key},0))`.execute(
            other,
          );
        }
      });
      await f.run(f.input());
      expect(await f.claims()).toEqual([]);
    });
  });

  it('keeps an uncertain provider commit claim and refuses recovery after the game guard or authorization changes', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      f.adapter.commitFileArchive.mockRejectedValueOnce(new Error('uncertain provider commit'));
      await expect(f.run(f.input())).rejects.toMatchObject({ code: 'operation_uncertain' });
      await f.reload();
      const replay = f.input();
      replay.beforePublish.mockRejectedValueOnce(new DomainError('conflict'));
      await expect(f.run(replay)).rejects.toMatchObject({ code: 'conflict' });
      f.options.authorize.mockRejectedValueOnce(new DomainError('forbidden'));
      await expect(f.run(f.input())).rejects.toMatchObject({ code: 'forbidden' });
      expect(f.adapter.commitFileArchive).toHaveBeenCalledOnce();
      expect(f.send).toHaveBeenCalledOnce();
      expect(await f.claims()).toHaveLength(1);
    });
  });

  it('recovers a crash after atomic receipt settlement but before the completed plan update', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const originalUpdate = f.context.update;
      f.context.update = async (patch) => {
        if ((patch.plan?.fileArchive as { completed?: boolean })?.completed)
          throw new Error('worker crashed');
        await originalUpdate(patch);
      };
      await expect(f.run(f.input())).rejects.toMatchObject({ code: 'operation_uncertain' });
      expect(await f.claims()).toEqual([]);
      expect(f.context.operation().plan.fileArchive).toMatchObject({ completed: false });
      await f.reload();
      f.context.update = originalUpdate;
      const replay = f.input();
      await f.run(replay);
      expect(replay.open).not.toHaveBeenCalled();
      expect(f.adapter.commitFileArchive).toHaveBeenCalledTimes(2);
      expect(f.context.operation().plan.fileArchive).toMatchObject({ completed: true });
      expect(await f.claims()).toEqual([]);
    });
  });

  it('settles a retained exact claim even if a prior writer persisted completed before settlement', async () => {
    await database.db.connection().execute(async (db) => {
      const f = await fixture(db);
      const input = f.input();
      f.adapter.commitFileArchive.mockRejectedValueOnce(new Error('lost'));
      await expect(f.run(input)).rejects.toMatchObject({ code: 'operation_uncertain' });
      const journal = f.context.operation().plan.fileArchive as Record<string, unknown>;
      const manifest = { id: input.id, destinationRoot: input.destinationRoot, files: input.files };
      await db
        .insertInto('job_steps')
        .values({
          job_id: f.context.operation().job_id,
          step: filemanTransferReceiptStep(filemanTransferDigest(manifest)),
        })
        .execute();
      await f.context.update({
        plan: { ...f.context.operation().plan, fileArchive: { ...journal, completed: true } },
      });
      await f.reload();
      await f.run(f.input());
      expect(await f.claims()).toEqual([]);
      expect(f.adapter.prepareUpload).toHaveBeenCalledOnce();
      expect(f.adapter.commitFileArchive).toHaveBeenCalledTimes(2);
    });
  });

  it.each(['source', 'identity', 'claim-scope'] as const)(
    'refuses altered %s during recovery before any provider commit or capacity release',
    async (changed) => {
      await database.db.connection().execute(async (db) => {
        const f = await fixture(db);
        f.adapter.commitFileArchive.mockRejectedValueOnce(new Error('lost'));
        await expect(f.run(f.input())).rejects.toMatchObject({ code: 'operation_uncertain' });
        await f.reload();
        const replay = f.input();
        if (changed === 'source') replay.sourceSha256 = 'b'.repeat(64);
        if (changed === 'identity') f.context.server.pterodactyl_id = 99999;
        if (changed === 'claim-scope')
          await db
            .updateTable('upload_ingestion_claims')
            .set({ scope_hash: 'f'.repeat(64) })
            .execute();
        await expect(f.run(replay)).rejects.toBeInstanceOf(DomainError);
        expect(f.adapter.commitFileArchive).toHaveBeenCalledOnce();
        expect(replay.open).not.toHaveBeenCalled();
        expect(await f.claims()).toHaveLength(1);
      });
    },
  );
});
