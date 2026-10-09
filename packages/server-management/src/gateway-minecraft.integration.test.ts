import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftDigest, minecraftVerificationChecks } from '@nickhosting/minecraft';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getGatewayState, requestGatewayWake, setGatewayPolicy } from './gateway-orchestration.js';
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
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
let choiceId: string;
let allocationId: string;
let env: Record<string, string>;
const combination = {
  release: '1.21.1',
  releaseType: 'release',
  protocolId: 767,
  family: 'netty',
  transfer: true,
  profile: 'vanilla',
  javaMajor: 21,
  runtimeDigest: 'a'.repeat(64),
  protocolSource: { url: 'https://example.test/protocols', sha256: 'b'.repeat(64) },
};
const policy = {
  enabled: true,
  protocolId: 'minecraft-java',
  gameVersion: '1.21.1',
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
    .values({ id: 'minecraft-java', version: '1.0.0', manifest: {} })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .insertInto('game_rollouts')
    .values({ integration_id: 'minecraft-java', state: 'public', allowlist: [] })
    .onConflict((c) => c.column('integration_id').doUpdateSet({ state: 'public', allowlist: [] }))
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'minecraft-java', runtime_id: 'vanilla' })
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
      javaMajor: 21,
    },
    client: { implementation: 'test-fixture', version: '1', protocolId: 767 },
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
describe('Minecraft evidence-backed Gateway registration', () => {
  it('mints exact service-only metadata after installed profile and signed evidence, even when new creations are disabled', async () => {
    const report = await evidence();
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'disabled-for-new-servers' })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ enabled: false })
      .where('id', '=', f.mappingId)
      .execute();
    await register();
    const snapshot = await getGatewaySnapshot(f.db, env);
    expect(snapshot.routes[0]?.protocol?.minecraft).toMatchObject({
      release: '1.21.1',
      protocolId: 767,
      family: 'netty',
      choiceId,
      evidenceRunId: report.runId,
      acceptsTransfers: false,
    });
    expect(await getGatewayState(f.db, serverId, { env })).toMatchObject({
      enabled: true,
      state: 'sleeping',
    });
  });
  it('rejects absent/tampered/expired evidence, wrong policy versions and uninstalled profiles', async () => {
    await expect(setGatewayPolicy(f.db, f.context, serverId, policy, { env })).rejects.toThrow(
      'integration_unavailable',
    );
    await evidence({ validSignature: false });
    await expect(setGatewayPolicy(f.db, f.context, serverId, policy, { env })).rejects.toThrow(
      'integration_unavailable',
    );
    await evidence({ recordedAt: new Date(Date.now() - 181 * 86400000) });
    await expect(setGatewayPolicy(f.db, f.context, serverId, policy, { env })).rejects.toThrow(
      'integration_unavailable',
    );
    await evidence();
    await expect(
      setGatewayPolicy(f.db, f.context, serverId, { ...policy, protocolId: 'generic' }, { env }),
    ).rejects.toThrow('integration_unavailable');
    await expect(
      setGatewayPolicy(f.db, f.context, serverId, { ...policy, gameVersion: '26.1' }, { env }),
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
  it('checks experimental eligibility against the server owner, not the platform Owner making the request', async () => {
    await evidence({ kind: 'protocol-fixture' });
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'private-testing', allowlist: [] })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    await expect(setGatewayPolicy(f.db, f.owner, serverId, policy, { env })).rejects.toThrow(
      'integration_unavailable',
    );
    await f.db
      .updateTable('game_rollouts')
      .set({ allowlist: [f.context.subjectUserId] })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    await register();
    const state = await getGatewayState(f.db, serverId, { env });
    await f.db
      .updateTable('game_rollouts')
      .set({ allowlist: [] })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    expect((await getGatewaySnapshot(f.db, env)).routes).toEqual([]);
    await expect(
      requestGatewayWake(f.db, serverId, { generation: state.generation, intent: 'join' }, { env }),
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
        { handlerId: 'minecraft-java', gameVersion: '1.21.1' },
        env,
      ),
    ).rejects.toThrow('configuration_invalid');
  });
  it('caps the route snapshot lease at attestation expiry', async () => {
    const report = await evidence({ recordedAt: new Date(Date.now() - 180 * 86400000 + 10_000) });
    await register();
    const snapshot = await getGatewaySnapshot(f.db, env);
    expect(Date.parse(snapshot.expiresAt)).toBeLessThanOrEqual(
      Date.parse(report.recordedAt) + 180 * 86400000,
    );
  });
});
