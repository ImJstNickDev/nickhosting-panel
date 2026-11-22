import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openworldInstance } from '../../../apps/api/tests/openworld-instance.js';
import { OpenworldTokenExpired } from '../../../games/openworld/src/dashboard-api.js';
import {
  assertCurrentOpenworldScope,
  createOpenworldNativeConnection,
  openworldProcessRef,
  readOpenworldScope,
} from './openworld-telemetry.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});

async function fixture() {
  const db = database.db;
  const { owner, id, target, power } = await openworldInstance(db);
  await power('running');
  let logins = 0;
  const fetcher: typeof fetch = async (url) => {
    switch (new URL(String(url)).pathname) {
      case '/api/live/auth':
        return Response.json({ required: true, loopback: false, canAct: false });
      case '/api/live/login':
        return Response.json({ token: `issued-${++logins}` });
      default:
        throw new Error('unexpected native request');
    }
  };
  const clock = { now: 0 };
  const options = { db, target, fetcher, now: () => clock.now };
  const currentScope = () => readOpenworldScope(db, id);
  return {
    owner,
    id,
    clock,
    options,
    native: createOpenworldNativeConnection(options),
    scope: await currentScope(),
    currentScope,
  };
}

const observe = async (_origin: string, token: string) => token;

it('shares a token for at most 60 seconds in each connection and verifies the exact target', async () => {
  const { clock, options, native, scope } = await fixture();
  const separate = createOpenworldNativeConnection(options);
  expect(await Promise.all([native(scope, observe), native(scope, observe)])).toEqual([
    'issued-1',
    'issued-1',
  ]);
  expect(await separate(scope, observe)).toBe('issued-2');
  clock.now = 59_999;
  expect(await native(scope, observe)).toBe('issued-1');
  clock.now = 60_000;
  expect(await native(scope, observe)).toBe('issued-3');
  const work = vi.fn(observe);
  await expect(native({ ...scope, origin: 'http://127.0.0.1:1' }, work)).rejects.toThrow(
    'provenance_mismatch',
  );
  expect(work).not.toHaveBeenCalled();
  expect(options.target).toHaveBeenCalledTimes(4);
});

it('preserves a newer login across delayed 401s, discards rejected refreshes and never replays a mutation', async () => {
  const { native, scope, options } = await fixture();
  const first = await native(scope, observe);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const late = native(scope, async (_origin, token) => {
    if (token === first) {
      started.resolve();
      await release.promise;
      throw new OpenworldTokenExpired();
    }
    return token;
  });
  await started.promise;
  const retry = (_origin: string, token: string) => {
    if (token === first) throw new OpenworldTokenExpired();
    return Promise.resolve(token);
  };
  expect(await Promise.all([native(scope, retry), native(scope, retry)])).toEqual([
    'issued-2',
    'issued-2',
  ]);
  release.resolve();
  expect(await late).toBe('issued-2');
  expect(options.target).toHaveBeenCalledTimes(2);

  const rejected = vi.fn(async () => {
    throw new OpenworldTokenExpired();
  });
  await expect(native(scope, rejected)).rejects.toBeInstanceOf(OpenworldTokenExpired);
  expect(rejected).toHaveBeenCalledTimes(2);
  expect(await native(scope, observe)).toBe('issued-4');

  const mutation = vi.fn(async () => {
    throw new OpenworldTokenExpired();
  });
  await expect(native(scope, mutation, false)).rejects.toBeInstanceOf(OpenworldTokenExpired);
  expect(mutation).toHaveBeenCalledOnce();
  expect(await native(scope, observe)).toBe('issued-5');
});

it('renews live proofs after provider and native credential changes without rebinding archived observations', async () => {
  const { owner, id, native, currentScope } = await fixture();
  const db = database.db;
  const update = [
    () =>
      db
        .updateTable('provider_accounts')
        .set({ key_identifier: 'rotated' })
        .where('user_id', '=', owner.context.subjectUserId)
        .execute(),
    () =>
      sql`update platform_settings set value = jsonb_set(value, '{pterodactylBaseUrl}', '"https://rotated.example.test"') where key = 'platform'`.execute(
        db,
      ),
    () =>
      db
        .insertInto('encrypted_secrets')
        .values({
          name: 'pterodactylApplicationKey',
          envelope: {
            version: 1,
            keyId: 'fixture',
            iv: 'fixture',
            tag: 'fixture',
            ciphertext: 'fixture',
          },
        })
        .execute(),
    () =>
      db
        .updateTable('openworld_server_profiles')
        .set({ dashboard_credential_prepared: true })
        .where('server_id', '=', id)
        .execute(),
  ];
  let scope = await currentScope();
  expect(await native(scope, observe)).toBe('issued-1');
  for (const [i, rotate] of update.entries()) {
    await rotate();
    const current = await currentScope();
    expect(current.binding).toBe(scope.binding);
    expect(openworldProcessRef(current)).toBe(openworldProcessRef(scope));
    expect(() => assertCurrentOpenworldScope(scope, current)).toThrow('game_not_ready');
    expect(await native(current, observe)).toBe(`issued-${i + 2}`);
    scope = current;
  }
});
