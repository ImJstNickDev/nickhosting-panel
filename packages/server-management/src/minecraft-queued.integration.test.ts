import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftDigest, minecraftVerificationChecks } from '@nickhosting/minecraft';
import type {
  ApplicationServer,
  ProvisionPlan,
  PterodactylAdapter,
} from '@nickhosting/pterodactyl-adapter';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reserveStart } from './admission.js';
import { type LifecycleOptions, processServerOperation } from './lifecycle.js';
import {
  inspectMinecraftCombination,
  minecraftMappingDigest,
  signMinecraftEvidence,
} from './minecraft-registry.js';
import { createManagedServer, enqueueServerOperation } from './registry.js';
import { authorizeQueuedEffect, createManagementRuntime } from './runtime.js';
import {
  createSchedule,
  getAutomationConsent,
  runDueSchedules,
  setAutomationConsent,
  updateSchedule,
} from './schedules.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let choiceId: string;
const env = {
  NH_MINECRAFT_EVIDENCE_KEY: '1'.repeat(64),
  NH_OBSERVER_ID: 'isolated-observer',
  NH_MINECRAFT_METADATA_USER_AGENT: 'NickHosting isolated test',
};
const serverJar = Buffer.from('isolated verified runtime');
const serverHash = createHash('sha256').update(serverJar).digest('hex');
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
  artifacts: [{ role: 'server', url: 'https://example.test/server.jar', sha256: serverHash }],
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
    .updateTable('managed_nodes')
    .set({
      backend_allocation_pool: JSON.stringify({
        ...f.backendAllocationPool,
        allocations: f.backendAllocationPool.allocations.map((pin) => ({
          ...pin,
          directEndpoint: { hostname: `${f.nodeId}.example.test`, port: pin.port },
        })),
      }),
    })
    .where('id', '=', f.nodeId)
    .execute();
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
    .set({ game_id: 'minecraft-java', runtime_id: 'vanilla', startup: 'java -jar server.jar' })
    .where('id', '=', f.mappingId)
    .execute();
  const mapping = await f.db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', f.mappingId)
    .executeTakeFirstOrThrow();
  Object.assign(f.adapter, {
    getEgg: vi.fn(async () => ({
      id: 1,
      nest: 1,
      relationships: {
        variables: { object: 'list', data: [{ attributes: { env_variable: 'VERSION' } }] },
      },
    })),
  });
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
      artifactSha256: serverHash,
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
      container: {
        startup_command: plan.startup,
        image: plan.dockerImage,
        installed: 1,
        environment: { ...plan.environment },
      },
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
    listFiles: vi.fn(async () => [
      { name: 'server.jar', is_file: true, is_symlink: false, size: serverJar.length },
    ]),
    downloadFile: vi.fn(async () => ({ body: new Response(serverJar).body })),
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
      await authorizeQueuedEffect(connection, jobId, serverId, env, adapter);
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
  it('persists the integration image in the durable plan and refuses image substitution', async () => {
    const selectedImage = 'ghcr.io/pterodactyl/yolks:java_21';
    await f.db
      .updateTable('runtime_egg_mappings')
      .set({ image_mode: 'integration', docker_image: '' })
      .where('id', '=', f.mappingId)
      .execute();
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    const pinnedBinding = { ...binding, image: selectedImage };
    await f.db
      .updateTable('minecraft_combinations')
      .set({
        binding: JSON.stringify(pinnedBinding),
        mapping_digest: minecraftMappingDigest(mapping),
        identity_digest: minecraftDigest({ combination, binding: pinnedBinding }),
      })
      .where('id', '=', choiceId)
      .execute();
    await evidence();
    const getEgg = f.adapter.getEgg.bind(f.adapter);
    Object.assign(f.adapter, {
      getEgg: async (nest: number, egg: number) => ({
        ...(await getEgg(nest, egg)),
        docker_image: selectedImage,
        docker_images: { java21: selectedImage },
      }),
    });
    const operation = await queued();
    const row = await f.db
      .selectFrom('server_operations')
      .select('plan')
      .where('job_id', '=', operation.jobId)
      .executeTakeFirstOrThrow();
    expect((row.plan.provision as ProvisionPlan).dockerImage).toBe(selectedImage);
    await expect(
      authorizeQueuedEffect(f.db, operation.jobId, operation.serverId, env, f.adapter),
    ).resolves.toBeDefined();
    await f.db
      .updateTable('server_operations')
      .set({
        plan: JSON.stringify({
          ...row.plan,
          provision: {
            ...(row.plan.provision as ProvisionPlan),
            dockerImage: 'ghcr.io/pterodactyl/yolks:java_25',
          },
        }),
      })
      .where('job_id', '=', operation.jobId)
      .execute();
    await expect(
      authorizeQueuedEffect(f.db, operation.jobId, operation.serverId, env, f.adapter),
    ).rejects.toThrow('configuration_invalid');
  });

  it.each([
    'revoked',
    'tampered-plan',
    'tampered-startup',
    'extra-environment',
    'mapping-change',
  ] as const)('prevents any create effect after %s', async (change) => {
    const operation = await queued();
    const external = lifecycleFixture();
    if (change === 'revoked')
      await f.db
        .updateTable('minecraft_combinations')
        .set({ enabled: false })
        .where('id', '=', choiceId)
        .execute();
    if (change === 'mapping-change')
      await f.db
        .updateTable('runtime_egg_mappings')
        .set({ startup: 'changed' })
        .where('id', '=', f.mappingId)
        .execute();
    if (['tampered-plan', 'tampered-startup', 'extra-environment'].includes(change)) {
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
            provision: {
              ...provision,
              ...(change === 'tampered-startup'
                ? { startup: 'java -jar other.jar' }
                : {
                    environment:
                      change === 'extra-environment'
                        ? { VERSION: '1.21.1', JDK_JAVA_OPTIONS: '-Dfabric.gameJarPath=other.jar' }
                        : { VERSION: '26.1' },
                  }),
            },
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
  });
  it('refuses a queued provision after the actual egg gains an unbound default variable', async () => {
    const operation = await queued();
    const external = lifecycleFixture();
    vi.mocked(external.adapter.getEgg).mockResolvedValue({
      id: 1,
      nest: 1,
      relationships: {
        variables: {
          object: 'list',
          data: [
            { attributes: { env_variable: 'VERSION' } },
            {
              attributes: {
                env_variable: 'UNBOUND_FLAGS',
                default_value: '-Dfabric.gameJarPath=other.jar',
              },
            },
          ],
        },
      },
    } as Awaited<ReturnType<PterodactylAdapter['getEgg']>>);
    await processServerOperation(f.db, operation.jobId, external.options);
    expect(external.createServer).not.toHaveBeenCalled();
  });
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
  it.each(['consent', 'schedule'] as const)(
    'rechecks scheduled %s revocation after a deferred runtime provider proof',
    async (revoked) => {
      const value = await installed();
      const consent = await getAutomationConsent(f.db, f.context, value.serverId);
      await setAutomationConsent(
        f.db,
        f.context,
        value.serverId,
        { allowed: true, expectedIntent: consent.expectedIntent },
        env,
      );
      const at = new Date(Date.now() + 1000);
      const input = {
        name: 'Isolated scheduled start',
        action: 'start' as const,
        timing: { kind: 'once' as const, at: at.toISOString() },
        timeZone: 'UTC',
        enabled: true,
      };
      const schedule = await createSchedule(f.db, f.context, value.serverId, input, env);
      expect(await runDueSchedules(f.db, env, { now: at })).toEqual({ dispatched: 1, skipped: 0 });
      const occurrence = await f.db
        .selectFrom('schedule_occurrences')
        .select('job_id')
        .where('schedule_id', '=', schedule.id)
        .executeTakeFirstOrThrow();
      if (!occurrence.job_id) throw new Error('Missing scheduled test job');
      const jobId = occurrence.job_id;
      const power = vi.fn(async () => {});
      Object.assign(value.external.adapter, { power });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      // Defer only the final, post-preparation authorization's provider proof.
      // Earlier authorizations must pass, otherwise this cannot reproduce the race.
      const processing = processServerOperation(f.db, jobId, {
        ...value.management.lifecycle,
        reserveStart: (serverId, id, action, db) => reserveStart(db, serverId, id, action, env),
        checkpoint: async (point) => {
          if (point !== 'prepared') return;
          const remote = await value.external.adapter.getApplicationServer(1);
          vi.mocked(value.external.adapter.getApplicationServer).mockImplementationOnce(
            async () => {
              entered.resolve();
              await release.promise;
              return remote;
            },
          );
        },
      });
      try {
        await Promise.race([
          entered.promise,
          processing.then(() => {
            throw new Error('Operation finished before the deferred provider proof');
          }),
        ]);
        expect(power).not.toHaveBeenCalled();
        if (revoked === 'consent') {
          const current = await getAutomationConsent(f.db, f.context, value.serverId);
          await setAutomationConsent(
            f.db,
            f.context,
            value.serverId,
            { allowed: false, expectedIntent: current.expectedIntent },
            env,
          );
        } else {
          await updateSchedule(
            f.db,
            f.context,
            value.serverId,
            schedule.id,
            { ...input, enabled: false, revision: schedule.revision },
            env,
          );
        }
      } finally {
        release.resolve();
      }
      expect(await processing).toBe('failed');
      expect(power).not.toHaveBeenCalled();
      expect(
        await f.db
          .selectFrom('server_operations')
          .select(['effect_state', 'plan'])
          .where('job_id', '=', jobId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        effect_state: 'none',
        plan: { rejected: true, powerEffectPrepared: false },
      });
      expect(
        await f.db
          .selectFrom('resource_reservations')
          .select('server_id')
          .where('server_id', '=', value.serverId)
          .executeTakeFirst(),
      ).toBeUndefined();
    },
  );
  it('distinguishes absent initial containers from proof required for playable readiness', async () => {
    const value = await installed();
    value.observer.imageIdentity.mockResolvedValue(null);
    await expect(
      value.management.assertMinecraftRuntimeImage(value.serverId, f.db, false),
    ).resolves.toMatchObject({ expected: null, observed: null, verified: false, report: null });
    await expect(value.management.assertMinecraftRuntimeImage(value.serverId)).rejects.toThrow(
      'integration_unavailable',
    );
    await expect(
      value.management.lifecycle.observeProcessStart(value.serverId, f.db),
    ).rejects.toThrow('integration_unavailable');
    expect(value.observer.processStartedAt).toHaveBeenCalledOnce();
  });
  it.each([
    'startup',
    'environment',
    'implicit-jvm',
    'missing-environment',
    'unknown-variable',
  ] as const)('rejects current provider %s drift before power or readiness', async (change) => {
    const value = await installed();
    const remote = await value.external.adapter.getApplicationServer(1);
    if (change === 'startup')
      remote.container.startup_command = 'java -Dfabric.gameJarPath=other.jar -jar server.jar';
    else if (change === 'environment') remote.container.environment = { VERSION: 'other' };
    else if (change === 'implicit-jvm')
      remote.container.environment = {
        ...remote.container.environment,
        JDK_JAVA_OPTIONS: '-Dfabric.gameJarPath=other.jar',
      };
    else if (change === 'unknown-variable')
      remote.container.environment = { ...remote.container.environment, UNBOUND: 'changed' };
    else delete remote.container.environment;
    await expect(
      value.management.lifecycle.observeProcessStart(value.serverId, f.db),
    ).rejects.toThrow('provenance_mismatch');
    const job = await enqueueServerOperation(
      f.db,
      f.context,
      value.serverId,
      { action: 'start', idempotencyKey: randomUUID() },
      env,
    );
    const power = vi.fn(async () => {});
    Object.assign(value.external.adapter, { power });
    expect(await processServerOperation(f.db, job.jobId, value.management.lifecycle)).toBe(
      'failed',
    );
    expect(power).not.toHaveBeenCalled();
  });
  it('rehashes launch inputs for each process epoch and rejects an out-of-band file change', async () => {
    const value = await installed();
    await value.management.lifecycle.observeProcessStart(value.serverId, f.db);
    await value.management.lifecycle.observeProcessStart(value.serverId, f.db);
    expect(value.external.adapter.downloadFile).toHaveBeenCalledTimes(1);
    value.observer.processStartedAt.mockResolvedValue('2026-10-09T11:00:00.000000001Z');
    vi.mocked(value.external.adapter.downloadFile).mockResolvedValue({
      body: new Response(Buffer.alloc(serverJar.length, 0x65)).body,
    } as Awaited<ReturnType<PterodactylAdapter['downloadFile']>>);
    await expect(
      value.management.lifecycle.observeProcessStart(value.serverId, f.db),
    ).rejects.toThrow('conflict');
    expect(value.external.adapter.downloadFile).toHaveBeenCalledTimes(2);
    const job = await enqueueServerOperation(
      f.db,
      f.context,
      value.serverId,
      { action: 'start', idempotencyKey: randomUUID() },
      env,
    );
    const power = vi.fn(async () => {});
    Object.assign(value.external.adapter, { power });
    expect(await processServerOperation(f.db, job.jobId, value.management.lifecycle)).toBe(
      'failed',
    );
    expect(power).not.toHaveBeenCalled();
  });
  it('accepts the standard derived allocation-limit metadata only when both provider fields match the immutable mapping', async () => {
    const value = await installed();
    const remote = await value.external.adapter.getApplicationServer(1);
    remote.container.environment = {
      ...remote.container.environment,
      P_SERVER_ALLOCATION_LIMIT: remote.feature_limits.allocations,
    };
    await expect(
      value.management.assertMinecraftRuntimeImage(value.serverId),
    ).resolves.toMatchObject({ verified: true });
    remote.container.environment.P_SERVER_ALLOCATION_LIMIT = remote.feature_limits.allocations + 1;
    await expect(value.management.assertMinecraftRuntimeImage(value.serverId)).rejects.toThrow(
      'provenance_mismatch',
    );
    remote.feature_limits.allocations += 1;
    await expect(value.management.assertMinecraftRuntimeImage(value.serverId)).rejects.toThrow(
      'provenance_mismatch',
    );
  });
  it('rejects changed actual image contents under an unchanged mutable image tag', async () => {
    const value = await installed();
    await value.management.assertMinecraftRuntimeImage(value.serverId);
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
  it('uses compiled Vanilla support without local signatures or historical reports', async () => {
    const value = await installed();
    await f.db
      .deleteFrom('minecraft_verification_evidence')
      .where('combination_id', '=', choiceId)
      .execute();
    const noKey = { ...env, NH_MINECRAFT_EVIDENCE_KEY: undefined };
    const management = await createManagementRuntime({
      db: f.db,
      codec: value.codec,
      adapter: value.external.adapter,
      containerObserver: value.observer,
      env: noKey,
    });
    await expect(management.assertMinecraftRuntimeImage(value.serverId)).resolves.toMatchObject({
      expected: imageDigest,
      observed: imageDigest,
      verified: true,
      report: null,
    });
    await expect(management.lifecycle.observeProcessStart(value.serverId, f.db)).resolves.toEqual(
      expect.any(String),
    );
    expect(
      await f.db
        .selectFrom('minecraft_server_profiles')
        .select('runtime_image_digest')
        .where('server_id', '=', value.serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ runtime_image_digest: imageDigest });
  });
  it('pins exactly one competing first-observed image and refuses the other', async () => {
    const value = await installed();
    const { requireMinecraftRuntimeImageEvidence } = await import(
      './minecraft-runtime-evidence.js'
    );
    const results = await Promise.allSettled([
      requireMinecraftRuntimeImageEvidence(f.db, value.serverId, imageDigest, env),
      requireMinecraftRuntimeImageEvidence(f.db, value.serverId, `sha256:${'c'.repeat(64)}`, env),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
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
    await value.management.assertMinecraftRuntimeImage(value.serverId);
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
  it('does not treat a failed historical report as authority over declared Vanilla installation', async () => {
    const value = await installed();
    await evidence(true);
    await expect(
      value.management.assertMinecraftRuntimeImage(value.serverId),
    ).resolves.toMatchObject({
      verified: true,
      report: null,
    });
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
