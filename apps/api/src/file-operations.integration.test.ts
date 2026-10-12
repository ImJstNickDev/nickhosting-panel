import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ServerFile } from '@nickhosting/pterodactyl-adapter';
import { authorizeServer, type ManagementRuntime } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerServerRoutes } from './servers.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
let app: Hono<{ Variables: Variables }>;
let files: Map<string, Buffer | null>;
let service: ManagementRuntime;
let stage: string;
afterEach(async () => {
  if (stage) await rm(stage, { recursive: true, force: true });
});
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  serverId = await f.server();
  files = new Map([
    ['source', null],
    ['source/a.txt', Buffer.from('hello')],
    ['source/empty', null],
    ['target', null],
  ]);
  stage = `./mountdata/test-assets/file-test-${randomUUID()}`;
  await f.db
    .updateTable('physical_hosts')
    .set({
      local_disk_path: '/tmp',
      disk_headroom_mib: '1',
      upload_policy: JSON.stringify({
        providerMaxFileBytes: 10 * 1024 ** 2,
        temporaryDiskPath: '/tmp',
        temporaryDiskBudgetBytes: 100 * 1024 ** 2,
        temporaryDiskHeadroomBytes: 0,
      }),
    })
    .where('id', '=', f.hostId)
    .execute();
  const adapter = {
    renameFiles: vi.fn(async () => {}),
    listFiles: vi.fn(
      async (_id: string, path: string): Promise<ServerFile[]> =>
        [...files].flatMap(([name, data]) => {
          const prefix = path ? `${path}/` : '';
          if (!name.startsWith(prefix)) return [];
          const base = name.slice(prefix.length);
          if (base.includes('/')) return [];
          return [
            {
              name: base,
              size: data?.length ?? 0,
              is_file: data !== null,
              is_symlink: false,
              mode: '0644',
              mimetype: 'text/plain',
              created_at: '',
              modified_at: '',
            },
          ];
        }),
    ),
    getResources: vi.fn(async () => ({ resources: { disk_bytes: 0 } })),
    createDirectory: vi.fn(async (_id: string, root: string, name: string) => {
      const path = [root, name].filter(Boolean).join('/');
      if (files.has(path)) throw new DomainError('conflict');
      files.set(path, null);
    }),
    downloadFile: vi.fn(async (_id: string, path: string) => {
      const data = files.get(path);
      if (!data) throw new Error('missing');
      return {
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(data);
            c.close();
          },
        }),
      };
    }),
    uploadFile: vi.fn(
      async (_id: string, path: string, input: { body: ReadableStream<Uint8Array> }) => {
        files.set(path, Buffer.from(await new Response(input.body).arrayBuffer()));
      },
    ),
  };
  service = {
    adapter,
    assertFileMutation: vi.fn(async () => {}),
    authorizeTransfer: async (context: AuthContext, id: string, write: boolean) => {
      await authorizeServer(f.db, context, id, write ? 'server:manage' : 'server:read');
    },
    access: async (
      context: AuthContext,
      id: string,
      write: boolean,
      work: Parameters<ManagementRuntime['access']>[3],
    ) => {
      const server = await authorizeServer(
        f.db,
        context,
        id,
        write ? 'server:manage' : 'server:read',
      );
      return work('fixture', f.db, context, server);
    },
  } as unknown as ManagementRuntime;
  app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  registerServerRoutes(app, {
    db: f.db,
    env: { NH_OBSERVER_ID: 'isolated-observer', NH_FILE_OPERATIONS_ROOT: stage },
    principal: async () => f.context,
    management: async () => service,
    acquireUploadSlot: () => () => {},
  });
});
async function post(action: string, body: unknown, id = serverId) {
  return app.request(`/v1/servers/${id}/files/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function moveFiles(files: { from: string; to: string }[], overwrite?: string[]) {
  return app.request(`/v1/servers/${serverId}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'rename', root: '', files, overwrite }),
  });
}
describe('file operation handlers with isolated authoritative database', () => {
  it.each([false, true])(
    'rechecks mutation authorization after batch move preflight (overwrite %s)',
    async (overwrite) => {
      if (overwrite) files.set('target/a.txt', Buffer.from('existing'));
      const request = () =>
        moveFiles(
          [{ from: 'source/a.txt', to: 'target/a.txt' }],
          overwrite ? ['target/a.txt'] : undefined,
        );
      expect((await request()).status).toBe(204);
      expect(service.adapter.renameFiles).toHaveBeenCalledTimes(1);
      vi.mocked(service.adapter.renameFiles).mockClear();
      service.authorizeTransfer = async () => {
        throw new DomainError('forbidden');
      };
      expect((await request()).status).toBe(403);
      expect(service.adapter.renameFiles).not.toHaveBeenCalled();
    },
  );

  it('requires exact overwrite consent, preserves protected-path checks and audits the request', async () => {
    files.set('target/a.txt', Buffer.from('existing'));
    const moves = [{ from: 'source/a.txt', to: 'target/a.txt' }];
    expect((await moveFiles(moves)).status).toBe(409);
    expect(service.adapter.renameFiles).not.toHaveBeenCalled();
    expect((await moveFiles(moves, ['target/a.txt'])).status).toBe(204);
    expect(service.adapter.renameFiles).toHaveBeenCalledExactlyOnceWith('fixture', '', moves);
    expect(service.assertFileMutation).toHaveBeenCalledWith(
      serverId,
      ['source/a.txt', 'target/a.txt'],
      f.db,
    );
    const audit = await f.db
      .selectFrom('audit_events')
      .select('metadata')
      .where('action', '=', 'server.files.requested')
      .execute();
    expect(audit).toContainEqual({
      metadata: { serverId, action: 'rename', overwrite: ['target/a.txt'] },
    });
  });

  it('rechecks a colliding destination type when overwrite consent arrives', async () => {
    files.set('target/a.txt', Buffer.from('existing'));
    const moves = [{ from: 'source/a.txt', to: 'target/a.txt' }];
    expect((await moveFiles(moves)).status).toBe(409);
    files.set('target/a.txt', null);
    expect((await moveFiles(moves, ['target/a.txt'])).status).toBe(409);
    expect(service.adapter.renameFiles).not.toHaveBeenCalled();
  });

  it('refuses overwrite consent for a path outside this move', async () => {
    files.set('target/a.txt', Buffer.from('existing'));
    expect(
      (await moveFiles([{ from: 'source/a.txt', to: 'target/a.txt' }], ['target/unrelated.txt']))
        .status,
    ).toBe(400);
    expect(service.adapter.renameFiles).not.toHaveBeenCalled();
  });

  it('preflights the whole batch before mutating any approved overwrite', async () => {
    files.set('source/b.txt', Buffer.from('second source'));
    files.set('target/a.txt', Buffer.from('first existing'));
    files.set('target/b.txt', Buffer.from('second existing'));
    expect(
      (
        await moveFiles(
          [
            { from: 'source/a.txt', to: 'target/a.txt' },
            { from: 'source/b.txt', to: 'target/b.txt' },
          ],
          ['target/a.txt'],
        )
      ).status,
    ).toBe(409);
    expect(service.adapter.renameFiles).not.toHaveBeenCalled();
    expect(files.get('target/a.txt')?.toString()).toBe('first existing');
  });

  it('rejects legacy batch rename collisions before sending a provider mutation', async () => {
    files.set('target/source', null);
    const response = await app.request(`/v1/servers/${serverId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'rename',
        root: '',
        files: [{ from: 'source', to: 'target/source' }],
      }),
    });
    expect(response.status).toBe(409);
    expect(service.adapter.renameFiles).not.toHaveBeenCalled();
  });

  it('extracts a validated ZIP into a new directory and preserves empty folders', async () => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    })();
    zip.addEmptyDirectory('empty');
    zip.addBuffer(Buffer.from('verified'), 'nested/settings.txt');
    zip.end();
    await collected;
    files.set('source.zip', Buffer.concat(chunks));
    const response = await post('extract', {
      root: '',
      file: 'source.zip',
      destination: 'extracted',
      confirm: true,
    });
    expect(await response.clone().text()).toContain('completed');
    expect(response.status).toBe(200);
    expect(files.get('extracted/nested/settings.txt')?.toString()).toBe('verified');
    expect(files.has('extracted/empty')).toBe(true);
    expect(
      await f.db
        .selectFrom('upload_ingestion_claims')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(0);
    await rm(stage, { recursive: true, force: true });
  });

  it('copies nested content using streamed transfers and completes durable upload claims', async () => {
    const result = await post('copy', { root: '', files: ['source'], destination: 'target' });
    expect(await result.clone().text()).toContain('completed');
    expect(result.status).toBe(200);
    expect(files.get('target/source/a.txt')?.toString()).toBe('hello');
    expect(files.has('target/source/empty')).toBe(true);
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toHaveLength(0);
    const events = await f.db
      .selectFrom('audit_events')
      .select('action')
      .where('action', '=', 'server.files.completed')
      .execute();
    expect(events.length).toBeGreaterThan(0);
  });
  it('preserves a durable claim on interrupted upload and never declares success', async () => {
    vi.mocked(service.adapter.uploadFile).mockRejectedValueOnce(
      new Error('lost provider response'),
    );
    const result = await post('copy', { root: '', files: ['source'], destination: 'target' });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'operation_uncertain' });
    expect(
      await f.db
        .selectFrom('upload_ingestion_claims')
        .select('server_id')
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
    const claim = await f.db
      .selectFrom('upload_ingestion_claims')
      .select('id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    await f.db.connection().execute(async (connection) => {
      const key = `:nickhosting:upload:${claim.id}`;
      const result = await sql<{
        acquired: boolean;
      }>`select pg_try_advisory_lock(hashtextextended(current_schema() || ${key},0)) as acquired`.execute(
        connection,
      );
      expect(result.rows[0]?.acquired).toBe(true);
      await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${key},0))`.execute(
        connection,
      );
    });
    expect(
      await f.db
        .selectFrom('audit_events')
        .select('action')
        .where('action', '=', 'server.files.incomplete')
        .execute(),
    ).not.toHaveLength(0);
  });
  it('rejects insufficient destination capacity before any provider mutation', async () => {
    vi.mocked(service.adapter.getResources).mockResolvedValueOnce({
      resources: { disk_bytes: Number.MAX_SAFE_INTEGER },
    } as Awaited<ReturnType<typeof service.adapter.getResources>>);
    const result = await post('copy', { root: '', files: ['source'], destination: 'target' });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'resources_unavailable' });
    expect(service.adapter.createDirectory).not.toHaveBeenCalled();
    expect(service.adapter.uploadFile).not.toHaveBeenCalled();
  });
  it('refuses overwrite before provider mutation', async () => {
    files.set('target/source', null);
    const result = await post('copy', { root: '', files: ['source'], destination: 'target' });
    expect(result.status).toBe(409);
    expect(service.adapter.createDirectory).not.toHaveBeenCalled();
    expect(service.adapter.uploadFile).not.toHaveBeenCalled();
  });
  it('reports missing upload policy without exposing filesystem paths', async () => {
    await f.db
      .updateTable('physical_hosts')
      .set({ upload_policy: null })
      .where('id', '=', f.hostId)
      .execute();
    const response = await app.request(`/v1/servers/${serverId}/files/capabilities`);
    expect(await response.json()).toMatchObject({
      copy: false,
      extract: false,
      reason: 'upload_policy_missing',
    });
    expect(
      (await post('copy', { root: '', files: ['source'], destination: 'target' })).status,
    ).toBe(409);
    expect(service.adapter.uploadFile).not.toHaveBeenCalled();
  });
  it('rejects foreign servers and unsupported archive format without effects', async () => {
    const other = await managementFixture(f.db, { interactive: true });
    const id = await other.server();
    expect(
      (await post('copy', { root: '', files: ['source'], destination: 'target' }, id)).status,
    ).toBe(404);
    expect(
      (await post('extract', { root: '', file: 'a.rar', destination: 'extracted', confirm: true }))
        .status,
    ).toBe(400);
    expect(service.adapter.downloadFile).not.toHaveBeenCalled();
    await rm(stage, { recursive: true, force: true });
  });
});
