import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getGatewayState, requestGatewayWake, setGatewayPolicy } from './gateway-orchestration.js';
import { authorizeQueuedEffect } from './runtime.js';
import { resolveIdleTimeout } from './sleep-policy.js';
import { managementFixture } from './test-fixtures.js';
import { getServerAutoWakePolicy, setServerAutoWakePolicy } from './wake-policy.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
beforeAll(async () => {
  database = await createTestDatabase();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  serverId = await f.server();
  await setGatewayPolicy(f.db, f.context, serverId, {
    enabled: true,
    protocolId: 'isolated-fixture',
    gameVersion: '1',
    idleTimeoutSeconds: 10,
    readinessTimeoutSeconds: 60,
    readinessMaxAgeSeconds: 15,
    estimateMaxAgeSeconds: 86400,
    wakeRetrySeconds: 10,
    mode: 'auto',
  });
});
afterAll(async () => {
  await database?.destroy();
});
async function wake() {
  const state = await getGatewayState(f.db, serverId);
  return requestGatewayWake(f.db, serverId, { generation: state.generation, intent: 'join' });
}
describe('auto-wake policy authorization and lifecycle', () => {
  it('manager can disable joins without disabling idle sleep or changing intent', async () => {
    const before = await f.db
      .selectFrom('managed_servers')
      .select('intent')
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    await setServerAutoWakePolicy(f.db, f.context, serverId, { overrideEnabled: false });
    expect(await wake()).toMatchObject({ enabled: true, wakeEnabled: false, wakeJobId: null });
    const state = await f.db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    expect((await resolveIdleTimeout(f.db, serverId, state)).effectiveSeconds).toBe(10);
    expect(
      await f.db
        .selectFrom('managed_servers')
        .select('intent')
        .where('id', '=', serverId)
        .executeTakeFirst(),
    ).toEqual(before);
    await setServerAutoWakePolicy(f.db, f.context, serverId, { overrideEnabled: null });
    expect((await wake()).wakeJobId).toBeTruthy();
  });
  it('Owner controls hidden and disable-only; users cannot escalate access', async () => {
    await setServerAutoWakePolicy(f.db, f.owner, serverId, {
      overrideEnabled: true,
      userAccess: 'disable-only',
    });
    await expect(
      setServerAutoWakePolicy(f.db, f.context, serverId, { overrideEnabled: true }),
    ).rejects.toThrow('forbidden');
    await setServerAutoWakePolicy(f.db, f.context, serverId, { overrideEnabled: false });
    expect(await getServerAutoWakePolicy(f.db, f.context, serverId)).toMatchObject({
      effectiveEnabled: false,
    });
    await expect(
      setServerAutoWakePolicy(f.db, f.context, serverId, {
        overrideEnabled: null,
        userAccess: 'editable',
      }),
    ).rejects.toThrow('forbidden');
    await setServerAutoWakePolicy(f.db, f.owner, serverId, {
      overrideEnabled: true,
      userAccess: 'hidden',
    });
    expect(await getServerAutoWakePolicy(f.db, f.context, serverId)).toBeNull();
    expect(await getServerAutoWakePolicy(f.db, f.owner, serverId)).toMatchObject({
      effectiveEnabled: true,
    });
    await expect(
      setServerAutoWakePolicy(f.db, f.context, serverId, { overrideEnabled: null }),
    ).rejects.toThrow('forbidden');
  });
  it('a wake queued before disable is denied at final authorization', async () => {
    const state = await wake();
    expect(state.wakeJobId).toBeTruthy();
    await setServerAutoWakePolicy(f.db, f.context, serverId, { overrideEnabled: false });
    await expect(authorizeQueuedEffect(f.db, state.wakeJobId ?? '', serverId)).rejects.toThrow(
      'forbidden',
    );
  });
});
