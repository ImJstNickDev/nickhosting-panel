import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { satisfactoryManifest } from '../../../games/satisfactory/src/manifest.js';
import { authorizeServer } from '../../../packages/server-management/src/registry.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import type { Variables } from './app.js';
import { registerSatisfactoryModRoutes } from './satisfactory-mods.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let actor: typeof f.context;
let serverId: string;
let app: Hono<{ Variables: Variables }>;
const version = Buffer.from(JSON.stringify({ Changelist: 513885 }));
const listFiles = vi.fn(async (_id: string, path: string) =>
  path === 'Engine/Binaries/Linux'
    ? [
        {
          name: 'FactoryServer-Linux-Shipping.version',
          size: version.length,
          is_file: true,
          is_symlink: false,
        },
      ]
    : [],
);
const defaultListing = listFiles.getMockImplementation();
const readFile = vi.fn(async () => version);
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  vi.clearAllMocks();
  readFile.mockImplementation(async () => version);
  if (defaultListing) listFiles.mockImplementation(defaultListing);
  f = await managementFixture(database.db, { interactive: true });
  actor = f.context;
  serverId = await f.server();
  await f.db
    .insertInto('game_integrations')
    .values({
      id: 'satisfactory',
      version: satisfactoryManifest.version,
      manifest: satisfactoryManifest,
    })
    .onConflict((c) => c.column('id').doNothing())
    .execute();
  await f.db
    .updateTable('runtime_egg_mappings')
    .set({ game_id: 'satisfactory', runtime_id: 'dedicated' })
    .where('id', '=', f.mappingId)
    .execute();
  const service = {
    adapter: { listFiles, readFile },
    access: async (
      current: typeof actor,
      id: string,
      _write: boolean,
      work: Parameters<ManagementRuntime['access']>[3],
    ) => {
      const server = await authorizeServer(f.db, current, id, 'files.read');
      return work(server.pterodactyl_identifier!, f.db, current, server);
    },
    authorizeTransfer: async (current: typeof actor, id: string) => {
      await authorizeServer(f.db, current, id, 'files.read');
    },
    externalOptions: { verifyServer: async () => {} },
  } as unknown as ManagementRuntime;
  app = new Hono<{ Variables: Variables }>();
  app.onError((error, c) =>
    error instanceof DomainError
      ? c.json({ code: error.code }, error.status as 400)
      : c.json({ code: 'unexpected' }, 500),
  );
  registerSatisfactoryModRoutes(app, {
    db: f.db,
    principal: async () => actor,
    env: {},
    management: async () => service,
  });
});
const request = (path: string, body?: unknown, method = 'POST') =>
  app.request(
    `/v1/servers/${serverId}/satisfactory/mods${path}`,
    body === undefined
      ? {}
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
it('loads public versions and the actual build concurrently and filters compatibility with that build', async () => {
  const release = Promise.withResolvers<void>();
  readFile.mockImplementation(async () => {
    await release.promise;
    return version;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      await release.promise;
      return Response.json({
        data: {
          mod: {
            versions: ['>=513885', '>=999999'].map((game_version, index) => ({
              version: `${index + 1}.0.0`,
              game_version,
              required_on_remote: false,
              changelog: '',
              dependencies: [],
              targets: [{ targetName: 'LinuxServer' }],
            })),
          },
        },
      });
    }),
  );
  const pending = request('/versions/Example');
  try {
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  } finally {
    release.resolve();
  }
  const response = await pending;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject([
    { version: '2.0.0', compatibility: 'incompatible' },
    { version: '1.0.0', compatibility: 'compatible' },
  ]);
  expect(listFiles).toHaveBeenCalledTimes(1);
});
it('preserves authorization failures from parallel version build reads', async () => {
  readFile.mockRejectedValueOnce(new DomainError('forbidden'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: { mod: null } })),
  );
  const response = await request('/versions/Example');
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: 'forbidden' });
});
const profile = (revision = 0) => ({
  name: 'Shared',
  selection: [{ reference: 'Example', version: '^1.0.0', enabled: false }],
  vanilla: false,
  requiredTargets: ['LinuxServer', 'Windows'],
  revision,
});

it('persists profiles with disabled roots and round-trips native SMM intent without external lock URLs', async () => {
  const saved = await request('/profiles', profile());
  expect(saved.status).toBe(200);
  const result = (await saved.json()) as { id: string };
  const exported = await request(`/profiles/${result.id}/export`);
  expect(exported.status).toBe(200);
  const document = await exported.json();
  expect(document).toMatchObject({
    profile: {
      name: 'Shared',
      mods: { Example: { version: '^1.0.0', enabled: false } },
      required_targets: ['LinuxServer', 'Windows'],
    },
    metadata: { gameVersion: 513885 },
    lockfile: { version: 1, mods: {} },
  });
  document.profile.name = 'Imported';
  document.lockfile = {
    version: 1,
    mods: {
      Example: {
        version: '1.0.0',
        dependencies: {},
        targets: { LinuxServer: { hash: 'a', link: 'http://127.0.0.1/private' } },
      },
    },
  };
  expect((await request('/profiles/import', { revision: 1, document })).status).toBe(200);
  const snapshot = await (await request('')).json();
  expect(snapshot.profiles).toHaveLength(2);
  expect(JSON.stringify(snapshot)).not.toContain('127.0.0.1');
  expect(snapshot.revision).toBe(2);
  expect((await request('/profiles', profile())).status).toBe(409);
});

it('creates an atomic preview job and rejects same-key payload changes', async () => {
  const body = {
    selection: [{ reference: 'Example', version: '1.0.0', enabled: false }],
    vanilla: false,
    revision: 0,
    idempotencyKey: randomUUID(),
  };
  const response = await request('/preview', body);
  expect(response.status).toBe(202);
  const first = await response.json();
  expect(await (await request('/preview', body)).json()).toEqual(first);
  expect(
    (
      await request('/preview', {
        ...body,
        selection: [{ reference: 'Example', version: '1.0.0' }],
      })
    ).status,
  ).toBe(409);
  expect((await request('/profiles', profile())).status).toBe(409);
  const plan = await f.db
    .selectFrom('satisfactory_mod_plans')
    .selectAll()
    .where('id', '=', first.planId)
    .executeTakeFirstOrThrow();
  expect(plan.job_id).toBe(first.jobId);
  expect(plan.selection).toEqual(body.selection);
  // Retention may reclaim the plan after the job finishes; its request key still
  // cannot be reused to enqueue different work or fail as a database uniqueness error.
  await f.db
    .updateTable('managed_servers')
    .set({ active_operation_id: null })
    .where('id', '=', serverId)
    .execute();
  await f.db.deleteFrom('satisfactory_mod_plans').where('id', '=', first.planId).execute();
  expect((await request('/preview', body)).status).toBe(409);
});

it('failed preview admission leaves no orphan plan and arbitrary apply bypass is rejected', async () => {
  await f.db
    .updateTable('managed_servers')
    .set({ runtime_state: 'running' })
    .where('id', '=', serverId)
    .execute();
  expect(
    (
      await request('/preview', {
        selection: [],
        vanilla: false,
        revision: 0,
        idempotencyKey: randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(
    await f.db
      .selectFrom('satisfactory_mod_plans')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute(),
  ).toEqual([]);
  expect((await request('/apply', { selection: [], idempotencyKey: randomUUID() })).status).toBe(
    400,
  );
});

it('permits SMM profile import during external mode while content jobs remain blocked', async () => {
  expect(
    (await request('/external/begin', { revision: 0, idempotencyKey: randomUUID() })).status,
  ).toBe(200);
  await f.db
    .updateTable('managed_servers')
    .set({ active_operation_id: null })
    .where('id', '=', serverId)
    .execute();
  const document = {
    profile: {
      name: 'SMM',
      mods: { Paused: { version: '1.0.0', enabled: false } },
      required_targets: ['Windows'],
    },
    lockfile: { version: 1, mods: {} },
    metadata: { gameVersion: 513885 },
  };
  expect((await request('/profiles/import', { document, revision: 1 })).status).toBe(200);
  expect(
    (await request('/preview', { selection: [], revision: 2, idempotencyKey: randomUUID() }))
      .status,
  ).toBe(409);
  const state = await (await request('')).json();
  expect(state.externalMode).toBe(true);
  expect(state.profiles[0].requiredTargets).toContain('LinuxServer');
});

it('denies other users before reading server files or modifying profiles', async () => {
  actor = (await managementFixture(f.db, { interactive: true })).context;
  expect((await request('/inventory')).status).toBe(403);
  expect((await request('/profiles', profile())).status).toBe(403);
  expect(listFiles).not.toHaveBeenCalled();
});

it('replays apply and rollback after their durable state has advanced without creating another job', async () => {
  const preview = await (
    await request('/preview', { selection: [], revision: 0, idempotencyKey: randomUUID() })
  ).json();
  const complete = async (jobId: string) => {
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', serverId)
      .execute();
    await f.db
      .updateTable('operation_jobs')
      .set({ state: 'succeeded', completed_at: new Date() })
      .where('id', '=', jobId)
      .execute();
    await f.db
      .updateTable('server_operations')
      .set({ phase: 'complete', effect_state: 'confirmed' })
      .where('job_id', '=', jobId)
      .execute();
  };
  await complete(preview.jobId);
  await f.db
    .updateTable('satisfactory_mod_plans')
    .set({ status: 'ready', lock: JSON.stringify({ version: 1, mods: {} }), files: '[]' })
    .where('id', '=', preview.planId)
    .execute();
  const body = { planId: preview.planId, revision: 0, idempotencyKey: randomUUID() };
  const accepted = await request('/apply', body);
  expect(accepted.status).toBe(202);
  const first = await accepted.json();
  await complete(first.jobId);
  await f.db
    .updateTable('satisfactory_mod_plans')
    .set({ status: 'applied' })
    .where('id', '=', preview.planId)
    .execute();
  await f.db
    .updateTable('satisfactory_mod_states')
    .set({ revision: 1, recovery: JSON.stringify({ jobId: first.jobId }) })
    .where('server_id', '=', serverId)
    .execute();
  expect(await (await request('/apply', body)).json()).toEqual(first);
  expect((await request('/apply', { ...body, revision: 1 })).status).toBe(409);
  const restore = { revision: 1, idempotencyKey: randomUUID() };
  const rollback = await request('/rollback', restore);
  expect(rollback.status).toBe(202);
  const restored = await rollback.json();
  await complete(restored.jobId);
  await f.db
    .updateTable('satisfactory_mod_states')
    .set({ revision: 2, recovery: null })
    .where('server_id', '=', serverId)
    .execute();
  expect(await (await request('/rollback', restore)).json()).toEqual(restored);
});

it('does not report no updates when the installed game build is unavailable', async () => {
  listFiles.mockResolvedValue([]);
  expect((await request('/updates')).status).toBe(400);
});

it('reports active background previews and exposes ready only after the operation releases the server', async () => {
  const response = await request('/preview', {
    selection: [],
    revision: 0,
    idempotencyKey: randomUUID(),
  });
  const { jobId, planId } = await response.json();
  expect((await (await request('')).json()).activePreviewJobId).toBe(jobId);
  expect(await (await request(`/plans/${planId}`)).json()).toMatchObject({
    status: 'pending',
    phase: 'queued',
  });
  const operation = await f.db
    .selectFrom('server_operations')
    .select('plan')
    .where('job_id', '=', jobId)
    .executeTakeFirstOrThrow();
  await f.db
    .updateTable('server_operations')
    .set({ plan: JSON.stringify({ ...operation.plan, satisfactoryPreviewPhase: 'inventory' }) })
    .where('job_id', '=', jobId)
    .execute();
  await f.db
    .updateTable('satisfactory_mod_plans')
    .set({ status: 'ready' })
    .where('id', '=', planId)
    .execute();
  expect(await (await request(`/plans/${planId}`)).json()).toMatchObject({
    status: 'pending',
    phase: 'inventory',
  });
  await f.db
    .updateTable('operation_jobs')
    .set({ state: 'failed', error_code: 'conflict', completed_at: new Date() })
    .where('id', '=', jobId)
    .execute();
  expect(await (await request(`/plans/${planId}`)).json()).toMatchObject({
    status: 'failed',
    phase: 'failed',
  });
  await f.db
    .updateTable('operation_jobs')
    .set({ state: 'succeeded' })
    .where('id', '=', jobId)
    .execute();
  expect(await (await request(`/plans/${planId}`)).json()).toMatchObject({
    status: 'ready',
    phase: 'ready',
  });
  expect((await (await request('')).json()).activePreviewJobId).toBeNull();
});
