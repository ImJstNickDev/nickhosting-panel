import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { type AuthContext, createLogger, DomainError, type LogRecord } from '@nickhosting/core';
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
let debugTrace = false;
let operationLogs: LogRecord[];
afterEach(async () => {
  if (stage) await rm(stage, { recursive: true, force: true });
  // Unlimited-cap cases mutate only their own fixture server. Restore its finite
  // reservation before the next test reuses this schema, rather than leaving an
  // unobserved provider disk in another test's admission calculation.
  if (f && serverId)
    await sql`update managed_servers set limits=jsonb_set(limits,'{disk}','64'::jsonb) where id=${serverId} and (limits->>'disk')::numeric=0`.execute(
      f.db,
    );
});
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  debugTrace = false;
  operationLogs = [];
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
    deleteFiles: vi.fn(async () => {}),
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
  service.fileMutationAccess = (context, id, work, timing) =>
    service.access(context, id, true, work, timing);
  service.cleanupAccess = (context, id, work, timing) =>
    service.access(context, id, true, work, timing);
  service.authorizeCleanupTransfer = (context, id, connection, timing) =>
    service.authorizeTransfer(context, id, true, connection, timing);
  service.fileDiskUsage = async (_server, identifier) =>
    (await service.adapter.getResources(identifier)).resources.disk_bytes;
  service.fileDirectoryBatch = vi.fn(
    async (
      identifier: string,
      _server: Parameters<ManagementRuntime['fileDirectoryBatch']>[1],
      directories: string[],
    ) =>
      Promise.all(
        directories.map(async (directory) => ({
          directory,
          files: await service.adapter.listFiles(identifier, directory),
        })),
      ),
  );
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
    logger: {
      ...createLogger((record) => operationLogs.push(record), { level: 'debug' }),
      isEnabled: (level) => level !== 'debug' || debugTrace,
    },
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
  it('aggregates debug copy phases and exact provider listing counts without paths or content', async () => {
    debugTrace = true;
    const download = vi.mocked(service.adapter.downloadFile).getMockImplementation();
    if (!download) throw new Error('Missing download fixture');
    vi.spyOn(service.adapter, 'downloadFile').mockImplementation(async (...args) => {
      await args[2]?.authorize?.();
      return download(...args);
    });
    const upload = vi.mocked(service.adapter.uploadFile).getMockImplementation();
    if (!upload) throw new Error('Missing upload fixture');
    vi.spyOn(service.adapter, 'uploadFile').mockImplementation(async (...args) => {
      await args[2].authorize?.();
      return upload(...args);
    });
    const result = await post('copy', { root: 'source', files: ['a.txt'], destination: 'target' });
    expect(result.status).toBe(200);
    expect(result.headers.get('server-timing')).toMatch(/^nh-file;dur=\d/);
    const records = operationLogs.filter((record) => record.event === 'server.file_operation');
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toMatchObject({
      operation: 'copy',
      outcome: 'succeeded',
      phases: {
        'directory.batch': { count: 1 },
        'copy.planMutationCheck': { count: 1 },
        'copy.authorizeEntry': { count: 1 },
        'copy.authorizeDownload': { count: 1 },
        'copy.authorizeUpload': { count: 1 },
        'copy.downloadNegotiation': { count: 1 },
        'copy.uploadStream': { count: 1 },
        'copy.reserveIngestion': { count: 1 },
        'copy.completeIngestion': { count: 1 },
        'copy.unlockIngestion': { count: 1 },
        'copy.auditCompleted': { count: 1 },
        'copy.releaseSlot': { count: 1 },
      },
    });
    expect(service.adapter.listFiles).toHaveBeenCalledTimes(3);
    expect(service.fileDirectoryBatch).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(records);
    for (const value of ['source/a.txt', 'target/a.txt', 'hello'])
      expect(serialized).not.toContain(value);
    expect(files.get('target/a.txt')?.toString()).toBe('hello');
    expect(files.get('source/a.txt')?.toString()).toBe('hello');
  });
  it('records failed debug copy timing without changing the resource failure or dispatching writes', async () => {
    debugTrace = true;
    vi.mocked(service.adapter.getResources).mockRejectedValueOnce(
      new DomainError('resources_unavailable'),
    );
    const result = await post('copy', { root: 'source', files: ['a.txt'], destination: 'target' });
    expect(result.ok).toBe(false);
    expect(await result.json()).toMatchObject({ code: 'resources_unavailable' });
    expect(operationLogs.filter((record) => record.event === 'server.file_operation')).toHaveLength(
      1,
    );
    expect(operationLogs[0]?.data).toMatchObject({
      operation: 'copy',
      outcome: 'failed',
      phases: { 'copy.diskResources': { count: 1 }, 'copy.releaseSlot': { count: 1 } },
    });
    expect(service.adapter.uploadFile).not.toHaveBeenCalled();
    expect(service.adapter.createDirectory).not.toHaveBeenCalled();
  });
  it('leaves copy output unchanged and omits timing diagnostics when debug is disabled', async () => {
    const result = await post('copy', { root: 'source', files: ['a.txt'], destination: 'target' });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ completed: 1 });
    expect(result.headers.get('server-timing')).toBeNull();
    expect(operationLogs).toEqual([]);
    expect(service.adapter.listFiles).toHaveBeenCalledTimes(3);
    expect(service.fileDirectoryBatch).toHaveBeenCalledOnce();
  });
  it('counts the existing cached move-plan listings under debug without adding provider requests', async () => {
    debugTrace = true;
    const result = await moveFiles([{ from: 'source/a.txt', to: 'target/a.txt' }]);
    expect(result.status).toBe(204);
    expect(result.headers.get('server-timing')).toMatch(/^nh-file;dur=\d/);
    const records = operationLogs.filter((record) => record.event === 'server.file_operation');
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toMatchObject({
      operation: 'mutation',
      outcome: 'succeeded',
      phases: { 'move.listDirectory': { count: 3 } },
    });
    expect(service.adapter.listFiles).toHaveBeenCalledTimes(3);
    expect(service.adapter.renameFiles).toHaveBeenCalledOnce();
  });
  it('moves 1001 files in two bounded requests after complete preflight', async () => {
    const moves = Array.from({ length: 1001 }, (_, index) => {
      files.set(`source/file-${index}`, Buffer.from('data'));
      return { from: `source/file-${index}`, to: `target/file-${index}` };
    });
    const authorize = vi.spyOn(service, 'authorizeTransfer');
    expect((await moveFiles(moves)).status).toBe(204);
    expect(vi.mocked(service.adapter.renameFiles).mock.calls).toEqual([
      ['fixture', '', moves.slice(0, 1000)],
      ['fixture', '', moves.slice(1000)],
    ]);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(service.adapter.listFiles)
        .mock.calls.map(([, path]) => path)
        .sort(),
    ).toEqual(['', 'source', 'target']);
  });
  it('rejects a conflict beyond the first 1000 moves before any provider effect', async () => {
    const moves = Array.from({ length: 1001 }, (_, index) => {
      files.set(`source/file-${index}`, Buffer.from('data'));
      return { from: `source/file-${index}`, to: `target/file-${index}` };
    });
    files.set('target/file-1000', Buffer.from('existing'));
    expect((await moveFiles(moves)).status).toBe(409);
    expect(service.adapter.renameFiles).not.toHaveBeenCalled();
  });
  it.each(['delete', 'rename'] as const)(
    'reports partial %s as uncertain and does not dispatch later chunks',
    async (action) => {
      const selected = Array.from({ length: 2001 }, (_, index) => {
        files.set(`source/file-${index}`, Buffer.from('data'));
        return `source/file-${index}`;
      });
      const mutation = vi.mocked(
        action === 'delete' ? service.adapter.deleteFiles : service.adapter.renameFiles,
      );
      mutation.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DomainError('conflict'));
      const response = await app.request(`/v1/servers/${serverId}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          root: '',
          files:
            action === 'delete'
              ? selected
              : selected.map((from, index) => ({ from, to: `target/file-${index}` })),
          ...(action === 'delete' ? { confirm: true } : {}),
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'operation_uncertain' });
      expect(mutation).toHaveBeenCalledTimes(2);
    },
  );
  it('accepts copying 101 roots while enforcing the existing complete-tree budget', async () => {
    const selected = Array.from({ length: 101 }, (_, i) => `empty-${i}`);
    for (const name of selected) files.set(`source/${name}`, null);
    const response = await post('copy', { root: 'source', files: selected, destination: 'target' });
    expect(response.status).toBe(200);
    expect(service.adapter.createDirectory).toHaveBeenCalledTimes(101);
    expect(
      (
        await post('copy', {
          root: 'source',
          files: Array.from({ length: 20_001 }, (_, i) => `file-${i}`),
          destination: 'target',
        })
      ).status,
    ).toBe(400);
    expect(service.adapter.createDirectory).toHaveBeenCalledTimes(101);
  });
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
      { providerIdentifier: 'fixture', listFiles: expect.any(Function) },
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

  it.each([64, 0])(
    'extracts a validated ZIP with disk=%s and preserves empty folders',
    async (disk) => {
      const server = await authorizeServer(f.db, f.context, serverId, 'server:manage');
      await f.db
        .updateTable('managed_servers')
        .set({ limits: JSON.stringify({ ...server.limits, disk }) })
        .where('id', '=', serverId)
        .execute();
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
    },
  );

  async function archiveBytes(entries: { path: string; content?: Buffer }[]) {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    const collected = (async () => {
      for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
    })();
    for (const entry of entries) {
      if (entry.content === undefined) zip.addEmptyDirectory(entry.path);
      else zip.addBuffer(entry.content, entry.path);
    }
    zip.end();
    await collected;
    return Buffer.concat(chunks);
  }

  it('extracts only selected nested members and records the completed selection count', async () => {
    const nested = await archiveBytes([
      { path: 'chosen/settings.txt', content: Buffer.from('nested selection') },
      { path: 'chosen/empty' },
      { path: 'unselected.txt', content: Buffer.from('skip') },
    ]);
    files.set(
      'source.zip',
      await archiveBytes([
        { path: 'nested/inner.zip', content: nested },
        { path: 'outer.txt', content: Buffer.from('skip') },
      ]),
    );
    const response = await post('extract', {
      root: '',
      file: 'source.zip',
      destination: 'selected',
      confirm: true,
      archives: ['nested/inner.zip'],
      entries: ['chosen'],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: 2, destination: 'selected' });
    expect(files.get('selected/chosen/settings.txt')?.toString()).toBe('nested selection');
    expect(files.has('selected/chosen/empty')).toBe(true);
    expect(files.has('selected/unselected.txt')).toBe(false);
    expect(files.has('selected/outer.txt')).toBe(false);
    expect(service.adapter.uploadFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    { entries: [] },
    { entries: ['absent'] },
    { entries: ['../escape'] },
    { archives: ['missing.zip'] },
    { archives: ['safe.txt'] },
  ])('rejects invalid extraction selection before any provider mutation: %j', async (selection) => {
    files.set(
      'source.zip',
      await archiveBytes([{ path: 'safe.txt', content: Buffer.from('safe') }]),
    );
    const response = await post('extract', {
      root: '',
      file: 'source.zip',
      destination: 'selected',
      confirm: true,
      ...selection,
    });
    expect(response.status).toBe(400);
    expect(service.adapter.createDirectory).not.toHaveBeenCalled();
    expect(service.adapter.uploadFile).not.toHaveBeenCalled();
    expect(service.adapter.deleteFiles).not.toHaveBeenCalled();
  });

  it('reports uncertainty after a selected extraction upload fails without deleting partial output', async () => {
    files.set(
      'source.zip',
      await archiveBytes([{ path: 'safe.txt', content: Buffer.from('safe') }]),
    );
    vi.mocked(service.adapter.uploadFile).mockRejectedValueOnce(new Error('response lost'));
    const response = await post('extract', {
      root: '',
      file: 'source.zip',
      destination: 'selected',
      confirm: true,
      entries: ['safe.txt'],
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('operation_uncertain');
    expect(files.has('selected')).toBe(true);
    expect(service.adapter.deleteFiles).not.toHaveBeenCalled();
    expect(service.adapter.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('copies nested content using streamed transfers and completes durable upload claims', async () => {
    const result = await post('copy', { root: '', files: ['source'], destination: 'target' });
    expect(await result.clone().text()).toContain('completed');
    expect(result.status).toBe(200);
    expect(files.get('target/source/a.txt')?.toString()).toBe('hello');
    expect(files.get('source/a.txt')?.toString()).toBe('hello');
    expect(files.has('source/empty')).toBe(true);
    expect(files.has('target/source/empty')).toBe(true);
    expect(
      await f.db
        .selectFrom('upload_ingestion_claims')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(0);
    const events = await f.db
      .selectFrom('audit_events')
      .select('action')
      .where('action', '=', 'server.files.completed')
      .execute();
    expect(events.length).toBeGreaterThan(0);
  });
  it('copies mixed new and approved existing files without removing originals and audits exact approvals', async () => {
    files.set('source/b.txt', Buffer.from('second'));
    files.set('target/a.txt', Buffer.from('old target'));
    const result = await post('copy', {
      root: 'source',
      files: ['a.txt', 'b.txt'],
      destination: 'target',
      overwrite: ['target/a.txt'],
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ completed: 2 });
    expect(files.get('source/a.txt')?.toString()).toBe('hello');
    expect(files.get('source/b.txt')?.toString()).toBe('second');
    expect(files.get('target/a.txt')?.toString()).toBe('hello');
    expect(files.get('target/b.txt')?.toString()).toBe('second');
    expect(service.adapter.renameFiles).not.toHaveBeenCalled();
    expect(service.assertFileMutation).toHaveBeenCalledWith(
      serverId,
      ['target/a.txt', 'target/b.txt'],
      f.db,
      { providerIdentifier: 'fixture', listFiles: expect.any(Function) },
    );
    expect(
      await f.db
        .selectFrom('upload_ingestion_claims')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await f.db
        .selectFrom('audit_events')
        .select('metadata')
        .where('action', '=', 'server.files.requested')
        .execute(),
    ).toContainEqual({
      metadata: { serverId, action: 'copy', count: 2, overwrite: ['target/a.txt'] },
    });
  });
  it('refuses unapproved, folder and out-of-scope copy replacements before any writes', async () => {
    files.set('target/a.txt', Buffer.from('original'));
    const input = { root: 'source', files: ['a.txt'], destination: 'target' };
    expect((await post('copy', input)).status).toBe(409);
    expect((await post('copy', { ...input, overwrite: ['target/other'] })).status).toBe(400);
    files.set('target/a.txt', null);
    expect((await post('copy', { ...input, overwrite: ['target/a.txt'] })).status).toBe(409);
    expect(service.adapter.downloadFile).not.toHaveBeenCalled();
    expect(service.adapter.uploadFile).not.toHaveBeenCalled();
    expect(service.adapter.createDirectory).not.toHaveBeenCalled();
    expect(files.get('source/a.txt')?.toString()).toBe('hello');
  });
  it('validates the entire copy selection before replacing an approved file', async () => {
    files.set('source/b.txt', Buffer.from('second'));
    files.set('target/a.txt', Buffer.from('original a'));
    files.set('target/b.txt', Buffer.from('original b'));
    const result = await post('copy', {
      root: 'source',
      files: ['a.txt', 'b.txt'],
      destination: 'target',
      overwrite: ['target/a.txt'],
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'conflict' });
    expect(service.adapter.uploadFile).not.toHaveBeenCalled();
    expect(files.get('target/a.txt')?.toString()).toBe('original a');
  });
  it.each(['protected path', 'revoked permission'])(
    'retains %s enforcement for an approved copy overwrite',
    async (reason) => {
      files.set('target/a.txt', Buffer.from('original'));
      const deny = async () => {
        throw new DomainError('forbidden');
      };
      if (reason === 'protected path') service.assertFileMutation = deny;
      else service.authorizeTransfer = deny;
      const result = await post('copy', {
        root: 'source',
        files: ['a.txt'],
        destination: 'target',
        overwrite: ['target/a.txt'],
      });
      expect(result.status).toBe(reason === 'protected path' ? 403 : 409);
      expect(service.adapter.uploadFile).not.toHaveBeenCalled();
      expect(files.get('target/a.txt')?.toString()).toBe('original');
      expect(files.get('source/a.txt')?.toString()).toBe('hello');
    },
  );
  it.each(['missing', 'size changed'])(
    'rejects a source that Wings reports as %s without relisting directories',
    async (failure) => {
      const download = vi.mocked(service.adapter.downloadFile).getMockImplementation();
      if (!download) throw new Error('Missing download fixture');
      vi.mocked(service.adapter.downloadFile).mockImplementationOnce(async (...args) => {
        if (failure === 'missing') throw new DomainError('not_found');
        const response = await download(...args);
        return { ...response, contentLength: 100 };
      });
      const result = await post('copy', {
        root: 'source',
        files: ['a.txt'],
        destination: 'target',
      });
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ code: 'operation_uncertain' });
      expect(service.adapter.uploadFile).not.toHaveBeenCalled();
      expect(service.fileDirectoryBatch).toHaveBeenCalledOnce();
      expect(service.adapter.listFiles).toHaveBeenCalledTimes(3);
      expect(files.get('source/a.txt')?.toString()).toBe('hello');
    },
  );
  it('copies with an unlimited server quota but keeps exact stream limits and host reservations', async () => {
    const server = await authorizeServer(f.db, f.context, serverId, 'server:manage');
    await f.db
      .updateTable('managed_servers')
      .set({ limits: JSON.stringify({ ...server.limits, disk: 0 }) })
      .where('id', '=', serverId)
      .execute();
    vi.mocked(service.adapter.getResources).mockResolvedValueOnce({
      resources: { disk_bytes: 8 * 1024 ** 3 },
    } as Awaited<ReturnType<typeof service.adapter.getResources>>);
    const result = await post('copy', { root: '', files: ['source'], destination: 'target' });
    expect(result.status).toBe(200);
    expect(files.get('target/source/a.txt')?.toString()).toBe('hello');
    expect(vi.mocked(service.adapter.uploadFile).mock.calls.at(-1)?.[2].maxBytes).toBe(5);
    expect(
      await f.db
        .selectFrom('upload_ingestion_claims')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(0);
  });
  it('keeps full copy capacity accounting when replacing files', async () => {
    files.set('target/a.txt', Buffer.from('hello'));
    const server = await authorizeServer(f.db, f.context, serverId, 'server:manage');
    vi.mocked(service.adapter.getResources).mockResolvedValueOnce({
      resources: { disk_bytes: server.limits.disk * 1048576 },
    } as Awaited<ReturnType<typeof service.adapter.getResources>>);
    const result = await post('copy', {
      root: 'source',
      files: ['a.txt'],
      destination: 'target',
      overwrite: ['target/a.txt'],
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'resources_unavailable' });
    expect(service.adapter.uploadFile).not.toHaveBeenCalled();
  });
  it('reports a partial overwrite failure honestly while preserving source data and a durable claim', async () => {
    files.set('source/b.txt', Buffer.from('second'));
    files.set('target/a.txt', Buffer.from('old a'));
    files.set('target/b.txt', Buffer.from('old b'));
    const upload = vi.mocked(service.adapter.uploadFile).getMockImplementation();
    if (!upload) throw new Error('Missing upload fixture');
    vi.mocked(service.adapter.uploadFile)
      .mockImplementationOnce(upload)
      .mockImplementationOnce(async (_id, path, input) => {
        files.set(path, Buffer.from(await new Response(input.body).arrayBuffer()));
        throw new Error('lost response after write');
      });
    const result = await post('copy', {
      root: 'source',
      files: ['a.txt', 'b.txt'],
      destination: 'target',
      overwrite: ['target/a.txt', 'target/b.txt'],
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'operation_uncertain' });
    expect(files.get('source/a.txt')?.toString()).toBe('hello');
    expect(files.get('source/b.txt')?.toString()).toBe('second');
    expect(files.get('target/a.txt')?.toString()).toBe('hello');
    expect(files.get('target/b.txt')?.toString()).toBe('second');
    expect(service.adapter.uploadFile).toHaveBeenCalledTimes(2);
    expect(
      await f.db
        .selectFrom('upload_ingestion_claims')
        .selectAll()
        .where('server_id', '=', serverId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await f.db
        .selectFrom('audit_events')
        .select('metadata')
        .where('action', '=', 'server.files.incomplete')
        .execute(),
    ).toContainEqual({
      metadata: { serverId, action: 'copy', completed: 1, outcome: 'partial_or_uncertain' },
    });
    expect(
      await f.db
        .selectFrom('audit_events')
        .select('id')
        .where('action', '=', 'server.files.completed')
        .where(sql<boolean>`metadata ->> 'serverId' = ${serverId}`)
        .execute(),
    ).toHaveLength(0);
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
