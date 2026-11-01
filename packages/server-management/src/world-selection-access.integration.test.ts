import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { PrivateTransferCache } from '@nickhosting/pterodactyl-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueServerOperation } from './registry.js';
import { managementFixture } from './test-fixtures.js';
import { createWorldSelectionAccess } from './world-selection-access.js';

describe('opening-time world-selection observation', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  let server: Parameters<ReturnType<typeof createWorldSelectionAccess>['prepare']>[1];
  const values = new Map<string, string>();
  const cache: PrivateTransferCache = {
    get: async (key) => values.get(key),
    take: async (key) => {
      const result = values.get(key);
      values.delete(key);
      return result;
    },
    put: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  const access = createWorldSelectionAccess(cache, 'fixture-provider-observer');
  beforeEach(async () => {
    values.clear();
    database = await createTestDatabase();
    f = await managementFixture(database.db);
    const id = await f.server();
    server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await database?.destroy();
  });

  it('expires absolutely without renewing on local checks and binds the observer configuration', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const observe = vi.fn(async () => true);
    await access.prepare(f.db, server, observe);
    clock.mockReturnValue(now + 899_999);
    await access.assert(f.db, server);
    await expect(
      createWorldSelectionAccess(cache, 'different-socket').assert(f.db, server),
    ).rejects.toThrow('conflict');
    clock.mockReturnValue(now + 900_000);
    await expect(access.assert(f.db, server)).rejects.toThrow('conflict');
    expect(observe).toHaveBeenCalledOnce();
  });

  it.each(['running', 'active job'] as const)('does not prepare while %s', async (change) => {
    if (change === 'running')
      await f.db
        .updateTable('managed_servers')
        .set({ runtime_state: 'running' })
        .where('id', '=', server.id)
        .execute();
    else
      await enqueueServerOperation(f.db, f.context, server.id, {
        action: 'stop',
        idempotencyKey: randomUUID(),
      });
    const observe = vi.fn(async () => true);
    await access.prepare(f.db, server, observe);
    expect(observe).not.toHaveBeenCalled();
    await expect(access.assert(f.db, server)).rejects.toThrow('conflict');
  });

  it('rejects a power operation queued during the opening observation', async () => {
    await access.prepare(f.db, server, async () => {
      await enqueueServerOperation(f.db, f.context, server.id, {
        action: 'stop',
        idempotencyKey: randomUUID(),
      });
      return true;
    });
    expect(values.size).toBe(0);
    await expect(access.assert(f.db, server)).rejects.toThrow('conflict');
  });

  it('does not retain a previous proof after an unsuccessful new observation', async () => {
    await access.prepare(f.db, server, async () => true);
    await access.assert(f.db, server);
    await access.prepare(f.db, server, async () => false);
    await expect(access.assert(f.db, server)).rejects.toThrow('conflict');
    await access.prepare(f.db, server, async () => {
      throw new Error('observer unavailable');
    });
    expect(values.size).toBe(0);
  });

  it('fails closed on malformed or unavailable preparation without a provider fallback', async () => {
    await access.prepare(f.db, server, async () => true);
    for (const key of values.keys()) values.set(key, '{invalid');
    await expect(access.assert(f.db, server)).rejects.toThrow('conflict');
    const unavailable = createWorldSelectionAccess(
      {
        ...cache,
        get: async () => {
          throw new Error('cache unavailable');
        },
      },
      'fixture-provider-observer',
    );
    await expect(unavailable.assert(f.db, server)).rejects.toThrow('conflict');
  });
});
