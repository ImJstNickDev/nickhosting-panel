import { randomBytes, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftDigest, minecraftVerificationChecks } from '@nickhosting/minecraft';
import type {
  ApplicationServer,
  ProvisionPlan,
  PterodactylAdapter,
} from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LifecycleOptions, processServerOperation } from './lifecycle.js';
import {
  inspectMinecraftCombination,
  minecraftMappingDigest,
  signMinecraftEvidence,
} from './minecraft-registry.js';
import { createManagedServer, enqueueServerOperation } from './registry.js';
import { authorizeQueuedEffect, createManagementRuntime } from './runtime.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let choiceId: string;
const env = {
  NH_MINECRAFT_EVIDENCE_KEY: '1'.repeat(64),
  NH_OBSERVER_ID: 'isolated-observer',
  NH_MINECRAFT_METADATA_USER_AGENT: 'NickHosting isolated test',
};
const imageDigest = `sha256:${'f'.repeat(64)}`;
const combination = {
  release: '1.21.1',
  releaseType: 'release',
  protocolId: 767,
  family: 'netty',
  profile: 'vanilla',
  javaMajor: 21,
  runtimeDigest: 'a'.repeat(64),
  protocolSource: { url: 'https://example.test/protocols', sha256: 'b'.repeat(64) },
};
const runtime = {
  release: '1.21.1',
  releaseType: 'release',
  profile: 'vanilla',
  javaMajor: 21,
  artifacts: [{ role: 'server', url: 'https://example.test/server.jar', sha256: 'e'.repeat(64) }],
  installation: { kind: 'server-jar' },
  evidence: [],
};
const binding = {
  profile: 'vanilla',
  release: '1.21.1',
  image: 'fixture/image:1',
  imageJavaMajor: 21,
  declaredEggVariables: ['VERSION'],
  bindings: { release: 'VERSION' },
  fixedVariables: {},
  installationKind: 'server-jar',
  artifactPaths: { server: 'server.jar' },
  supportedProperties: [],
};
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
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
      resolved_runtime: JSON.stringify(runtime),
      binding: JSON.stringify(binding),
      mapping_digest: minecraftMappingDigest(mapping),
      identity_digest: minecraftDigest({ combination, binding }),
      enabled: true,
    })
    .execute();
  await evidence(false, new Date(Date.now() - 1000));
});
async function evidence(
  failed = false,
  at = new Date(),
  kind: 'real-server' | 'installation-bootstrap' = 'real-server',
) {
  const choice = await inspectMinecraftCombination(f.db, choiceId, env);
  const report = {
    runId: randomUUID(),
    kind,
    combinationDigest: minecraftDigest(choice.combination),
    mappingDigest: choice.mappingDigest,
    choiceDigest: choice.row.identity_digest,
    recordedAt: at.toISOString(),
    checks: Object.fromEntries(
      minecraftVerificationChecks.map((key) => [
        key,
        !failed &&
          (kind === 'real-server' || ['installation', 'status', 'readiness'].includes(key)),
      ]),
    ),
    evidenceSha256: 'd'.repeat(64),
    server: {
      uuid: randomUUID(),
      externalId: 'isolated-image-test',
      artifactSha256: 'e'.repeat(64),
      imageDigest,
      javaMajor: 21,
    },
    client: { implementation: 'isolated-client', version: '1', protocolId: 767 },
  };
  await f.db
    .insertInto('minecraft_verification_evidence')
    .values({
      id: report.runId,
      combination_id: choiceId,
      report: JSON.stringify(report),
      signature: signMinecraftEvidence(report, env),
    })
    .execute();
}
async function queued() {
  return createManagedServer(
    f.db,
    f.adapter,
    f.context,
    f.input({ minecraft: { choiceId, configuration: { eula: true } } }),
    env,
  );
}
function lifecycleFixture() {
  let remote: ApplicationServer | null = null;
  const createServer = vi.fn(async (plan: ProvisionPlan) => {
    remote = {
      id: f.providerNodeId,
      uuid: randomUUID(),
      identifier: `fixture${f.providerNodeId}`,
      external_id: plan.externalId,
      name: plan.name,
      description: '',
      suspended: false,
      limits: plan.limits,
      feature_limits: plan.featureLimits,
      user: plan.userId,
      node: f.providerNodeId,
      allocation: plan.allocation.default,
      nest: 1,
      egg: plan.eggId,
      status: null,
      container: { startup_command: plan.startup, image: plan.dockerImage, installed: 1 },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      relationships: {
        allocations: {
          object: 'list',
          data: [
            {
              attributes: {
                id: plan.allocation.default,
                ip: '10.0.0.2',
                port: 20000,
                assigned: true,
              },
            },
          ],
        },
      },
    };
    return remote;
  });
  const findServerByExternalId = vi.fn(async () => remote);
  const adapter = {
    ...f.adapter,
    createServer,
    findServerByExternalId,
    getApplicationServer: vi.fn(async () => remote),
    confirmInstallation: async (
      _id: number,
      _identifier: string,
      input: { onConfirmed: () => Promise<void> },
    ) => {
      await input.onConfirmed();
      return { confirmed: true };
    },
    getResources: async () => ({
      current_state: 'offline',
      is_suspended: false,
      resources: {
        memory_bytes: 0,
        cpu_absolute: 0,
        disk_bytes: 0,
        network_rx_bytes: 0,
        network_tx_bytes: 0,
      },
    }),
  } as unknown as PterodactylAdapter;
  const options: LifecycleOptions = {
    adapter,
    env,
    authorizeEffect: async (jobId, serverId, connection) => {
      await authorizeQueuedEffect(connection, jobId, serverId, env);
    },
    reserveInstallation: async (serverId, jobId, connection) => {
      await connection
        .insertInto('installation_reservations')
        .values({
          server_id: serverId,
          operation_id: jobId,
          physical_host_id: f.hostId,
          memory_mib: 1178,
          cpu_percent: 100,
        })
        .onConflict((c) => c.column('server_id').doNothing())
        .execute();
    },
  };
  return { options, adapter, createServer, findServerByExternalId };
}
describe('queued Minecraft provisioning evidence revalidation', () => {
  it.each(['revoked', 'failed-report', 'tampered-plan', 'mapping-change'] as const)(
    'prevents any create effect after %s',
    async (change) => {
      const operation = await queued();
      const external = lifecycleFixture();
      if (change === 'revoked')
        await f.db
          .updateTable('minecraft_combinations')
          .set({ enabled: false })
          .where('id', '=', choiceId)
          .execute();
      if (change === 'failed-report') await evidence(true);
      if (change === 'mapping-change')
        await f.db
          .updateTable('runtime_egg_mappings')
          .set({ startup: 'changed' })
          .where('id', '=', f.mappingId)
          .execute();
      if (change === 'tampered-plan') {
        const row = await f.db
          .selectFrom('server_operations')
          .select('plan')
          .where('job_id', '=', operation.jobId)
          .executeTakeFirstOrThrow();
        const provision = row.plan.provision as Record<string, unknown>;
        await f.db
          .updateTable('server_operations')
          .set({
            plan: JSON.stringify({
              ...row.plan,
              provision: { ...provision, environment: { VERSION: '26.1' } },
            }),
          })
          .where('job_id', '=', operation.jobId)
          .execute();
      }
      await processServerOperation(f.db, operation.jobId, external.options);
      expect(external.findServerByExternalId).toHaveBeenCalledOnce();
      expect(external.createServer).not.toHaveBeenCalled();
      const stored = await f.db
        .selectFrom('server_operations')
        .selectAll()
        .where('job_id', '=', operation.jobId)
        .executeTakeFirstOrThrow();
      expect(stored.effect_state).toBe('none');
      expect(stored.effect_started_at).toBeNull();
    },
  );
  it('rechecks a revocation during durable effect preparation before the provider call', async () => {
    const operation = await queued();
    const external = lifecycleFixture();
    external.options.checkpoint = async (point) => {
      if (point === 'prepared')
        await f.db
          .updateTable('minecraft_combinations')
          .set({ enabled: false })
          .where('id', '=', choiceId)
          .execute();
    };
    expect(await processServerOperation(f.db, operation.jobId, external.options)).toBe('failed');
    expect(external.createServer).not.toHaveBeenCalled();
    const stored = await f.db
      .selectFrom('server_operations')
      .selectAll()
      .where('job_id', '=', operation.jobId)
      .executeTakeFirstOrThrow();
    expect(stored.effect_state).toBe('none');
    expect(stored.plan.rejected).toBe(true);
  });
  it('allows current evidence and reconciles a lost create response after availability is revoked', async () => {
    const operation = await queued();
    const external = lifecycleFixture();
    let crash = true;
    external.options.checkpoint = async (point) => {
      if (point === 'remote_succeeded' && crash) {
        crash = false;
        throw new Error('isolated crash');
      }
    };
    expect(await processServerOperation(f.db, operation.jobId, external.options)).toBe('waiting');
    expect(external.createServer).toHaveBeenCalledOnce();
    await f.db
      .updateTable('minecraft_combinations')
      .set({ enabled: false })
      .where('id', '=', choiceId)
      .execute();
    await f.db
      .updateTable('operation_jobs')
      .set({ next_attempt_at: new Date(0) })
      .where('id', '=', operation.jobId)
      .execute();
    await processServerOperation(f.db, operation.jobId, external.options);
    expect(external.createServer).toHaveBeenCalledOnce();
    const stored = await f.db
      .selectFrom('managed_servers')
      .select(['pterodactyl_uuid', 'installation_state'])
      .where('id', '=', operation.serverId)
      .executeTakeFirstOrThrow();
    expect(stored.pterodactyl_uuid).not.toBeNull();
    expect(stored.installation_state).toBe('installed');
  });
  it('checks rollout eligibility against the resource owner rather than a privileged job actor', async () => {
    const operation = await queued();
    await f.db
      .updateTable('operation_jobs')
      .set({ actor_id: f.owner.actorUserId, subject_id: f.owner.subjectUserId })
      .where('id', '=', operation.jobId)
      .execute();
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'private-testing', allowlist: [] })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    const external = lifecycleFixture();
    await processServerOperation(f.db, operation.jobId, external.options);
    expect(external.createServer).not.toHaveBeenCalled();
  });
});

describe('host-bound Minecraft runtime image evidence', () => {
  async function installed() {
    const operation = await queued();
    const external = lifecycleFixture();
    const result = await processServerOperation(f.db, operation.jobId, external.options);
    const diagnostic = await f.db
      .selectFrom('server_operations')
      .select(['phase', 'plan'])
      .where('job_id', '=', operation.jobId)
      .executeTakeFirstOrThrow();
    expect({ result, waitReason: diagnostic.plan.waitReason, phase: diagnostic.phase }).toEqual({
      result: 'succeeded',
      waitReason: null,
      phase: 'complete',
    });
    await f.db
      .updateTable('minecraft_server_profiles')
      .set({ installed: true })
      .where('server_id', '=', operation.serverId)
      .execute();
    const observer = {
      preflight: vi.fn(async () => {}),
      stopped: vi.fn(async () => true),
      processStartedAt: vi.fn(async () => '2026-10-09T10:00:00.000000001Z'),
      imageIdentity: vi.fn(async (): Promise<string | null> => imageDigest),
    };
    const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
    const management = await createManagementRuntime({
      db: f.db,
      codec,
      adapter: external.adapter,
      containerObserver: observer,
      env,
    });
    return { ...operation, external, observer, codec, management };
  }
  it('distinguishes absent initial containers from proof required for playable readiness', async () => {
    const value = await installed();
    value.observer.imageIdentity.mockResolvedValue(null);
    await expect(
      value.management.assertMinecraftRuntimeImage(value.serverId, f.db, false),
    ).resolves.toMatchObject({ expected: imageDigest, observed: null, verified: false });
    await expect(value.management.assertMinecraftRuntimeImage(value.serverId)).rejects.toThrow(
      'integration_unavailable',
    );
    await expect(
      value.management.lifecycle.observeProcessStart(value.serverId, f.db),
    ).rejects.toThrow('integration_unavailable');
    expect(value.observer.processStartedAt).toHaveBeenCalledOnce();
  });
  it('rejects changed actual image contents under an unchanged mutable image tag', async () => {
    const value = await installed();
    value.observer.imageIdentity.mockResolvedValue(`sha256:${'c'.repeat(64)}`);
    await expect(
      value.management.assertMinecraftRuntimeImage(value.serverId, f.db, false),
    ).rejects.toThrow('provenance_mismatch');
    await expect(
      value.management.lifecycle.observeProcessStart(value.serverId, f.db),
    ).rejects.toThrow('provenance_mismatch');
    expect(value.observer.processStartedAt).toHaveBeenCalledOnce();
  });
  it('permits current signed actual-image evidence even when new creation is disabled', async () => {
    const value = await installed();
    await f.db
      .updateTable('minecraft_combinations')
      .set({ enabled: false })
      .where('id', '=', choiceId)
      .execute();
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'disabled-for-new-servers' })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    await expect(
      value.management.assertMinecraftRuntimeImage(value.serverId),
    ).resolves.toMatchObject({ expected: imageDigest, observed: imageDigest, verified: true });
    await expect(
      value.management.lifecycle.observeProcessStart(value.serverId, f.db),
    ).resolves.toEqual(expect.any(String));
    expect(value.observer.processStartedAt).toHaveBeenCalledTimes(2);
  });
  it('rejects container replacement between image and process observations', async () => {
    const value = await installed();
    value.observer.processStartedAt
      .mockResolvedValueOnce('2026-10-09T10:00:00.000000001Z')
      .mockResolvedValueOnce('2026-10-09T10:00:00.000000002Z');
    await expect(
      value.management.lifecycle.observeProcessStart(value.serverId, f.db),
    ).rejects.toThrow('operation_uncertain');
  });
  it('restricts signed installation bootstrap evidence to the actual private tester', async () => {
    const value = await installed();
    await evidence(false, new Date(), 'installation-bootstrap');
    await expect(value.management.assertMinecraftRuntimeImage(value.serverId)).rejects.toThrow(
      'integration_unavailable',
    );
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'private-testing', allowlist: [f.context.subjectUserId] })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    await expect(
      value.management.assertMinecraftRuntimeImage(value.serverId),
    ).resolves.toMatchObject({ verified: true, report: { kind: 'installation-bootstrap' } });
    await f.db
      .updateTable('game_rollouts')
      .set({ allowlist: [] })
      .where('integration_id', '=', 'minecraft-java')
      .execute();
    await expect(value.management.assertMinecraftRuntimeImage(value.serverId)).rejects.toThrow(
      'integration_unavailable',
    );
  });
  it('rejects a queued start before its power effect if actual image content changed', async () => {
    const value = await installed();
    const job = await enqueueServerOperation(
      f.db,
      f.context,
      value.serverId,
      { action: 'start', idempotencyKey: randomUUID() },
      env,
    );
    value.observer.imageIdentity.mockResolvedValue(`sha256:${'c'.repeat(64)}`);
    const power = vi.fn(async () => {});
    Object.assign(value.external.adapter, { power });
    expect(await processServerOperation(f.db, job.jobId, value.management.lifecycle)).toBe(
      'failed',
    );
    expect(power).not.toHaveBeenCalled();
  });
  it('does not treat a Minecraft mapping with a missing profile as another game', async () => {
    const value = await installed();
    await f.db
      .deleteFrom('minecraft_server_profiles')
      .where('server_id', '=', value.serverId)
      .execute();
    await expect(
      value.management.assertMinecraftRuntimeImage(value.serverId, f.db, false),
    ).rejects.toThrow('integration_unavailable');
  });
  it('does not retain an older successful image report after a newer failed run', async () => {
    const value = await installed();
    await evidence(true);
    await expect(value.management.assertMinecraftRuntimeImage(value.serverId)).rejects.toThrow(
      'integration_unavailable',
    );
  });
  it('binds observation to the right host and live managed provider identity first', async () => {
    const value = await installed();
    const wrongHost = await createManagementRuntime({
      db: f.db,
      codec: value.codec,
      adapter: value.external.adapter,
      containerObserver: value.observer,
      env: { ...env, NH_OBSERVER_ID: 'another-host' },
    });
    await expect(wrongHost.assertMinecraftRuntimeImage(value.serverId)).rejects.toThrow(
      'configuration_invalid',
    );
    expect(value.observer.imageIdentity).not.toHaveBeenCalled();
    const remote = await value.external.adapter.getApplicationServer(1);
    vi.mocked(value.external.adapter.getApplicationServer).mockResolvedValue({
      ...remote,
      external_id: 'unrelated-server',
    });
    await expect(value.management.assertMinecraftRuntimeImage(value.serverId)).rejects.toThrow();
    expect(value.observer.imageIdentity).not.toHaveBeenCalled();
  });
});
