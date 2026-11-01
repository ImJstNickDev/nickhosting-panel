import { type AuthContext, DomainError } from '@nickhosting/core';
import type { createDatabase } from '@nickhosting/database';
import {
  authorizeServer,
  createFilemanReadService,
  getServerPermissionKeys,
  inspectMinecraftCombination,
  inspectMinecraftWorlds,
  type ManagementRuntime,
} from '@nickhosting/server-management';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Variables } from './app.js';
import { registerMinecraftRoutes } from './minecraft.js';

vi.mock('@nickhosting/server-management', async (original) => ({
  ...(await original<typeof import('@nickhosting/server-management')>()),
  authorizeServer: vi.fn(),
  getServerPermissionKeys: vi.fn(),
  inspectMinecraftWorlds: vi.fn(),
  inspectMinecraftCombination: vi.fn(),
}));
const actor = { subjectUserId: 'reader' } as AuthContext;
const db = {} as ReturnType<typeof createDatabase>['db'];
const snapshot = {
  installed: true,
  supported: true,
  selectedWorld: 'world',
  release: '26.1',
  compatibility: 'unavailable' as const,
  worlds: [],
};

function fixture(connection = db) {
  const app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  const authorizeTransfer = vi.fn<ManagementRuntime['authorizeTransfer']>(async () => {});
  const access = vi.fn(async (_actor, _server, work, signal) => {
    const files = createFilemanReadService({
      adapter: service.adapter,
      identifier: 'provider',
      signal,
      authorize: async () => {},
    });
    const result = await work(files, 'provider', connection, actor, {});
    await authorizeTransfer(actor, 'server', false, connection);
    return result;
  });
  const readFileForEditor = vi.fn(async () => Buffer.from('motd=Fixture\nmax-players=20\n'));
  const prepareWorldSelection = vi.fn(async () => {});
  const prepareFileWrites = vi.fn(async () => {});
  const service = {
    adapter: { readFileForEditor },
    fileReadScope: access,
    prepareFileWrites,
    prepareWorldSelection,
    authorizeTransfer,
  } as unknown as ManagementRuntime;
  const management = vi.fn(async () => service);
  registerMinecraftRoutes(app, {
    db: connection,
    env: {},
    principal: async () => actor,
    body: async (c) => c.req.json(),
    management,
  });
  return {
    app,
    access,
    service,
    management,
    authorizeTransfer,
    readFileForEditor,
    prepareWorldSelection,
    prepareFileWrites,
  };
}
beforeEach(() => {
  vi.mocked(authorizeServer)
    .mockReset()
    .mockResolvedValue({} as Awaited<ReturnType<typeof authorizeServer>>);
  vi.mocked(inspectMinecraftWorlds).mockReset().mockResolvedValue(snapshot);
  vi.mocked(getServerPermissionKeys)
    .mockReset()
    .mockResolvedValue(['game.minecraft.properties.read']);
});
describe('world snapshot HTTP access contract', () => {
  it('allows inventory readers through managed identity access and returns an uncached snapshot', async () => {
    const f = fixture();
    const response = await f.app.request('/v1/servers/server/minecraft/worlds');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(snapshot);
    expect(authorizeServer).toHaveBeenCalledExactlyOnceWith(
      db,
      actor,
      'server',
      'game.minecraft.worlds.read',
    );
    expect(f.access).toHaveBeenCalledExactlyOnceWith(
      actor,
      'server',
      expect.any(Function),
      expect.any(AbortSignal),
      'game.minecraft.worlds.read',
    );
    const authorize = vi.mocked(inspectMinecraftWorlds).mock.calls[0]?.[3];
    await authorize?.();
    expect(f.authorizeTransfer).toHaveBeenCalledExactlyOnceWith(actor, 'server', false, db);
  });
  it('overlaps opening preparation with inventory and tolerates unavailable preparation', async () => {
    const f = fixture();
    const preparation = Promise.withResolvers<void>();
    f.prepareWorldSelection.mockReturnValueOnce(preparation.promise);
    const inspected = Promise.withResolvers<void>();
    vi.mocked(inspectMinecraftWorlds).mockImplementationOnce(async () => {
      inspected.resolve();
      return snapshot;
    });
    const response = f.app.request('/v1/servers/server/minecraft/worlds');
    await inspected.promise;
    expect(f.prepareWorldSelection).toHaveBeenCalledOnce();
    preparation.reject(new Error('optional preparation unavailable'));
    expect((await response).status).toBe(200);
  });
  it('opens Settings through Fileman identity access and one direct signed read', async () => {
    const profile = {
      combination_id: 'choice',
      configuration: {
        eula: true,
        properties: {},
        operators: ['HiddenOperator'],
        whitelist: ['HiddenMember'],
        modpack: { sourceId: 'private-source' },
      },
      installed: true,
    };
    const query = {
      selectAll: () => query,
      select: () => query,
      where: () => query,
      executeTakeFirst: async () => profile,
      execute: async () => [],
    };
    const connection = { selectFrom: () => query } as unknown as typeof db;
    vi.mocked(inspectMinecraftCombination).mockResolvedValueOnce({
      combination: { release: '26.1', profile: 'vanilla' },
    } as never);
    const f = fixture(connection);
    const grants = Promise.withResolvers<void>();
    f.prepareFileWrites.mockReturnValueOnce(grants.promise);
    const response = await f.app.request('/v1/servers/server/minecraft');
    expect(f.prepareFileWrites).toHaveBeenCalledWith(actor, 'server', ['server.properties']);
    grants.resolve();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      effectiveProperties: { motd: 'Fixture', 'max-players': '20' },
      configuration: { operators: [], whitelist: [] },
      content: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/HiddenOperator|HiddenMember|private-source/);
    expect(f.access).toHaveBeenCalledExactlyOnceWith(
      actor,
      'server',
      expect.any(Function),
      expect.any(AbortSignal),
      'game.minecraft.properties.read',
    );
    expect(f.readFileForEditor).toHaveBeenCalledExactlyOnceWith(
      'provider',
      'server.properties',
      1048576,
    );
  });
  it('rejects unrelated callers before constructing provider services', async () => {
    const f = fixture();
    vi.mocked(authorizeServer).mockRejectedValue(new DomainError('forbidden'));
    expect((await f.app.request('/v1/servers/server/minecraft/worlds')).status).toBe(403);
    expect(f.management).not.toHaveBeenCalled();
    expect(inspectMinecraftWorlds).not.toHaveBeenCalled();
  });
  it('does not inspect files when managed provider identity verification rejects access', async () => {
    const f = fixture();
    f.access.mockRejectedValue(new DomainError('provenance_mismatch'));
    const response = await f.app.request('/v1/servers/server/minecraft/worlds');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'provenance_mismatch' });
    expect(inspectMinecraftWorlds).not.toHaveBeenCalled();
  });
});

describe('dedicated world archive scope', () => {
  function archiveFixture() {
    const f = fixture();
    const entry = (name: string, is_file: boolean) => ({
      name,
      is_file,
      is_symlink: false,
      size: is_file ? 3 : 0,
      modified_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
      mode: '0644',
      mimetype: 'application/octet-stream',
    });
    const listFiles = vi.fn(async (_id: string, directory: string) =>
      directory === '' || directory === '/'
        ? [entry('world', false), entry('private', false)]
        : directory === 'world' || directory === '/world'
          ? [entry('level.dat', true)]
          : [entry('secret.txt', true)],
    );
    const downloadFile = vi.fn(async (_id, _path, options) => {
      await options.authorize();
      const body = new Response('nbt').body;
      if (!body) throw new Error('Missing fixture stream');
      return { body };
    });
    Object.assign(f.service.adapter, { listFiles, downloadFile });
    Object.assign(f.service, {
      access: vi.fn(async (_context, _serverId, _write, work, _timing, permission) => {
        expect(permission).toBe('game.minecraft.worlds.download');
        return work('provider', db, actor, {
          id: 'server',
          name: 'Fixture',
          runtime_state: 'offline',
          active_operation_id: null,
        });
      }),
      fileReadPhase: vi.fn(() => ({})),
    });
    vi.mocked(inspectMinecraftWorlds).mockResolvedValue({
      ...snapshot,
      worlds: [{ name: 'world', status: 'verified' }],
    } as never);
    return { ...f, listFiles, downloadFile };
  }
  it('downloads only the discovered world and rechecks the domain permission throughout streaming', async () => {
    const f = archiveFixture();
    const response = await f.app.request('/v1/servers/server/minecraft/worlds/world/archive');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    await response.arrayBuffer();
    expect(f.downloadFile).toHaveBeenCalledOnce();
    expect(f.downloadFile.mock.calls[0]?.[1]).toBe('world/level.dat');
    expect(authorizeServer).toHaveBeenCalledWith(
      db,
      actor,
      'server',
      'game.minecraft.worlds.download',
    );
    expect(f.authorizeTransfer.mock.calls.length).toBeGreaterThan(1);
    expect(
      f.authorizeTransfer.mock.calls.every((args) => args[7] === 'game.minecraft.worlds.download'),
    ).toBe(true);
  });
  it('rejects arbitrary folders, protected roots and traversal before downloading bytes', async () => {
    const f = archiveFixture();
    for (const world of ['private', 'mods', 'world%2F..%2Fprivate']) {
      const response = await f.app.request(`/v1/servers/server/minecraft/worlds/${world}/archive`);
      expect([400, 404]).toContain(response.status);
    }
    expect(f.downloadFile).not.toHaveBeenCalled();
  });
});
