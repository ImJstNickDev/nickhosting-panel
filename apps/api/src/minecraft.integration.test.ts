import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftDigest, minecraftVerificationChecks } from '@nickhosting/minecraft';
import {
  importMinecraftEvidence,
  inspectMinecraftCombination,
  type ManagementRuntime,
  minecraftMappingDigest,
  signMinecraftEvidence,
} from '@nickhosting/server-management';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerMinecraftRoutes } from './minecraft.js';
import { registerServerRoutes } from './servers.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let fixture: Awaited<ReturnType<typeof managementFixture>>;
let app: Hono<{ Variables: Variables }>;
let actor: Awaited<ReturnType<typeof managementFixture>>['context'];
const management = vi.fn<() => Promise<ManagementRuntime>>();
const env = { NH_MINECRAFT_EVIDENCE_KEY: '1'.repeat(64) };
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(async () => {
  fixture = await managementFixture(database.db, { interactive: true });
  actor = fixture.context;
  management.mockReset().mockRejectedValue(new DomainError('integration_unavailable'));
  app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof DomainError ? error.code : 'internal_error' },
      error instanceof DomainError ? (error.status as 400) : 500,
    ),
  );
  registerMinecraftRoutes(app, {
    db: fixture.db,
    env,
    principal: async () => actor,
    body: async (c) => c.req.json(),
    management,
  });
  registerServerRoutes(app, {
    db: fixture.db,
    env,
    principal: async () => actor,
    management,
    acquireUploadSlot: () => () => {},
  });
});
// Signed synthetic compatibility records are confined to this isolated database;
// no provider server is provisioned and no public compatibility is asserted.
async function eligibleChoice() {
  await fixture.db
    .insertInto('game_integrations')
    .values({
      id: 'minecraft-java',
      version: '1.0.0',
      manifest: {},
    })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await fixture.db
    .insertInto('game_rollouts')
    .values({
      integration_id: 'minecraft-java',
      state: 'public',
      allowlist: [],
    })
    .onConflict((c) => c.column('integration_id').doUpdateSet({ state: 'public', allowlist: [] }))
    .execute();
  await fixture.db
    .updateTable('runtime_egg_mappings')
    .set({
      game_id: 'minecraft-java',
      runtime_id: 'vanilla',
      startup: 'java -jar server.jar',
    })
    .where('id', '=', fixture.mappingId)
    .execute();
  const mapping = await fixture.db
    .selectFrom('runtime_egg_mappings')
    .selectAll()
    .where('id', '=', fixture.mappingId)
    .executeTakeFirstOrThrow();
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
  const runtime = {
    release: '1.21.1',
    releaseType: 'release',
    profile: 'vanilla',
    javaMajor: 21,
    artifacts: [{ role: 'server', url: 'https://example.test/server.jar', sha256: 'e'.repeat(64) }],
    installation: { kind: 'server-jar', args: [] },
    evidence: [],
  };
  const id = randomUUID();
  await fixture.db
    .insertInto('minecraft_combinations')
    .values({
      id,
      mapping_id: fixture.mappingId,
      combination: JSON.stringify(combination),
      resolved_runtime: JSON.stringify(runtime),
      binding: JSON.stringify(binding),
      mapping_digest: minecraftMappingDigest(mapping),
      identity_digest: minecraftDigest({ combination, binding }),
      enabled: true,
    })
    .execute();
  const choice = await inspectMinecraftCombination(fixture.db, id, env);
  const report = {
    runId: randomUUID(),
    kind: 'real-server',
    combinationDigest: minecraftDigest(combination),
    mappingDigest: choice.mappingDigest,
    choiceDigest: choice.row.identity_digest,
    recordedAt: new Date().toISOString(),
    checks: Object.fromEntries(minecraftVerificationChecks.map((name) => [name, true])),
    evidenceSha256: 'd'.repeat(64),
    server: {
      uuid: randomUUID(),
      externalId: 'isolated-api-fixture',
      artifactSha256: 'e'.repeat(64),
      imageDigest: `sha256:${'f'.repeat(64)}`,
      javaMajor: 21,
    },
    client: { implementation: 'isolated-fixture-client', version: '1', protocolId: 767 },
  };
  await importMinecraftEvidence(
    fixture.db,
    fixture.owner,
    id,
    {
      report,
      signature: signMinecraftEvidence(report, env),
    },
    env,
  );
  management.mockResolvedValue({
    adapter: fixture.adapter,
    refreshObservations: fixture.observe,
    minecraftOptions: async () => ({
      http: { json: vi.fn(), download: vi.fn() },
      mountdataRoot: './mountdata/isolated-api-fixture',
      userAgent: 'NickHosting isolated test',
      env,
      authorizeJob: async () => fixture.context,
    }),
  } as unknown as ManagementRuntime);
  return id;
}
function createInput(choiceId: string) {
  return {
    name: 'Isolated Minecraft',
    idempotencyKey: randomUUID(),
    limits: fixture.limits,
    autoStart: false,
    minecraft: { choiceId, configuration: { eula: true } },
  };
}
async function post(path: string, input: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}
describe('Minecraft backend API authorization and user projection', () => {
  it('rejects user access to every technical compatibility administration route', async () => {
    const id = randomUUID();
    for (const [method, path] of [
      ['GET', '/v1/owner/minecraft/manifest'],
      ['GET', '/v1/owner/minecraft/compatibility'],
      ['POST', '/v1/owner/minecraft/compatibility'],
      ['POST', '/v1/owner/minecraft/catalog/sync'],
      ['POST', `/v1/owner/minecraft/compatibility/${id}/evidence`],
      ['PUT', `/v1/owner/minecraft/compatibility/${id}/availability`],
    ] as const) {
      const result = await app.request(path, {
        method,
        ...(method !== 'GET' ? { body: '{}' } : {}),
      });
      expect(result.status).toBe(403);
    }
    expect(management).not.toHaveBeenCalled();
  });
  it('returns only the simple four-step wizard when no verified release is available', async () => {
    const choices = await app.request('/v1/minecraft/choices');
    expect(await choices.json()).toEqual([]);
    const response = await app.request('/v1/minecraft/wizard');
    const wizard = await response.json();
    expect(wizard.choices).toEqual([]);
    expect(wizard.steps.map((step: { id: string }) => step.id)).toEqual([
      'choose-game',
      'configure',
      'resources',
      'create',
    ]);
    expect(JSON.stringify(wizard)).not.toMatch(/protocolId|experimental|compatibility/);
    expect(management).not.toHaveBeenCalled();
  });
  it('checks server ownership before world, content, wipe and reinstall provider access', async () => {
    const serverId = await fixture.server();
    actor = (await managementFixture(database.db, { interactive: true })).context;
    for (const [method, suffix] of [
      ['GET', ''],
      ['GET', '/worlds'],
      ['GET', '/wipe-preview'],
      ['POST', '/operations'],
    ] as const) {
      const response = await app.request(`/v1/servers/${serverId}/minecraft${suffix}`, {
        method,
        ...(method === 'POST'
          ? {
              body: JSON.stringify({ action: 'wipe', idempotencyKey: randomUUID(), confirm: true }),
            }
          : {}),
      });
      expect(response.status).toBe(403);
    }
    expect(management).not.toHaveBeenCalled();
  });
  it('never accepts arbitrary wizard runtime or file path assertions', async () => {
    const response = await app.request('/v1/minecraft/wizard', {
      method: 'POST',
      body: JSON.stringify({ sourceId: randomUUID(), release: '26.1', path: '/tmp/untrusted.zip' }),
    });
    expect(response.status).toBe(400);
    expect(management).not.toHaveBeenCalled();
  });
  it('rejects create without a gated Minecraft choice before acquiring content', async () => {
    const response = await app.request('/v1/minecraft/servers', {
      method: 'POST',
      body: JSON.stringify({
        mappingId: fixture.mappingId,
        name: 'test',
        limits: { memory: 1024, cpu: 100, disk: 1024 },
        idempotencyKey: randomUUID(),
      }),
    });
    expect(response.status).toBe(400);
    expect(management).not.toHaveBeenCalled();
  });
  it('creates idempotently from a regular user public choice without Owner-only mapping metadata', async () => {
    const choiceId = await eligibleChoice();
    expect((await app.request('/v1/owner/runtime-mappings')).status).toBe(403);
    const catalog = await (await app.request('/v1/minecraft/choices')).json();
    const choice = catalog.find((entry: { id: string }) => entry.id === choiceId);
    expect(choice).toEqual({
      id: choiceId,
      version: '1.21.1',
      releaseType: 'release',
      runtime: 'vanilla',
    });
    const wizard = await (await app.request('/v1/minecraft/wizard')).json();
    expect(wizard.choices.some((entry: { id: string }) => entry.id === choiceId)).toBe(true);
    const input = createInput(choice.id);
    const response = await post('/v1/minecraft/servers', input);
    expect(response.status).toBe(202);
    const created = await response.json();
    expect(await (await post('/v1/minecraft/servers', input)).json()).toEqual(created);
    expect(
      await fixture.db
        .selectFrom('managed_servers')
        .select(['mapping_id', 'owner_id'])
        .where('id', '=', created.serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      mapping_id: fixture.mappingId,
      owner_id: actor.subjectUserId,
    });
    expect(
      await fixture.db
        .selectFrom('minecraft_server_profiles')
        .select('combination_id')
        .where('server_id', '=', created.serverId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ combination_id: choiceId });
  });
  it('rejects caller-supplied matching or conflicting mapping IDs on dedicated creation', async () => {
    const choiceId = await eligibleChoice();
    management.mockClear();
    for (const mappingId of [fixture.mappingId, randomUUID()])
      expect(
        (await post('/v1/minecraft/servers', { ...createInput(choiceId), mappingId })).status,
      ).toBe(400);
    expect(management).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'unallowlisted', 'unverified', 'unknown'] as const)(
    'rechecks %s choices before acquiring provider access',
    async (reason) => {
      let choiceId: string = await eligibleChoice();
      if (reason === 'disabled')
        await fixture.db
          .updateTable('minecraft_combinations')
          .set({ enabled: false })
          .where('id', '=', choiceId)
          .execute();
      if (reason === 'unallowlisted')
        await fixture.db
          .updateTable('game_rollouts')
          .set({ state: 'private-testing', allowlist: [] })
          .where('integration_id', '=', 'minecraft-java')
          .execute();
      if (reason === 'unverified')
        await fixture.db
          .deleteFrom('minecraft_verification_evidence')
          .where('combination_id', '=', choiceId)
          .execute();
      if (reason === 'unknown') choiceId = randomUUID();
      management.mockClear();
      expect((await post('/v1/minecraft/servers', createInput(choiceId))).status).toBe(
        reason === 'unallowlisted' ? 403 : reason === 'unknown' ? 404 : 503,
      );
      expect(management).not.toHaveBeenCalled();
      expect(
        await fixture.db
          .selectFrom('managed_servers')
          .select('id')
          .where('owner_id', '=', actor.subjectUserId)
          .execute(),
      ).toEqual([]);
    },
  );
  it('retains generic M2 rejection of omitted choices, unprepared modpacks and disabled combinations', async () => {
    const choiceId = await eligibleChoice();
    const selected = { ...createInput(choiceId), mappingId: fixture.mappingId };
    const { minecraft, ...omitted } = selected;
    expect((await post('/v1/servers', omitted)).status).toBe(400);
    expect(
      (
        await post('/v1/servers', {
          ...selected,
          minecraft: {
            ...minecraft,
            configuration: {
              eula: true,
              modpack: { sourceId: randomUUID() },
            },
          },
        })
      ).status,
    ).toBe(400);
    await fixture.db
      .updateTable('minecraft_combinations')
      .set({ enabled: false })
      .where('id', '=', choiceId)
      .execute();
    expect((await post('/v1/servers', selected)).status).toBe(503);
    expect(
      await fixture.db
        .selectFrom('managed_servers')
        .select('id')
        .where('owner_id', '=', actor.subjectUserId)
        .execute(),
    ).toEqual([]);
  });
});
