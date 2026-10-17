import { createTestDatabase } from '@nickhosting/database/testing';
import type { GatewayMessageDefinition } from '@nickhosting/game-sdk';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createGameModuleRegistry, type TrustedGameModule } from './game-modules.js';
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
  expect(ordinary.definition?.states.find((s) => s.id === 'sleeping')?.defaults.en.motd).toBe(
    'Owner sleeping',
  );
  const env = await getServerGatewayMessages(f.db, f.context, serverId, {
    NH_MINECRAFT_GATEWAY_RESPONSES: JSON.stringify({
      motd: { sleeping: { en: 'Environment sleeping', it: 'Env IT' } },
    }),
  });
  expect(env.definition?.states.find((s) => s.id === 'sleeping')?.defaults.en.motd).toBe(
    'Environment sleeping',
  );
});

it('retains existing stored messages and rejects only edits outside the integration contract', async () => {
  const existing = { sleeping: { motd: '§aExisting {server}', disconnect: 'Reconnect later' } };
  await f.db
    .updateTable('gateway_server_states')
    .set({ gateway_messages: existing })
    .where('server_id', '=', serverId)
    .execute();
  const current = await getServerGatewayMessages(f.db, f.context, serverId);
  expect(current.overrides).toEqual(existing);
  expect(current.definition?.channels.map((channel) => channel.id)).toEqual(['motd', 'disconnect']);
  for (const overrides of [
    { arbitrary: { motd: 'No' } },
    { sleeping: { announcement: 'No' } },
    { sleeping: { motd: '{secret}' } },
    { sleeping: { motd: 'x'.repeat(513) } },
  ]) {
    await expect(
      setServerGatewayMessages(f.db, f.context, serverId, {
        revision: current.revision,
        overrides,
      }),
    ).rejects.toThrow('validation_failed');
  }
  expect((await getServerGatewayMessages(f.db, f.context, serverId)).overrides).toEqual(existing);
});

const fixtureMessages: GatewayMessageDefinition = {
  version: 1,
  channels: [
    {
      id: 'announcement',
      label: { en: 'Announcement', it: 'Annuncio' },
      maxLength: 64,
      multiline: false,
    },
  ],
  states: [
    {
      id: 'queue_full',
      label: { en: 'Queue full', it: 'Coda piena' },
      defaults: { en: { announcement: 'Room {room}' }, it: { announcement: 'Stanza {room}' } },
      previewVariables: { en: { room: 'A' }, it: { room: 'A' } },
    },
  ],
  variables: [{ id: 'room', label: { en: 'Room', it: 'Stanza' } }],
};
async function fixtureModules(definition: GatewayMessageDefinition | undefined) {
  const id = f.manifest.id;
  const manifest = {
    ...f.manifest,
    id,
    capabilities: { ...f.manifest.capabilities, gatewayMessages: true },
    gatewayMessages: definition,
  };
  await f.db.updateTable('game_integrations').set({ manifest }).where('id', '=', id).execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: id })
    .where('id', '=', f.mappingId)
    .execute();
  const module: TrustedGameModule = {
    id,
    manifest,
    provisionAsResourceOwner: false,
    async assertProfileBinding() {},
    async authorizeOperation() {},
    async filterCatalog(_db, _context, entry) {
      return entry;
    },
  };
  return createGameModuleRegistry([module]);
}
it('saves a compiled non-Minecraft channel, state and variable without protocol-specific branches', async () => {
  const modules = await fixtureModules(fixtureMessages);
  const current = await getServerGatewayMessages(f.db, f.context, serverId, {}, modules);
  expect(current).toMatchObject({ available: true, definition: fixtureMessages });
  const saved = await setServerGatewayMessages(
    f.db,
    f.context,
    serverId,
    {
      revision: current.revision,
      overrides: { queue_full: { announcement: 'Try room {room}' } },
    },
    {},
    modules,
  );
  expect(saved.overrides).toEqual({ queue_full: { announcement: 'Try room {room}' } });
  for (const overrides of [
    { sleeping: { motd: 'Wrong game' } },
    { queue_full: { announcement: 'One\nTwo' } },
    { queue_full: { announcement: '{server}' } },
  ])
    await expect(
      setServerGatewayMessages(
        f.db,
        f.context,
        serverId,
        {
          revision: saved.revision,
          overrides,
        },
        {},
        modules,
      ),
    ).rejects.toThrow('validation_failed');
});
it('does not infer message support from a boolean capability or stored metadata alone', async () => {
  const modules = await fixtureModules(undefined);
  const current = await getServerGatewayMessages(f.db, f.context, serverId, {}, modules);
  expect(current).toMatchObject({ available: false, editable: false });
  await expect(
    setServerGatewayMessages(
      f.db,
      f.context,
      serverId,
      {
        revision: current.revision,
        overrides: {},
      },
      {},
      modules,
    ),
  ).rejects.toThrow('integration_unavailable');
  await f.db
    .updateTable('game_integrations')
    .set({ manifest: { ...f.manifest, gatewayMessages: fixtureMessages } })
    .where('id', '=', f.manifest.id)
    .execute();
  expect((await getServerGatewayMessages(f.db, f.context, serverId)).available).toBe(false);
});

it('rejects stale editor revisions after resolved integration defaults change without overwriting messages', async () => {
  const original = await getServerGatewayMessages(f.db, f.context, serverId);
  const env = {
    NH_MINECRAFT_GATEWAY_RESPONSES: JSON.stringify({
      motd: { sleeping: { en: 'New default', it: 'Nuovo' } },
    }),
  };
  const changed = await getServerGatewayMessages(f.db, f.context, serverId, env);
  expect(changed.revision).not.toBe(original.revision);
  await expect(
    setServerGatewayMessages(
      f.db,
      f.context,
      serverId,
      {
        revision: original.revision,
        overrides: { sleeping: { motd: 'Stale edit' } },
      },
      env,
    ),
  ).rejects.toThrow('conflict');
  expect((await getServerGatewayMessages(f.db, f.context, serverId, env)).overrides).toEqual({});
});
