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
  // Each case owns its choices; large catalog fixtures must not enable later cases.
  await database.db.updateTable('minecraft_combinations').set({ enabled: false }).execute();
  fixture = await managementFixture(database.db, { interactive: true });
  const node = await fixture.db
    .selectFrom('managed_nodes')
    .selectAll()
    .where('id', '=', fixture.nodeId)
    .executeTakeFirstOrThrow();
  if (!node.backend_allocation_pool) throw new Error('Missing isolated allocation pool');
  const directHost = `fixture-${randomUUID()}.example.test`;
  await fixture.db
    .updateTable('managed_nodes')
    .set({
      backend_allocation_pool: JSON.stringify({
        ...node.backend_allocation_pool,
        allocations: node.backend_allocation_pool.allocations.map((pin) => ({
          ...pin,
          directEndpoint: { hostname: directHost, port: pin.port },
        })),
      }),
    })
    .where('id', '=', fixture.nodeId)
    .execute();
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
    env: {},
    principal: async () => actor,
    body: async (c) => c.req.json(),
    management,
  });
  registerServerRoutes(app, {
    db: fixture.db,
    env: {},
    principal: async () => actor,
    management,
    acquireUploadSlot: () => () => {},
  });
});
// Signed synthetic compatibility records are confined to this isolated database;
// no provider server is provisioned and no public compatibility is asserted.
async function eligibleChoice(attest = true) {
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
  if (attest)
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
  it('paginates more than 1000 Owner combinations without truncation, duplication or cursor ambiguity', async () => {
    const firstId = await eligibleChoice(false);
    const source = await fixture.db
      .selectFrom('minecraft_combinations')
      .selectAll()
      .where('id', '=', firstId)
      .executeTakeFirstOrThrow();
    const copies = Array.from({ length: 1000 }, (_, index) => {
      const combination = {
        ...(source.combination as Record<string, unknown>),
        buildId: `fixture-${index}`,
      };
      return {
        id: randomUUID(),
        mapping_id: source.mapping_id,
        identity_digest: minecraftDigest({ combination, binding: source.binding }),
        combination: JSON.stringify(combination),
        binding: JSON.stringify(source.binding),
        resolved_runtime: JSON.stringify(source.resolved_runtime),
        mapping_digest: source.mapping_digest,
        enabled: source.enabled,
      };
    });
    await fixture.db.insertInto('minecraft_combinations').values(copies).execute();
    actor = fixture.owner;
    const expected = await fixture.db
      .selectFrom('minecraft_combinations')
      .select('id')
      .orderBy('id', 'asc')
      .execute();
    let sqlCount = 0;
    const measured = fixture.db.withPlugin({
      transformQuery(args) {
        sqlCount++;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const measuredApp = new Hono<{ Variables: Variables }>();
    registerMinecraftRoutes(measuredApp, {
      db: measured,
      env,
      principal: async () => actor,
      body: async (c) => c.req.json(),
      management,
    });
    const ids: string[] = [];
    let after: string | null = null;
    do {
      sqlCount = 0;
      const response = await measuredApp.request(
        `/v1/owner/minecraft/compatibility?pageSize=100${after ? `&after=${after}` : ''}`,
      );
      expect(response.status).toBe(200);
      expect(sqlCount).toBe(3);
      const page = await response.json();
      expect(page.items.length).toBeLessThanOrEqual(100);
      expect(page.items[0]).toHaveProperty('releaseTime');
      ids.push(...page.items.map((item: { id: string }) => item.id));
      if (page.nextCursor) expect(page.nextCursor).toBe(page.items.at(-1).id);
      after = page.nextCursor;
    } while (after);
    expect(ids).toEqual(expected.map((row) => row.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(1000);
    const summaryIds: string[] = [];
    for (let page = 1; summaryIds.length < ids.length; page++) {
      sqlCount = 0;
      const response = await measuredApp.request(
        `/v1/owner/minecraft/compatibility?view=summary&pageSize=100&page=${page}`,
      );
      expect(response.status).toBe(200);
      expect(sqlCount).toBe(4);
      const body = await response.json();
      expect(body.total).toBe(ids.length);
      summaryIds.push(...body.items.map((item: { id: string }) => item.id));
    }
    expect(summaryIds).toEqual(ids);
  });
  it('serves filtered chronological Owner summaries in bounded queries with lazy protected evidence details', async () => {
    const sourceId = await eligibleChoice(false);
    const source = await fixture.db
      .selectFrom('minecraft_combinations')
      .selectAll()
      .where('id', '=', sourceId)
      .executeTakeFirstOrThrow();
    const versions = [
      { version: 'ordering-1.2', type: 'release', date: '2020-01-01', enabled: true },
      { version: 'ordering-1.10', type: 'release', date: '2022-01-01', enabled: false },
      { version: 'ordering-snapshot', type: 'snapshot', date: '2021-01-01', enabled: true },
      { version: 'ordering-unknown', type: 'old_alpha', date: null, enabled: true },
    ] as const;
    for (const version of versions) {
      await fixture.db
        .insertInto('minecraft_combinations')
        .values({
          id: randomUUID(),
          mapping_id: source.mapping_id,
          identity_digest: minecraftDigest({ version, sourceId }),
          mapping_digest: source.mapping_digest,
          combination: JSON.stringify({
            ...(source.combination as object),
            release: version.version,
            releaseType: version.type,
          }),
          resolved_runtime: '{}',
          binding: '{}',
          enabled: version.enabled,
        })
        .execute();
      if (version.date)
        await fixture.db
          .insertInto('minecraft_release_metadata')
          .values({
            id: version.version,
            release_type: version.type,
            release_time: new Date(version.date),
            metadata_url: 'https://example.test/metadata',
            sha1: 'a'.repeat(40),
          })
          .onConflict((c) => c.column('id').doNothing())
          .execute();
    }
    let count = 0;
    const measured = fixture.db.withPlugin({
      transformQuery(args) {
        count++;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const measuredApp = new Hono<{ Variables: Variables }>();
    registerMinecraftRoutes(measuredApp, {
      db: measured,
      env,
      principal: async () => actor,
      body: async (c) => c.req.json(),
      management,
    });
    actor = fixture.owner;
    const endpoint = '/v1/owner/minecraft/compatibility?view=summary&search=ordering-&pageSize=2';
    const response = await measuredApp.request(endpoint);
    expect(response.status).toBe(200);
    expect(count).toBe(4);
    const first = await response.json();
    expect(first).toMatchObject({ total: 4, page: 1, pageSize: 2, runtimes: ['vanilla'] });
    expect(
      first.items.map((row: { combination: { release: string } }) => row.combination.release),
    ).toEqual(['ordering-1.10', 'ordering-snapshot']);
    expect(first.items[0]).not.toHaveProperty('evidence');
    expect(first.items[0]).not.toHaveProperty('runtime');
    const second = await (await measuredApp.request(`${endpoint}&page=2`)).json();
    expect(
      second.items.map((row: { combination: { release: string } }) => row.combination.release),
    ).toEqual(['ordering-1.2', 'ordering-unknown']);
    const filtered = await (
      await measuredApp.request(
        `${endpoint}&releaseType=release&availability=enabled&runtime=vanilla`,
      )
    ).json();
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].combination.release).toBe('ordering-1.2');
    const oldest = await (await measuredApp.request(`${endpoint}&order=oldest`)).json();
    expect(
      oldest.items.map((row: { combination: { release: string } }) => row.combination.release),
    ).toEqual(['ordering-1.2', 'ordering-snapshot']);
    const names = await (
      await measuredApp.request(`${endpoint}&order=name-asc&releaseType=release`)
    ).json();
    expect(
      names.items.map((row: { combination: { release: string } }) => row.combination.release),
    ).toEqual(['ordering-1.2', 'ordering-1.10']);
    const detail = await (
      await app.request(`/v1/owner/minecraft/compatibility/${sourceId}`)
    ).json();
    expect(detail).toHaveProperty('evidence');
    actor = fixture.context;
    expect((await app.request(`/v1/owner/minecraft/compatibility/${sourceId}`)).status).toBe(403);
    expect((await app.request(`${endpoint}&page=bad`)).status).toBe(403);
    actor = fixture.owner;
    expect((await app.request(`${endpoint}&page=bad`)).status).toBe(400);
    expect((await app.request(`${endpoint}&order=unsafe`)).status).toBe(400);
  });
  it('validates Owner catalog pagination after authorization and preserves empty legacy arrays', async () => {
    const endpoint = '/v1/owner/minecraft/compatibility';
    expect((await app.request(`${endpoint}?pageSize=101&after=bad`)).status).toBe(403);
    actor = fixture.owner;
    for (const query of [
      'pageSize=101',
      'pageSize=0',
      'pageSize=1.5',
      'after=bad',
      'unexpected=true',
    ]) {
      expect((await app.request(`${endpoint}?${query}`)).status).toBe(400);
    }
    const afterLast = await app.request(
      `${endpoint}?pageSize=100&after=ffffffff-ffff-4fff-bfff-ffffffffffff`,
    );
    expect(await afterLast.json()).toEqual({ items: [], nextCursor: null });
    const legacy = await (await app.request(endpoint)).json();
    expect(Array.isArray(legacy)).toBe(true);
  });
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
      capabilities: {
        installation: true,
        directConnection: true,
        playerManagement: true,
        gateway: false,
        readiness: false,
        playerIdle: false,
        sleepWake: false,
      },
      id: choiceId,
      version: '1.21.1',
      releaseType: 'release',
      releaseTime: null,
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
  it.each(['missing', 'stale'] as const)(
    'refreshes %s host observations before first Minecraft creation',
    async (kind) => {
      const choiceId = await eligibleChoice(false);
      if (kind === 'missing')
        await fixture.db
          .deleteFrom('host_observations')
          .where('host_id', '=', fixture.hostId)
          .execute();
      else await fixture.observe({}, new Date(0));
      const response = await post('/v1/minecraft/servers', createInput(choiceId));
      expect(response.status).toBe(202);
      const observation = await fixture.db
        .selectFrom('host_observations')
        .select('observed_at')
        .where('host_id', '=', fixture.hostId)
        .executeTakeFirstOrThrow();
      expect(Date.now() - observation.observed_at.getTime()).toBeLessThan(15000);
      const created = await response.json();
      expect(
        await fixture.db
          .selectFrom('managed_servers')
          .select('id')
          .where('id', '=', created.serverId)
          .executeTakeFirst(),
      ).toBeDefined();
    },
  );
  it('still refuses creation when the observer cannot supply a valid sample', async () => {
    const choiceId = await eligibleChoice(false);
    await fixture.db
      .deleteFrom('host_observations')
      .where('host_id', '=', fixture.hostId)
      .execute();
    const service = await management();
    management.mockResolvedValue({ ...service, refreshObservations: async () => {} });
    const response = await post('/v1/minecraft/servers', createInput(choiceId));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'resources_unavailable' });
    expect(
      await fixture.db
        .selectFrom('managed_servers')
        .select('id')
        .where('owner_id', '=', actor.subjectUserId)
        .execute(),
    ).toEqual([]);
  });
  it('creates Vanilla without an evidence key/report and exposes accurate Owner feature diagnostics', async () => {
    const choiceId = await eligibleChoice(false);
    const response = await post('/v1/minecraft/servers', createInput(choiceId));
    expect(response.status).toBe(202);
    const result = await response.json();
    const server = await fixture.db
      .selectFrom('managed_servers')
      .select('connection_mode')
      .where('id', '=', result.serverId)
      .executeTakeFirstOrThrow();
    expect(server.connection_mode).toBe('direct');
    actor = fixture.owner;
    const diagnostics = await (await app.request('/v1/owner/minecraft/compatibility')).json();
    expect(diagnostics.find((row: { id: string }) => row.id === choiceId)).toMatchObject({
      supportAuthority: 'integration',
      support: 'unverified',
      evidence: [],
      capabilities: {
        installation: true,
        directConnection: true,
        gateway: false,
        sleepWake: false,
      },
    });
  });
  it('refuses direct creation without an Owner-configured connection endpoint and queues no effects', async () => {
    const choiceId = await eligibleChoice(false);
    const node = await fixture.db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', fixture.nodeId)
      .executeTakeFirstOrThrow();
    if (!node.backend_allocation_pool) throw new Error('Missing fixture allocation pool');
    await fixture.db
      .updateTable('managed_nodes')
      .set({
        backend_allocation_pool: JSON.stringify({
          ...node.backend_allocation_pool,
          allocations: node.backend_allocation_pool.allocations.map(
            ({ directEndpoint: _endpoint, ...pin }) => pin,
          ),
        }),
      })
      .where('id', '=', node.id)
      .execute();
    const response = await post('/v1/minecraft/servers', createInput(choiceId));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'allocation_unavailable' });
    expect(
      await fixture.db
        .selectFrom('managed_servers')
        .select('id')
        .where('owner_id', '=', actor.subjectUserId)
        .execute(),
    ).toEqual([]);
    expect(
      await fixture.db
        .selectFrom('operation_jobs')
        .select('id')
        .where('actor_id', '=', actor.subjectUserId)
        .execute(),
    ).toEqual([]);
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
  it.each(['disabled', 'unallowlisted', 'unknown'] as const)(
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
