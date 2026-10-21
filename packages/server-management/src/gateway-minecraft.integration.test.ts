import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftDigest, minecraftVerificationChecks } from '@nickhosting/minecraft';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lockResources } from './admission.js';
import { getServerGatewayMessages } from './gateway-messages.js';
import { getGatewayState, setGatewayPolicy } from './gateway-orchestration.js';
import { activateProvisionGateway, planProvisionGateway } from './gateway-provision.js';
import {
  getGatewaySnapshot,
  requireMinecraftGatewayProtocol,
  setGatewayRoute,
} from './gateway-registry.js';
import {
  inspectMinecraftCombination,
  minecraftMappingDigest,
  signMinecraftEvidence,
} from './minecraft-registry.js';
import { createSchedule, runDueSchedules } from './schedules.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
let choiceId: string;
let allocationId: string;
let env: Record<string, string>;
const combination = {
  release: '26.1',
  releaseType: 'release',
  protocolId: 775,
  family: 'netty',
  transfer: true,
  profile: 'vanilla',
  javaMajor: 25,
  runtimeDigest: 'a'.repeat(64),
  protocolSource: { url: 'https://example.test/protocols', sha256: 'b'.repeat(64) },
};
const policy = {
  enabled: true,
  protocolId: 'minecraft-java',
  gameVersion: '26.1',
  idleTimeoutSeconds: 10,
  readinessTimeoutSeconds: 60,
  readinessMaxAgeSeconds: 15,
  estimateMaxAgeSeconds: 86400,
  wakeRetrySeconds: 10,
};
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  serverId = await f.server();
  env = {
    NH_MINECRAFT_EVIDENCE_KEY: '1'.repeat(64),
    NH_GATEWAY_ENABLED: 'true',
    NH_GATEWAY_ID: randomUUID(),
    NH_GATEWAY_PHYSICAL_HOST_ID: f.hostId,
  };
  await f.db
    .insertInto('game_integrations')
    .values({ id: 'minecraft', version: '1.0.0', manifest: {} })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .insertInto('game_rollouts')
    .values({ integration_id: 'minecraft', state: 'public', allowlist: [] })
    .onConflict((c) => c.column('integration_id').doUpdateSet({ state: 'public', allowlist: [] }))
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'minecraft', runtime_id: 'vanilla' })
    .where('id', '=', f.mappingId)
    .execute();
  const mapping = await f.db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', f.mappingId)
    .executeTakeFirstOrThrow();
  choiceId = randomUUID();
  await f.db
    .insertInto('minecraft_combinations')
    .values({
      id: choiceId,
      mapping_id: f.mappingId,
      combination: JSON.stringify(combination),
      resolved_runtime: '{}',
      binding: '{}',
      mapping_digest: minecraftMappingDigest(mapping),
      identity_digest: minecraftDigest({ combination, mappingId: f.mappingId }),
      enabled: false,
    })
    .execute();
  await f.db
    .insertInto('minecraft_server_profiles')
    .values({ server_id: serverId, combination_id: choiceId, configuration: '{}', installed: true })
    .execute();
  allocationId = (
    await f.db
      .selectFrom('server_allocations')
      .select('id')
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow()
  ).id;
  await f.db
    .updateTable('server_allocations')
    .set({ role: 'game' })
    .where('id', '=', allocationId)
    .execute();
});
async function evidence(
  options: {
    kind?: 'real-server' | 'protocol-fixture';
    recordedAt?: Date;
    validSignature?: boolean;
    failed?: boolean;
  } = {},
) {
  const choice = await inspectMinecraftCombination(f.db, choiceId, env);
  const report = {
    runId: randomUUID(),
    kind: options.kind ?? 'real-server',
    combinationDigest: minecraftDigest(choice.combination),
    mappingDigest: choice.mappingDigest,
    choiceDigest: choice.row.identity_digest,
    recordedAt: (options.recordedAt ?? new Date()).toISOString(),
    checks: Object.fromEntries(
      minecraftVerificationChecks.map((check) => [check, !options.failed]),
    ),
    evidenceSha256: 'd'.repeat(64),
    server: {
      uuid: randomUUID(),
      externalId: 'isolated-nbt-test',
      artifactSha256: 'e'.repeat(64),
      imageDigest: `sha256:${'f'.repeat(64)}`,
      javaMajor: 25,
    },
    client: { implementation: 'test-fixture', version: '1', protocolId: 775 },
  };
  await f.db
    .insertInto('minecraft_verification_evidence')
    .values({
      id: report.runId,
      combination_id: choiceId,
      report: JSON.stringify(report),
      signature:
        options.validSignature === false ? '0'.repeat(64) : signMinecraftEvidence(report, env),
    })
    .execute();
  return report;
}
async function register() {
  await setGatewayPolicy(f.db, f.context, serverId, policy, { env });
  return setGatewayRoute(
    f.db,
    f.owner,
    {
      serverId,
      allocationId,
      publicAddress: f.backendAllocationPool.gatewayBindAddresses[0],
      publicPort: 27001,
      transport: 'tcp',
    },
    env,
  );
}
describe('Minecraft declared-capability Gateway registration', () => {
  it.each(['fabric', 'paper'])(
    'activates %s routes and automation without reports while retaining mapping identity checks',
    async (profile) => {
      await f.db
        .updateTable('runtime_egg_mappings')
        .set({ runtime_id: profile })
        .where('id', '=', f.mappingId)
        .execute();
      const mapping = await f.db
        .selectFrom('runtime_egg_mappings')
        .selectAll()
        .where('id', '=', f.mappingId)
        .executeTakeFirstOrThrow();
      await f.db
        .updateTable('minecraft_combinations')
        .set({
          combination: JSON.stringify({
            ...combination,
            profile,
            loaderVersion: '0.19.5',
            installerVersion: '1.1.2',
          }),
          mapping_digest: minecraftMappingDigest(mapping),
        })
        .where('id', '=', choiceId)
        .execute();
      await register();
      const snapshot = await getGatewaySnapshot(f.db, env);
      expect(snapshot.routes[0]?.protocol?.minecraft).toMatchObject({
        supportSource: 'integration',
        declarationId: `minecraft/${profile}`,
        declarationVersion: 1,
        release: '26.1',
        protocolId: 775,
      });
      expect(await getGatewayState(f.db, serverId, { env })).toMatchObject({
        enabled: true,
      });
      await f.db
        .updateTable('runtime_egg_mappings')
        .set({ docker_image: 'changed/image:25' })
        .where('id', '=', f.mappingId)
        .execute();
      expect((await getGatewaySnapshot(f.db, env)).routes).toEqual([]);
    },
  );
  it('shares locally bound message variables with editor previews and never exposes listener addresses', async () => {
    await register();
    const values = { version: '26.1', runtime: 'Vanilla', address: '' };
    const snapshot = await getGatewaySnapshot(f.db, env);
    expect(snapshot.routes[0]?.presentation?.variables).toEqual({ ...values, runtime: 'vanilla' });
    expect(
      (await getServerGatewayMessages(f.db, f.context, serverId, env)).definition?.states[0]
        ?.previewVariables.en,
    ).toMatchObject(values);
    const assignmentId = randomUUID();
    const connection = {
      hostname: 'world.example.test',
      port: 27001,
      records: [{ type: 'SRV', data: { port: 27001 } }],
    };
    await f.db
      .insertInto('dns_assignments')
      .values({
        id: assignmentId,
        server_id: serverId,
        hostname: connection.hostname,
        ownership_token: randomUUID(),
        plan: JSON.stringify({ connection }),
        ledger: JSON.stringify([]),
        state: 'pending',
      })
      .execute();
    expect((await getGatewaySnapshot(f.db, env)).routes[0]?.presentation?.variables?.address).toBe(
      '',
    );
    await f.db
      .updateTable('dns_assignments')
      .set({ state: 'active' })
      .where('id', '=', assignmentId)
      .execute();
    expect((await getGatewaySnapshot(f.db, env)).routes[0]?.presentation?.variables?.address).toBe(
      'world.example.test',
    );
    expect(
      (await getServerGatewayMessages(f.db, f.context, serverId, env)).definition?.states[0]
        ?.previewVariables.it.address,
    ).toBe('world.example.test');
    await f.db
      .updateTable('dns_assignments')
      .set({
        state: 'uncertain',
        plan: JSON.stringify({
          connection: { ...connection, hostname: 'pending.example.test' },
          confirmedConnection: connection,
        }),
      })
      .where('id', '=', assignmentId)
      .execute();
    expect((await getGatewaySnapshot(f.db, env)).routes[0]?.presentation?.variables?.address).toBe(
      'world.example.test',
    );
    await f.db
      .updateTable('dns_assignments')
      .set({
        state: 'active',
        plan: JSON.stringify({ connection: { ...connection, records: [] } }),
      })
      .where('id', '=', assignmentId)
      .execute();
    expect((await getGatewaySnapshot(f.db, env)).routes[0]?.presentation?.variables?.address).toBe(
      'world.example.test:27001',
    );
    await f.db
      .updateTable('dns_assignments')
      .set({ plan: JSON.stringify({ connection: { ...connection, port: 27002 } }) })
      .where('id', '=', assignmentId)
      .execute();
    expect((await getGatewaySnapshot(f.db, env)).routes[0]?.presentation?.variables?.address).toBe(
      '',
    );
  });
  it('publishes stopping presentation for an active scheduled stop without granting forwarding', async () => {
    await register();
    await f.db
      .updateTable('managed_servers')
      .set({ runtime_state: 'running', intent: 'auto_wake_enabled' })
      .where('id', '=', serverId)
      .execute();
    const at = new Date(Date.now() + 1000);
    await createSchedule(
      f.db,
      f.context,
      serverId,
      {
        name: 'Stop for night',
        action: 'stop',
        timing: { kind: 'once', at: at.toISOString() },
        timeZone: 'UTC',
        enabled: true,
      },
      env,
    );
    expect(await runDueSchedules(f.db, env, { now: at })).toMatchObject({ dispatched: 1 });
    const snapshot = await getGatewaySnapshot(f.db, env);
    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.routes[0]).toMatchObject({ mode: 'blocked', presentation: { stopping: true } });
    const server = await f.db
      .selectFrom('managed_servers')
      .select('active_operation_id')
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    expect(server.active_operation_id).toBeTruthy();
    // A nonterminal orphaned stop is not presentation authority for the server.
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', serverId)
      .execute();
    expect((await getGatewaySnapshot(f.db, env)).routes[0]?.presentation?.stopping).toBeUndefined();
  });

  it('mints declared service-only metadata for installed profiles without requiring signed evidence', async () => {
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'disabled-for-new-servers' })
      .where('integration_id', '=', 'minecraft')
      .execute();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ enabled: false })
      .where('id', '=', f.mappingId)
      .execute();
    await register();
    const snapshot = await getGatewaySnapshot(f.db, env);
    expect(snapshot.routes[0]?.protocol?.minecraft).toMatchObject({
      release: '26.1',
      protocolId: 775,
      family: 'netty',
      choiceId,
      supportSource: 'integration',
      declarationId: 'minecraft/vanilla',
      declarationVersion: 2,
      acceptsTransfers: false,
    });
    expect(await getGatewayState(f.db, serverId, { env })).toMatchObject({
      enabled: true,
      state: 'sleeping',
    });
  });
  it('keeps test reports diagnostic and rejects wrong policy versions or uninstalled profiles', async () => {
    await evidence({ validSignature: false });
    await evidence({ recordedAt: new Date(Date.now() - 181 * 86400000) });
    await expect(
      setGatewayPolicy(f.db, f.context, serverId, policy, { env: {} }),
    ).resolves.toMatchObject({ enabled: true });
    await expect(
      setGatewayPolicy(f.db, f.context, serverId, { ...policy, protocolId: 'generic' }, { env }),
    ).rejects.toThrow('integration_unavailable');
    await expect(
      setGatewayPolicy(f.db, f.context, serverId, { ...policy, gameVersion: '1.21.1' }, { env }),
    ).rejects.toThrow('integration_unavailable');
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: false })
      .where('server_id', '=', serverId)
      .execute();
    await expect(setGatewayPolicy(f.db, f.context, serverId, policy, { env })).rejects.toThrow(
      'integration_unavailable',
    );
  });
  it('withdraws invalid Minecraft routes without blocking unrelated managed routes or extending their leases', async () => {
    await evidence();
    const route = await register();
    const other = await managementFixture(f.db, { interactive: true });
    const otherServer = await other.server();
    await f.db
      .updateTable('managed_nodes')
      .set({ physical_host_id: f.hostId })
      .where('id', '=', other.nodeId)
      .execute();
    await setGatewayPolicy(f.db, other.context, otherServer, {
      ...policy,
      protocolId: 'fixture',
      gameVersion: '1',
    });
    const otherAllocation = await f.db
      .selectFrom('server_allocations')
      .select('id')
      .where('server_id', '=', otherServer)
      .executeTakeFirstOrThrow();
    await setGatewayRoute(
      f.db,
      other.owner,
      {
        serverId: otherServer,
        allocationId: otherAllocation.id,
        publicAddress: other.backendAllocationPool.gatewayBindAddresses[0],
        publicPort: 27002,
        transport: 'tcp',
      },
      env,
    );
    const first = await getGatewaySnapshot(f.db, env);
    expect(first.routes).toHaveLength(2);
    const before = await f.db
      .selectFrom('gateway_routes')
      .select('lease_expires_at')
      .where('id', '=', route.id)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: false })
      .where('server_id', '=', serverId)
      .execute();
    const second = await getGatewaySnapshot(f.db, env);
    expect(second.routes.map((row) => row.serverId)).toEqual([otherServer]);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(
      (
        await f.db
          .selectFrom('gateway_routes')
          .select('lease_expires_at')
          .where('id', '=', route.id)
          .executeTakeFirstOrThrow()
      ).lease_expires_at,
    ).toEqual(before.lease_expires_at);
    await expect(getGatewayState(f.db, serverId, { env })).rejects.toThrow(
      'integration_unavailable',
    );
    await expect(
      setGatewayPolicy(f.db, f.context, serverId, { ...policy, enabled: false }, { env }),
    ).resolves.toMatchObject({ enabled: false });
  });
  it('does not promote an undeclared protocol through signed reports or Owner allowlisting', async () => {
    await f.db
      .updateTable('minecraft_combinations')
      .set({
        combination: JSON.stringify({
          ...combination,
          release: '1.21.1',
          family: 'unknown',
          protocolId: null,
        }),
      })
      .where('id', '=', choiceId)
      .execute();
    await evidence();
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'private-testing', allowlist: [f.context.subjectUserId] })
      .where('integration_id', '=', 'minecraft')
      .execute();
    await expect(
      setGatewayPolicy(f.db, f.owner, serverId, { ...policy, gameVersion: '1.21.1' }, { env }),
    ).rejects.toThrow('integration_unavailable');
    expect(
      await f.db
        .selectFrom('resource_reservations')
        .select('server_id')
        .where('server_id', '=', serverId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });
  it('does not retain evidence after runtime mapping drift and cannot spoof Minecraft on other games', async () => {
    await evidence();
    await register();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ docker_image: 'changed/image:21' })
      .where('id', '=', f.mappingId)
      .execute();
    expect((await getGatewaySnapshot(f.db, env)).routes).toEqual([]);
    const other = await managementFixture(f.db, { interactive: true });
    const otherServer = await other.server();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ game_id: other.gameId })
      .where('id', '=', f.mappingId)
      .execute();
    expect((await getGatewaySnapshot(f.db, env)).routes).toEqual([]);
    await expect(
      requireMinecraftGatewayProtocol(
        f.db,
        otherServer,
        { handlerId: 'minecraft-java', gameVersion: '26.1' },
        env,
      ),
    ).rejects.toThrow('configuration_invalid');
  });
  it('keeps bounded route leases independent of diagnostic report expiry', async () => {
    await evidence({ recordedAt: new Date(Date.now() - 180 * 86400000 + 10_000) });
    await register();
    const snapshot = await getGatewaySnapshot(f.db, env);
    expect(Date.parse(snapshot.expiresAt) - Date.parse(snapshot.issuedAt)).toBeLessThanOrEqual(
      120_000,
    );
    expect(snapshot.routes[0]?.protocol?.minecraft).toMatchObject({ supportSource: 'integration' });
    expect(snapshot.routes[0]?.protocol?.minecraft).not.toHaveProperty('evidenceRunId');
  });
});

it.each([
  {
    profile: 'fabric',
    release: '26.1',
    protocolId: 775,
    family: 'netty',
    releaseType: 'release',
    javaMajor: 25,
    sleepWake: true,
  },
  {
    release: '26.1',
    protocolId: 775,
    family: 'netty',
    releaseType: 'release',
    javaMajor: 25,
    sleepWake: true,
  },
  {
    release: '1.5.2',
    protocolId: 61,
    family: 'legacy',
    releaseType: 'release',
    javaMajor: 8,
    sleepWake: true,
  },
  {
    release: 'a1.2.6',
    protocolId: 6,
    family: 'legacy',
    releaseType: 'old_alpha',
    javaMajor: 8,
    sleepWake: false,
  },
])(
  'initializes inherited automation for compiled runtime $profile $release without diagnostic evidence',
  async (variant) => {
    const profile = variant.profile ?? 'vanilla';
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ runtime_id: profile })
      .where('id', '=', f.mappingId)
      .execute();
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    const selected = { ...combination, ...variant, profile, transfer: variant.family === 'netty' };
    const { sleepWake: expectedSleepWake, ...identity } = selected;
    await f.db
      .updateTable('minecraft_combinations')
      .set({
        mapping_digest: minecraftMappingDigest(mapping),
        combination: JSON.stringify(identity),
        identity_digest: minecraftDigest({ combination: identity, mappingId: f.mappingId }),
      })
      .where('id', '=', choiceId)
      .execute();
    expect((await inspectMinecraftCombination(f.db, choiceId, env)).capabilities).toMatchObject({
      gateway: true,
      wake: true,
      sleepWake: expectedSleepWake,
    });
    await f.db
      .updateTable('server_allocations')
      .set({ protocols: ['tcp'] })
      .where('id', '=', allocationId)
      .execute();
    const operation = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('action', '=', 'provision')
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: operation.job_id })
      .where('id', '=', serverId)
      .execute();
    await f.db.transaction().execute(async (tx) => {
      await lockResources(tx);
      const server = await tx
        .selectFrom('managed_servers')
        .selectAll()
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow();
      const plan = await planProvisionGateway(tx, server, 'minecraft', env);
      expect(plan?.routes).toHaveLength(1);
      await tx
        .updateTable('server_operations')
        .set({ plan: JSON.stringify({ ...operation.plan, gatewayProvision: plan }) })
        .where('job_id', '=', operation.job_id)
        .execute();
    });
    await activateProvisionGateway(f.db, serverId, operation.job_id, env);
    const state = await getGatewayState(f.db, serverId, { env });
    expect(state).toMatchObject({
      protocolId: 'minecraft-java',
      gameVersion: variant.release,
      enabled: true,
      state: 'manually_stopped',
    });
    const snapshot = await getGatewaySnapshot(f.db, env);
    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.routes[0]).toMatchObject({
      protocol: {
        handlerId: 'minecraft-java',
        gameVersion: variant.release,
        minecraft: { protocolId: variant.protocolId, supportSource: 'integration' },
      },
    });
  },
);
