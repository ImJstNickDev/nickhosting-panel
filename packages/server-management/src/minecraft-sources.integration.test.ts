import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ContentHttp } from '@nickhosting/content-providers';
import { authSessionId } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindMinecraftSource,
  createMinecraftSourceStore,
  reserveMinecraftStaging,
} from './minecraft-sources.js';
import { enqueueServerOperation } from './registry.js';
import { managementFixture } from './test-fixtures.js';
import { reserveUploadIngestion } from './upload-admission.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let root: string;
let env: Record<string, string>;
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const binary = new Uint8Array([0x50, 0x4b, 0, 0xff, 17, 0, 4]);
function stream(bytes = binary) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
function uploadInput(patch = {}) {
  return {
    kind: 'modpack',
    idempotencyKey: randomUUID(),
    bytes: binary.length,
    sha256: digest(binary),
    ...patch,
  };
}
function store(patch: Record<string, string> = {}) {
  return createMinecraftSourceStore(f.db, f.context, { ...env, ...patch });
}
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  await database.db.deleteFrom('minecraft_staging_claims').execute();
  await database.db.deleteFrom('minecraft_source_bindings').execute();
  await database.db.deleteFrom('minecraft_sources').execute();
  f = await managementFixture(database.db, { interactive: true });
  root = `./mountdata/test-assets/m4-sources-${randomUUID()}`;
  env = {
    NH_MINECRAFT_SOURCE_ROOT: root,
    NH_MINECRAFT_CONTENT_ROOT: `${root}/expanded`,
    NH_MINECRAFT_SOURCE_FREE_BYTES: '0',
    NH_MINECRAFT_SOURCE_FREE_PERCENT: '0',
  };
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('durable Minecraft archive source admission', () => {
  it('streams exact binary input, exposes only opaque metadata, and verifies immutable creation sources', async () => {
    const service = store();
    const source = await service.reserveUpload(uploadInput());
    expect(source.state).toBe('reserved');
    expect(source).not.toHaveProperty('storage_root');
    expect(source).not.toHaveProperty('path');
    const result = await service.upload(source.id, stream(), binary.length);
    expect(result.state).toBe('ready');
    expect(result.sha256).toBe(digest(binary));
    const resolved = await service.resolveForCreation(source.id);
    expect(resolved.sha256).toBe(digest(binary));
    expect(await readFile(resolved.path)).toEqual(Buffer.from(binary));
    const serverId = await f.server();
    await expect(service.archiveResolver(source.id, serverId)).rejects.toThrow('forbidden');
    await f.db
      .transaction()
      .execute((tx) => bindMinecraftSource(tx, f.context, source.id, serverId, env));
    expect(await service.archiveResolver(source.id, serverId)).toBe(resolved.path);
    expect(
      await createMinecraftSourceStore(f.db, f.owner, env).archiveResolver(source.id, serverId),
    ).toBe(resolved.path);
    await expect(service.worldArchiveResolver(source.id, serverId)).rejects.toThrow('conflict');
    const otherServer = await f.server();
    await service.bindSource(source.id, otherServer);
    expect(await service.archiveResolver(source.id, otherServer)).toBe(resolved.path);
    // Binding is separate; a user's exact archive remains usable for another creation.
    expect(await service.resolveForCreation(source.id)).toEqual(resolved);
    await writeFile(resolved.path, new Uint8Array(binary.length));
    await expect(service.resolveForCreation(source.id)).rejects.toThrow('conflict');
  });
  it('retains per-server scope and denies other users even when they know a reference', async () => {
    const serverId = await f.server();
    const source = await store().reserveUpload(uploadInput({ kind: 'world', serverId }));
    await store().upload(source.id, stream(), binary.length);
    expect((await store().worldArchiveResolver(source.id, serverId)).sha256).toBe(digest(binary));
    await expect(store().worldArchiveResolver(source.id, await f.server())).rejects.toThrow(
      'forbidden',
    );
    const other = await managementFixture(f.db, { interactive: true });
    await expect(
      createMinecraftSourceStore(f.db, other.context, env).inspect(source.id),
    ).rejects.toThrow('forbidden');
    await expect(
      createMinecraftSourceStore(f.db, other.context, env).reserveUpload(uploadInput({ serverId })),
    ).rejects.toThrow('forbidden');
  });
  it('resolves a server-scoped modpack for reinstall without allowing creation or another server', async () => {
    const serverId = await f.server();
    const service = store();
    const source = await service.reserveUpload(uploadInput({ serverId }));
    await service.upload(source.id, stream(), binary.length);
    const resolved = await service.resolveForServer(source.id, serverId);
    expect(resolved.sha256).toBe(digest(binary));
    expect(await readFile(resolved.path)).toEqual(Buffer.from(binary));
    await expect(service.resolveForCreation(source.id)).rejects.toThrow('conflict');
    await expect(service.resolveForServer(source.id, await f.server())).rejects.toThrow(
      'forbidden',
    );
    const other = await managementFixture(f.db, { interactive: true });
    await expect(
      createMinecraftSourceStore(f.db, other.context, env).resolveForServer(source.id, serverId),
    ).rejects.toThrow('forbidden');
    await writeFile(resolved.path, new Uint8Array(binary.length));
    await expect(service.resolveForServer(source.id, serverId)).rejects.toThrow('conflict');
  });
  it.each(['upload-first', 'source-first'] as const)(
    'serializes shared disk reservations with M2 ingestion in %s order',
    async (order) => {
      const serverId = await f.server();
      await f.db
        .updateTable('physical_hosts')
        .set({
          disk_headroom_mib: '0',
          upload_policy: JSON.stringify({
            providerMaxFileBytes: 1048576,
            temporaryDiskPath: '/isolated-staging',
            temporaryDiskBudgetBytes: 2097152,
            temporaryDiskHeadroomBytes: 0,
          }),
        })
        .where('id', '=', f.hostId)
        .execute();
      const space = 100000n;
      const service = createMinecraftSourceStore(f.db, f.context, env, {
        observeDisk: async () => ({ available: space, total: space }),
      });
      await f.db.connection().execute(async (connection) => {
        let claim: Awaited<ReturnType<typeof reserveUploadIngestion>> | undefined;
        const upload = () =>
          reserveUploadIngestion(
            connection,
            f.context,
            serverId,
            1,
            { NH_OBSERVER_ID: 'isolated-observer' },
            { availableBytes: async () => space },
          );
        try {
          if (order === 'upload-first') {
            claim = await upload();
            await expect(service.reserveUpload(uploadInput())).rejects.toThrow(
              'resources_unavailable',
            );
          } else {
            await service.reserveUpload(uploadInput());
            await expect(upload()).rejects.toThrow('resources_unavailable');
          }
        } finally {
          await claim?.complete();
          await claim?.unlock();
        }
      });
    },
  );
  it.each(['upload-first', 'stage-first'] as const)(
    'shares M2 disk admission with expanded staging in %s order',
    async (order) => {
      const uploadServer = await f.server(),
        stageServer = await f.server();
      await f.db
        .updateTable('physical_hosts')
        .set({
          disk_headroom_mib: '0',
          upload_policy: JSON.stringify({
            providerMaxFileBytes: 1048576,
            temporaryDiskPath: '/isolated-staging',
            temporaryDiskBudgetBytes: 2097152,
            temporaryDiskHeadroomBytes: 0,
          }),
        })
        .where('id', '=', f.hostId)
        .execute();
      const operation = await enqueueServerOperation(f.db, f.context, stageServer, {
        action: 'reinstall',
        idempotencyKey: randomUUID(),
        confirm: true,
      });
      await f.db
        .updateTable('operation_jobs')
        .set({ state: 'running', completed_at: null })
        .where('id', '=', operation.jobId)
        .execute();
      const space = 100000n;
      const stage = () =>
        reserveMinecraftStaging(f.db, f.context, operation.jobId, stageServer, 1, env, {
          observeDisk: async () => ({ available: space, total: space }),
        });
      await f.db.connection().execute(async (connection) => {
        let claim: Awaited<ReturnType<typeof reserveUploadIngestion>> | undefined;
        const upload = () =>
          reserveUploadIngestion(
            connection,
            f.context,
            uploadServer,
            1,
            { NH_OBSERVER_ID: 'isolated-observer' },
            { availableBytes: async () => space },
          );
        try {
          if (order === 'upload-first') {
            claim = await upload();
            await expect(stage()).rejects.toThrow('resources_unavailable');
          } else {
            await stage();
            await expect(upload()).rejects.toThrow('resources_unavailable');
          }
        } finally {
          await claim?.complete();
          await claim?.unlock();
        }
      });
    },
  );
  it('deduplicates repeated previews and refuses changes to an idempotency key', async () => {
    const service = store();
    const input = uploadInput();
    const result = await service.reserveUpload(input);
    expect((await service.reserveUpload(input)).id).toBe(result.id);
    expect((await service.reserveUpload({ ...input, idempotencyKey: randomUUID() })).id).toBe(
      result.id,
    );
    await expect(service.reserveUpload({ ...input, sha256: 'a'.repeat(64) })).rejects.toThrow(
      'conflict',
    );
    expect(await f.db.selectFrom('minecraft_sources').select('id').execute()).toHaveLength(1);
  });
  it('atomically caps concurrent claims and charges ready data against byte budgets', async () => {
    const service = store({ NH_MINECRAFT_SOURCE_USER_CONCURRENT: '1' });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        service.reserveUpload(uploadInput({ sha256: i.toString(16).repeat(64) })),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const source = await f.db.selectFrom('minecraft_sources').selectAll().executeTakeFirstOrThrow();
    await f.db
      .updateTable('minecraft_sources')
      .set({ state: 'ready', actual_sha256: '0'.repeat(64) })
      .where('id', '=', source.id)
      .execute();
    await expect(
      store({ NH_MINECRAFT_SOURCE_GLOBAL_BYTES: '100000' }).reserveUpload(
        uploadInput({ sha256: 'f'.repeat(64) }),
      ),
    ).rejects.toThrow('resources_unavailable');
  });
  it('observes disk under the resource lock and subtracts outstanding claims', async () => {
    const observeDisk = vi.fn(async () => ({ available: 100000n, total: 100000n }));
    const service = createMinecraftSourceStore(f.db, f.context, env, { observeDisk });
    await service.reserveUpload(uploadInput());
    await expect(service.reserveUpload(uploadInput({ sha256: 'a'.repeat(64) }))).rejects.toThrow(
      'resources_unavailable',
    );
    expect(observeDisk).toHaveBeenCalledTimes(2);
  });
  it.each(['short', 'long', 'hash'] as const)(
    'retains a charged uncertain claim after %s input',
    async (failure) => {
      const service = store();
      const source = await service.reserveUpload(uploadInput());
      const bytes =
        failure === 'short'
          ? binary.subarray(0, 2)
          : failure === 'long'
            ? new Uint8Array(binary.length + 1)
            : new Uint8Array(binary.length);
      await expect(service.upload(source.id, stream(bytes), binary.length)).rejects.toThrow();
      expect((await service.inspect(source.id)).state).toBe('uncertain');
      expect(await lstat(join(root, source.id, 'archive.bin'))).toBeTruthy();
      await expect(service.upload(source.id, stream(), binary.length)).rejects.toThrow(
        'operation_uncertain',
      );
      await expect(service.resolveForCreation(source.id)).rejects.toThrow('conflict');
    },
  );
  it('interrupts a stalled body on session revocation and prevents recovery while writing', async () => {
    const service = store();
    const source = await service.reserveUpload(uploadInput());
    const cancelled = vi.fn();
    const stalled = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const upload = service.upload(source.id, stalled, binary.length);
    const failed = expect(upload).rejects.toThrow();
    for (let i = 0; i < 100; i++) {
      const row = await f.db
        .selectFrom('minecraft_sources')
        .select('state')
        .where('id', '=', source.id)
        .executeTakeFirstOrThrow();
      if (row.state === 'receiving') break;
      await new Promise((done) => setTimeout(done, 10));
    }
    const recovery = {
      confirm: true,
      identityDigest: source.identityDigest,
      unusedByJobs: true,
      filesRemoved: true,
      transferStopped: true,
      reason: 'Isolated test recovery',
      evidence: 'Isolated directory is intentionally checked by this test.',
    };
    await expect(
      createMinecraftSourceStore(f.db, f.owner, env).recover(source.id, recovery),
    ).rejects.toThrow('conflict');
    await f.db
      .deleteFrom('session')
      .where('id', '=', f.context[authSessionId] ?? '')
      .execute();
    await failed;
    expect(cancelled).toHaveBeenCalled();
    const row = await f.db
      .selectFrom('minecraft_sources')
      .select('state')
      .where('id', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('uncertain');
  });
  it('requires audited Owner recovery and independently checks the scoped directory is absent', async () => {
    const service = store();
    const source = await service.reserveUpload(uploadInput());
    await expect(
      service.upload(source.id, stream(new Uint8Array(2)), binary.length),
    ).rejects.toThrow();
    const recovery = {
      confirm: true,
      identityDigest: source.identityDigest,
      unusedByJobs: true,
      filesRemoved: true,
      transferStopped: true,
      reason: 'Isolated test recovery',
      evidence: 'The exact test-created directory was removed by its test fixture.',
    };
    const ownerStore = createMinecraftSourceStore(f.db, f.owner, env);
    await expect(service.recover(source.id, recovery)).rejects.toThrow('forbidden');
    await expect(ownerStore.recover(source.id, recovery)).rejects.toThrow('conflict');
    await rm(join(root, source.id), { recursive: true });
    await expect(
      ownerStore.recover(source.id, { ...recovery, identityDigest: 'a'.repeat(64) }),
    ).rejects.toThrow('conflict');
    await ownerStore.recover(source.id, recovery);
    expect((await service.inspect(source.id)).state).toBe('released');
    const retry = await service.reserveUpload(uploadInput());
    expect(retry.id).not.toBe(source.id);
    expect(
      await f.db
        .selectFrom('audit_events')
        .select('id')
        .where('action', '=', 'minecraft.source.released')
        .execute(),
    ).toHaveLength(1);
  });
  it('refuses symlink destinations without writing to their target', async () => {
    const source = await store().reserveUpload(uploadInput());
    const other = join(root, 'unrelated');
    await writeFile(other, 'preserve');
    await symlink(resolve(other), join(root, source.id));
    await expect(store().upload(source.id, stream(), binary.length)).rejects.toThrow();
    expect(await readFile(other, 'utf8')).toBe('preserve');
    expect((await store().inspect(source.id)).state).toBe('uncertain');
  });
  it('charges expanded job staging against the same archive budget and preserves claims until audited cleanup', async () => {
    await store().reserveUpload(uploadInput());
    const serverId = await f.server();
    const operation = await f.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    const jobId = operation.job_id;
    await f.db
      .updateTable('operation_jobs')
      .set({ state: 'running', completed_at: null })
      .where('id', '=', jobId)
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: jobId })
      .where('id', '=', serverId)
      .execute();
    await expect(
      reserveMinecraftStaging(f.db, f.context, jobId, serverId, 7, {
        ...env,
        NH_MINECRAFT_SOURCE_GLOBAL_BYTES: '130000',
      }),
    ).rejects.toThrow('resources_unavailable');
    const claim = await reserveMinecraftStaging(f.db, f.context, jobId, serverId, 7, env);
    expect(await reserveMinecraftStaging(f.db, f.context, jobId, serverId, 7, env)).toEqual(claim);
    await expect(reserveMinecraftStaging(f.db, f.context, jobId, serverId, 8, env)).rejects.toThrow(
      'conflict',
    );
    await expect(
      store({ NH_MINECRAFT_SOURCE_GLOBAL_BYTES: '150000' }).reserveUpload(
        uploadInput({ sha256: 'b'.repeat(64) }),
      ),
    ).rejects.toThrow('resources_unavailable');
    const owner = createMinecraftSourceStore(f.db, f.owner, env);
    const recovery = {
      confirm: true,
      identityDigest: claim.identityDigest,
      filesRemoved: true,
      workerStopped: true,
      reason: 'Completed test stage cleanup',
      evidence: 'The test does not create stage output; generated root was verified empty.',
    };
    await expect(owner.recoverStaging(jobId, recovery)).rejects.toThrow('conflict');
    await f.db
      .updateTable('operation_jobs')
      .set({ state: 'succeeded', completed_at: new Date() })
      .where('id', '=', jobId)
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', serverId)
      .execute();
    await owner.recoverStaging(jobId, recovery);
    expect((await owner.ownerInventory()).stages).toHaveLength(0);
    await expect(store().ownerInventory()).rejects.toThrow('forbidden');
  });
  it('acquires a provider archive only after its durable claim and reuses it without downloads', async () => {
    const download = vi.fn(async (_artifact, path: string) => {
      const claim = await f.db
        .selectFrom('minecraft_sources')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(claim.state).toBe('receiving');
      expect(Number(claim.reserved_bytes)).toBeGreaterThan(binary.length);
      await writeFile(path, binary, { flag: 'wx' });
      return { sha256: digest(binary), size: binary.length };
    });
    const http: ContentHttp = {
      json: async (url) =>
        url.includes('/project/')
          ? {
              id: 'project',
              title: 'Fixture pack',
              project_type: 'modpack',
              server_side: 'required',
            }
          : {
              id: 'version',
              project_id: 'project',
              name: 'Fixture',
              version_number: '1',
              game_versions: ['1.21.1'],
              loaders: ['fabric'],
              date_published: new Date().toISOString(),
              files: [
                {
                  url: 'https://cdn.modrinth.com/fixture.mrpack',
                  filename: 'fixture.mrpack',
                  size: binary.length,
                  hashes: { sha256: digest(binary) },
                  primary: true,
                },
              ],
            },
      download,
    };
    const service = createMinecraftSourceStore(f.db, f.context, env, { http });
    const input = { projectId: 'project', versionId: 'version', idempotencyKey: randomUUID() };
    const first = await service.acquireModrinth(input);
    expect(first.state).toBe('ready');
    expect((await service.acquireModrinth({ ...input, idempotencyKey: randomUUID() })).id).toBe(
      first.id,
    );
    expect(download).toHaveBeenCalledTimes(1);
    await expect(
      service.acquireModrinth({ ...input, projectId: 'https://internal.test' }),
    ).rejects.toThrow('validation_failed');
    await expect(
      service.acquireModrinth({ ...input, url: 'https://internal.test' }),
    ).rejects.toThrow('validation_failed');
    expect(download).toHaveBeenCalledTimes(1);
  });
});
