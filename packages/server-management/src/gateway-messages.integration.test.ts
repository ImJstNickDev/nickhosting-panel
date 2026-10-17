import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { getServerGatewayMessages, setServerGatewayMessages } from './gateway-messages.js';
import { setGatewayPolicy } from './gateway-orchestration.js';
import { managementFixture } from './test-fixtures.js';

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
  await f.db
    .insertInto('game_integrations')
    .values({ id: 'minecraft', version: '1.0.0', manifest: { ...f.manifest, id: 'minecraft' } })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  // Test the trusted Minecraft capability without installing/contacting a provider.
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'minecraft' })
    .where('id', '=', f.mappingId)
    .execute();
});
afterAll(async () => {
  await database?.destroy();
});
it('saves separate messages with revision protection and reset, without changing lifecycle generation', async () => {
  const initial = await getServerGatewayMessages(f.db, f.context, serverId);
  expect(initial).toMatchObject({ available: true, editable: true, overrides: {} });
  const state = await f.db
    .selectFrom('gateway_server_states')
    .select(['generation', 'enabled', 'state'])
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  const edited = await setServerGatewayMessages(f.db, f.context, serverId, {
    revision: initial.revision,
    overrides: { sleeping: { motd: '§a{server}', disconnect: 'Start from panel' } },
  });
  expect(edited.overrides.sleeping?.motd).toBe('§a{server}');
  expect(
    await f.db
      .selectFrom('gateway_server_states')
      .select(['generation', 'enabled', 'state'])
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow(),
  ).toEqual(state);
  await expect(
    setServerGatewayMessages(f.db, f.context, serverId, {
      revision: initial.revision,
      overrides: {},
    }),
  ).rejects.toThrow('conflict');
  expect(
    (
      await setServerGatewayMessages(f.db, f.context, serverId, {
        revision: edited.revision,
        overrides: {},
      })
    ).overrides,
  ).toEqual({});
});
it('does not grant access through a capability, and rejects support writes and direct routes', async () => {
  const other = await managementFixture(f.db, { interactive: true });
  await expect(getServerGatewayMessages(f.db, other.context, serverId)).rejects.toThrow();
  const initial = await getServerGatewayMessages(f.db, f.context, serverId);
  await expect(
    setServerGatewayMessages(f.db, { ...f.context, sessionType: 'support' }, serverId, {
      revision: initial.revision,
      overrides: {},
    }),
  ).rejects.toThrow('forbidden');
  await f.db
    .updateTable('managed_servers')
    .set({ connection_mode: 'direct' })
    .where('id', '=', serverId)
    .execute();
  expect(await getServerGatewayMessages(f.db, f.context, serverId)).toMatchObject({
    available: false,
    editable: false,
  });
  await expect(
    setServerGatewayMessages(f.db, f.context, serverId, {
      revision: initial.revision,
      overrides: {},
    }),
  ).rejects.toThrow('integration_unavailable');
});
it('exposes actual Owner defaults with environment precedence for reset previews', async () => {
  await sql`update platform_settings set value=jsonb_set(value,'{minecraftGatewayResponses}', ${JSON.stringify({ motd: { sleeping: { en: 'Owner sleeping', it: 'Owner IT' } } })}::jsonb) where key='platform'`.execute(
    f.db,
  );
  const ordinary = await getServerGatewayMessages(f.db, f.context, serverId);
  expect(ordinary.states.find((s) => s.id === 'sleeping')?.defaults.en.motd).toBe('Owner sleeping');
  const env = await getServerGatewayMessages(f.db, f.context, serverId, {
    NH_MINECRAFT_GATEWAY_RESPONSES: JSON.stringify({
      motd: { sleeping: { en: 'Environment sleeping', it: 'Env IT' } },
    }),
  });
  expect(env.states.find((s) => s.id === 'sleeping')?.defaults.en.motd).toBe(
    'Environment sleeping',
  );
});
