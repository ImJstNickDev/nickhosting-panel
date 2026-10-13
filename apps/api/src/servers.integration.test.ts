import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getRequestListener } from '@hono/node-server';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { authSessionId, createLogger, DomainError, SecretCodec } from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import { localizeError } from '@nickhosting/i18n';
import { minecraftManifest } from '@nickhosting/minecraft';
import {
  type ConsoleRelayOptions,
  createPterodactylAdapter,
  type PterodactylAdapter,
  PterodactylError,
  type ServerFile,
} from '@nickhosting/pterodactyl-adapter';
import {
  createManagementRuntime,
  lockResources,
  reconcileManagedServer,
} from '@nickhosting/server-management';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../../../packages/auth/src/test-fixtures.js';
import { createDownloadProxy } from '../../../packages/pterodactyl-adapter/src/downloads.js';
import { createUploadProxy } from '../../../packages/pterodactyl-adapter/src/uploads.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createApp } from './app.js';

describe('M2 Hono API with real invitation, password and session authentication', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  let app: ReturnType<typeof createApp>;
  let identity: ReturnType<typeof createIdentity>;
  let runtime: Awaited<ReturnType<typeof createManagementRuntime>>;
  let owner: AuthClient, user: AuthClient, peer: AuthClient, outsider: AuthClient;
  let userId: string, peerId: string, outsiderId: string;
  const env: Record<string, string | undefined> = {};
  const origin = 'http://localhost:3999';
  const password = 'Isolated-API-password-593!';
  const mails: IdentityMail[] = [],
    logs: unknown[] = [];
  const timingRecords: Array<{
    level: string;
    event: string;
    data: Readonly<Record<string, unknown>>;
  }> = [];
  const diagnosticOptions: { level: 'debug' | 'info' } = { level: 'debug' };
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  const providerSecret = randomBytes(32).toString('base64url');
  const instanceId = randomUUID();
  const backupId = randomUUID();
  const writeFile = vi.fn(async () => {}),
    sendCommand = vi.fn(async () => {}),
    deleteBackup = vi.fn(async () => {});
  const uploadFile = vi
    .fn<PterodactylAdapter['uploadFile']>()
    .mockImplementation(async (_id, path, input) => {
      const proxy = createUploadProxy({
        baseURL: 'https://panel.example.test',
        applicationKey: 'isolated-key',
        uploadOrigins: ['https://wings.example.test'],
        fetcher: async (_url, init) => {
          await new Response(init?.body).arrayBuffer();
          return new Response(null, { status: 204 });
        },
      });
      await proxy('https://wings.example.test/upload/file?token=isolated-private-token', path, {
        ...input,
        authorizationIntervalMs: 10,
      });
    });
  async function upload(
    client: AuthClient | null,
    server: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
    length: number,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
    query: {
      path?: string;
      overwrite?: string | string[];
      batchId?: string;
      entryId?: string;
    } = {},
  ) {
    const requestHeaders = client?.headers() ?? new Headers({ origin });
    requestHeaders.set('content-type', 'application/octet-stream');
    requestHeaders.set('x-nh-upload-length', String(length));
    for (const [key, value] of Object.entries(headers)) requestHeaders.set(key, value);
    const init: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      headers: requestHeaders,
      body: data as BodyInit,
      duplex: 'half',
      signal,
    };
    const parameters = new URLSearchParams({ path: query.path ?? 'world.bin' });
    const overwrite = typeof query.overwrite === 'string' ? [query.overwrite] : query.overwrite;
    for (const value of overwrite ?? []) parameters.append('overwrite', value);
    if (query.batchId) parameters.set('batchId', query.batchId);
    if (query.entryId) parameters.set('entryId', query.entryId);
    return app.request(`${origin}/v1/servers/${server}/files/upload?${parameters}`, init);
  }
  function fileEntry(name: string, patch: Partial<ServerFile> = {}): ServerFile {
    return {
      name,
      mode: '-rw-r--r--',
      size: 1,
      is_file: true,
      is_symlink: false,
      mimetype: 'application/octet-stream',
      created_at: '2026-01-01T00:00:00Z',
      modified_at: '2026-01-01T00:00:00Z',
      ...patch,
    };
  }
  const relayClose = vi.fn();
  const requestConsoleLogs = vi.fn(async () => {});
  let consoleAuthorization: ConsoleRelayOptions['authorize'] | undefined;
  async function request(
    client: AuthClient | null,
    path: string,
    data?: unknown,
    options: { method?: string; headers?: Record<string, string> } = {},
  ) {
    const headers = client?.headers(options.headers) ?? new Headers({ origin, ...options.headers });
    if (data !== undefined) headers.set('content-type', 'application/json');
    const response = await app.request(
      `${origin}${path}`,
      {
        method: options.method ?? (data === undefined ? 'GET' : 'POST'),
        headers,
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      },
      {
        // Model independent trusted TCP peers, rather than spoofing proxy headers or
        // disabling the production auth rate limiter for this in-process client.
        incoming: {
          socket: {
            remoteAddress: client?.headers().get('x-nh-client-ip') ?? '192.0.2.254',
            remotePort: 50000,
            remoteFamily: 'IPv4',
          },
        },
      },
    );
    client?.absorb(response);
    return response;
  }
  async function recoverFixtureUploads() {
    const response = await request(owner, '/v1/owner/uploads');
    expect(response.status).toBe(200);
    const claims: { id: string; scope_hash: string }[] = await response.json();
    for (const claim of claims)
      expect(
        (
          await request(owner, `/v1/owner/uploads/${claim.id}/recover`, {
            confirm: true,
            remoteTransferFinished: true,
            temporaryFilesRemoved: true,
            scopeHash: claim.scope_hash,
            reason: 'Isolated provider fixture completed',
            evidence:
              'Mock provider has finished; no real staging files or remote writes exist in this test.',
          })
        ).status,
      ).toBe(204);
  }
  async function verify(client: AuthClient, email: string) {
    const message = mails.findLast((mail) => mail.to === email && mail.template === 'verify-email');
    if (!message) throw new Error('Missing verification fixture');
    const url = new URL(message.url);
    expect((await request(client, `${url.pathname}${url.search}`)).status).toBe(302);
    const signed = await request(client, '/api/auth/sign-in/email', { email, password });
    expect(signed.status).toBe(200);
    return (await signed.json()).user.id as string;
  }
  async function invited(client: AuthClient, email: string) {
    const invitation = await request(owner, '/v1/owner/invitations', { email });
    expect(invitation.status).toBe(201);
    const token = (await invitation.json()).token;
    expect(
      (
        await request(
          client,
          '/api/auth/sign-up/email',
          { name: 'Isolated user', email, password },
          { headers: { 'x-invitation-token': token } },
        )
      ).status,
    ).toBe(200);
    return verify(client, email);
  }
  beforeAll(async () => {
    database = await createTestDatabase();
    f = await managementFixture(database.db);
    // Replace only the disposable fixture Owner with the real first-run/auth pipeline.
    await f.db.deleteFrom('provider_accounts').where('user_id', '=', f.owner.actorUserId).execute();
    await f.db.deleteFrom('user').where('id', '=', f.owner.actorUserId).execute();
    const bootstrapToken = randomBytes(32).toString('base64url');
    identity = createIdentity({
      secretCodec: codec,
      pool: database.pool,
      baseURL: origin,
      authSecret: randomBytes(32).toString('base64url'),
      bootstrapToken,
      mail: async (message) => {
        mails.push(message);
      },
      completeSetup: async () => {},
    });
    owner = new AuthClient(identity);
    user = new AuthClient(identity);
    peer = new AuthClient(identity);
    outsider = new AuthClient(identity);
    Object.assign(f.adapter, {
      getApplicationServer: vi
        .fn<typeof f.adapter.getApplicationServer>()
        .mockImplementation(async (id) => {
          const server = await f.db
            .selectFrom('managed_servers')
            .selectAll()
            .where('pterodactyl_id', '=', id)
            .executeTakeFirstOrThrow();
          const allocations = await f.db
            .selectFrom('server_allocations')
            .selectAll()
            .where('server_id', '=', server.id)
            .execute();
          const primary = allocations.find((allocation) => allocation.is_primary);
          if (!primary || !server.pterodactyl_uuid || !server.pterodactyl_identifier)
            throw new Error('Incomplete fixture identity');
          return {
            id,
            external_id: server.external_id,
            uuid: server.pterodactyl_uuid,
            identifier: server.pterodactyl_identifier,
            name: server.name,
            description: null,
            suspended: false,
            limits: server.limits,
            feature_limits: { databases: 0, allocations: 3, backups: 1 },
            user: 1,
            node: f.providerNodeId,
            allocation: primary.pterodactyl_allocation_id,
            nest: 1,
            egg: 1,
            status: null,
            container: { startup_command: 'fixture', image: 'fixture/image:1', installed: true },
            relationships: {
              allocations: {
                object: 'list' as const,
                data: allocations.map((allocation) => ({
                  attributes: {
                    id: allocation.pterodactyl_allocation_id,
                    ip: allocation.address,
                    port: allocation.port,
                    assigned: true,
                  },
                })),
              },
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        }),
      getDirectoryBatchSettings: vi.fn(async () => {
        throw new PterodactylError('not_found', 'client', 'rejected', 404);
      }),
      listFiles: vi.fn(async () => [
        {
          name: 'server.properties',
          mode: '-rw-------',
          size: 9,
          is_file: true,
          is_symlink: false,
          mimetype: 'text/plain',
          created_at: new Date().toISOString(),
          modified_at: new Date().toISOString(),
        },
      ]),
      readFile: vi.fn(async () => Buffer.from('fixture-data')),
      readFileForEditor: vi.fn(async () => Buffer.from('fixture-data')),
      downloadFile: vi.fn(async (_id, _path, input) =>
        createDownloadProxy({
          baseURL: 'https://panel.example.test',
          applicationKey: 'isolated-key',
          fetcher: async () => new Response('fixture-data'),
        })('https://panel.example.test/file?token=private-fixture', input),
      ),
      uploadFile,
      prepareUpload: vi.fn<PterodactylAdapter['prepareUpload']>(
        async (id, path) => (input) => uploadFile(id, path, input),
      ),
      prepareUploadBatch: vi.fn<PterodactylAdapter['prepareUploadBatch']>(async () => null),
      getResources: vi.fn(async () => ({
        current_state: 'offline',
        is_suspended: false,
        resources: {
          memory_bytes: 0,
          cpu_absolute: 0,
          disk_bytes: 0,
          network_rx_bytes: 0,
          network_tx_bytes: 0,
        },
      })),
      writeFile,
      sendCommand,
      deleteBackup,
      listBackups: vi.fn(async () => [
        {
          uuid: backupId,
          name: 'fixture',
          is_successful: true,
          is_locked: false,
          bytes: 12,
          checksum: 'fixture',
          ignored_files: [],
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        },
      ]),
      downloadBackup: vi.fn(async () => ({
        body: new Response('fixture-backup').body,
        contentType: 'application/octet-stream',
      })),
      relayConsole: vi.fn(async (_id: string, input: ConsoleRelayOptions) => {
        consoleAuthorization = input.authorize;
        if (!(await input.authorize())) throw new Error('Unexpected unauthorized relay');
        input.onEvent({ type: 'console', data: 'Isolated console output' });
        input.onEvent({ type: 'closed' });
        return {
          close: relayClose,
          sendCommand: async () => {},
          requestLogs: requestConsoleLogs,
          requestStats: async () => {},
        };
      }),
      listNodes: vi.fn(async () => []),
      listNests: vi.fn(async () => []),
      discoverCapabilities: vi.fn(async () => ({ application: true, client: true })),
    });
    await f.db
      .updateTable('physical_hosts')
      .set({
        local_disk_path: resolve('mountdata/m2-tests'),
        upload_policy: JSON.stringify({
          providerMaxFileBytes: 64 * 1024 ** 2,
          temporaryDiskPath: resolve('mountdata/m2-tests'),
          temporaryDiskBudgetBytes: 128 * 1024 ** 2,
          temporaryDiskHeadroomBytes: 1024 ** 2,
        }),
      })
      .where('id', '=', f.hostId)
      .execute();
    Object.assign(env, {
      NH_OBSERVER_ID: 'isolated-observer',
      NH_STATIC_GAME_HOSTNAME: 'games.example.test',
      NH_SFTPGO_BASE_URL: 'https://sftp.example.test',
      NH_SFTPGO_DATA_ROOT: '/isolated-api-fixture',
      NH_SFTPGO_INSTANCE_ID: instanceId,
      NH_SFTPGO_API_KEY: providerSecret,
    });
    runtime = await createManagementRuntime({ db: f.db, codec, adapter: f.adapter, env });
    runtime.externalOptions.sftpFactory = () => ({
      ensureCredential: async (input) => ({
        instanceId,
        serverId: input.serverId,
        externalServerUuid: input.externalServerUuid,
        credentialId: input.credentialId,
        username: `nh_${input.credentialId.replaceAll('-', '')}`,
        externalUserId: 1,
        expiresAt: input.expiresAt,
        quotaBytes: input.quotaBytes,
      }),
      inspectCredential: async () => null,
      rotateCredential: async (ref, input) => ({ ...ref, expiresAt: input.expiresAt }),
      updateQuota: async (ref, quotaBytes) => ({ ...ref, quotaBytes }),
      revokeCredential: async () => {},
    });
    app = createApp({
      logger: createLogger(
        (entry) =>
          timingRecords.push({
            level: entry.level,
            event: entry.event,
            data: entry.data as Readonly<Record<string, unknown>>,
          }),
        diagnosticOptions,
      ),
      database,
      identity: async () => identity,
      codec,
      origins: [origin],
      env,
      management: async () => runtime,
      log: (entry) => logs.push(entry),
    });
    const claimed = await request(owner, '/v1/setup/owner', {
      token: bootstrapToken,
      name: 'Owner',
      email: 'servers-owner@example.test',
      password,
    });
    expect(claimed.status, await claimed.text()).toBe(201);
    await verify(owner, 'servers-owner@example.test');
    userId = await invited(user, 'servers-user@example.test');
    peerId = await invited(peer, 'servers-peer@example.test');
    outsiderId = await invited(outsider, 'servers-outsider@example.test');
    // Move only the synthetic provider fixture binding to the real invited test identity.
    await f.db.deleteFrom('provider_accounts').where('user_id', '=', userId).execute();
    await f.db
      .updateTable('provider_accounts')
      .set({ user_id: userId })
      .where('user_id', '=', f.context.subjectUserId)
      .execute();
    f.context.actorUserId = userId;
    f.context.subjectUserId = userId;
  });
  beforeEach(async () => {
    await f.observe();
  });
  afterAll(async () => {
    await database?.destroy();
  });

  it('requires authentication and regular Owner authority on infrastructure endpoints', async () => {
    for (const path of [
      '/v1/servers',
      '/v1/projects',
      '/v1/owner/infrastructure',
      '/v1/owner/runtime-mappings',
    ])
      expect((await request(null, path)).status).toBe(401);
    for (const path of [
      '/v1/owner/infrastructure',
      '/v1/owner/resource-hosts',
      '/v1/owner/nodes',
      '/v1/owner/runtime-mappings',
    ]) {
      expect((await request(user, path)).status).toBe(403);
      expect((await request(owner, path)).status).toBe(200);
    }
    expect((await request(user, '/v1/owner/nodes', {}, { method: 'PUT' })).status).toBe(403);
  });
  it('saves a 2000-allocation Owner pool with bounded JSON, authentication and Origin checks', async () => {
    const previous = await f.db
      .selectFrom('managed_nodes')
      .selectAll()
      .where('id', '=', f.nodeId)
      .executeTakeFirstOrThrow();
    const inventory = Array.from({ length: 2000 }, (_, index) => ({
      id: 50000 + index,
      ip: '10.20.0.1',
      port: 30000 + index,
      assigned: false,
    }));
    const originalList = f.adapter.listAllocations;
    const list = vi.fn(async () => inventory);
    f.adapter.listAllocations = list;
    const payload = {
      id: f.nodeId,
      physicalHostId: f.hostId,
      pterodactylNodeId: f.providerNodeId,
      provisionUserId: 1,
      backendAllocationPool: {
        allocations: inventory.map((a) => ({ allocationId: a.id, address: a.ip, port: a.port })),
        gatewayBindAddresses: ['192.0.2.10'],
      },
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(65536);
    try {
      expect((await request(null, '/v1/owner/nodes', payload, { method: 'PUT' })).status).toBe(401);
      expect((await request(user, '/v1/owner/nodes', payload, { method: 'PUT' })).status).toBe(403);
      expect(
        (
          await request(owner, '/v1/owner/nodes', payload, {
            method: 'PUT',
            headers: { origin: 'https://attacker.example.test' },
          })
        ).status,
      ).toBe(403);
      expect(list).not.toHaveBeenCalled();
      expect(
        (
          await request(
            owner,
            '/v1/owner/nodes',
            { value: 'x'.repeat(4 * 1024 * 1024) },
            { method: 'PUT' },
          )
        ).status,
      ).toBe(413);
      expect(
        (await request(owner, '/v1/owner/resource-hosts', payload, { method: 'PUT' })).status,
      ).toBe(413);
      const result = await request(owner, '/v1/owner/nodes', payload, { method: 'PUT' });
      expect(result.status).toBe(200);
      expect(
        (
          await f.db
            .selectFrom('managed_nodes')
            .select('backend_allocation_pool')
            .where('id', '=', f.nodeId)
            .executeTakeFirstOrThrow()
        ).backend_allocation_pool,
      ).toEqual(payload.backendAllocationPool);
      expect(list).toHaveBeenCalled();
    } finally {
      f.adapter.listAllocations = originalList;
      await f.db
        .updateTable('managed_nodes')
        .set({
          backend_allocation_pool: JSON.stringify(previous.backend_allocation_pool),
          installer_memory_mib: previous.installer_memory_mib,
          installer_cpu_percent: previous.installer_cpu_percent,
        })
        .where('id', '=', f.nodeId)
        .execute();
    }
  });
  it('exposes and enforces the environment-locked physical memory bound over HTTP', async () => {
    env.NH_NODE_MEMORY_OVERHEAD_PERCENT = '200';
    try {
      const response = await request(owner, '/v1/owner/nodes');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        expect.objectContaining({
          id: f.nodeId,
          memory_overhead_percent: 115,
          effectiveMemoryOverheadPercent: 200,
          memoryOverheadLocked: true,
        }),
      ]);
      expect(
        (
          await request(
            owner,
            '/v1/owner/nodes',
            {
              id: f.nodeId,
              physicalHostId: f.hostId,
              pterodactylNodeId: f.providerNodeId,
              provisionUserId: 1,
              memoryOverheadPercent: 150,
            },
            { method: 'PUT' },
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await f.db
            .selectFrom('managed_nodes')
            .select('memory_overhead_percent')
            .where('id', '=', f.nodeId)
            .executeTakeFirstOrThrow()
        ).memory_overhead_percent,
      ).toBe(115);
    } finally {
      delete env.NH_NODE_MEMORY_OVERHEAD_PERCENT;
    }
  });
  it('exposes the effective backend pool and refuses disabled-pool creation or locked Owner edits', async () => {
    const stored = (
      await f.db
        .selectFrom('managed_nodes')
        .selectAll()
        .where('id', '=', f.nodeId)
        .executeTakeFirstOrThrow()
    ).backend_allocation_pool;
    expect(stored?.allocations.length).toBeGreaterThan(0);
    env.NH_BACKEND_ALLOCATION_POOLS = JSON.stringify({ [f.nodeId]: null });
    try {
      const response = await request(owner, '/v1/owner/nodes');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        expect.objectContaining({
          id: f.nodeId,
          backend_allocation_pool: stored,
          effectiveBackendAllocationPool: null,
          backendAllocationPoolLocked: true,
        }),
      ]);
      const before = await f.db.selectFrom('managed_servers').select('id').orderBy('id').execute();
      const create = await request(user, '/v1/servers', f.input());
      expect(create.status).toBe(409);
      expect((await create.json()).error.code).toBe('allocation_unavailable');
      expect(await f.db.selectFrom('managed_servers').select('id').orderBy('id').execute()).toEqual(
        before,
      );
      expect(
        (
          await request(
            owner,
            '/v1/owner/nodes',
            {
              id: f.nodeId,
              physicalHostId: f.hostId,
              pterodactylNodeId: f.providerNodeId,
              provisionUserId: 1,
              backendAllocationPool: null,
            },
            { method: 'PUT' },
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await f.db
            .selectFrom('managed_nodes')
            .selectAll()
            .where('id', '=', f.nodeId)
            .executeTakeFirstOrThrow()
        ).backend_allocation_pool,
      ).toEqual(stored);
    } finally {
      delete env.NH_BACKEND_ALLOCATION_POOLS;
    }
    expect(await (await request(owner, '/v1/owner/nodes')).json()).toEqual([
      expect.objectContaining({
        effectiveBackendAllocationPool: stored,
        backendAllocationPoolLocked: false,
      }),
    ]);
  });
  it('skips host sampling for stop and kill and scopes start sampling to its target', async () => {
    timingRecords.length = 0;
    const sample = vi.spyOn(runtime, 'refreshObservations').mockResolvedValue(undefined);
    try {
      const stopped = await f.server();
      expect(
        (
          await request(user, `/v1/servers/${stopped}/operations`, {
            action: 'stop',
            idempotencyKey: randomUUID(),
          })
        ).status,
      ).toBe(202);
      expect(sample).not.toHaveBeenCalled();
      await request(user, `/v1/servers/${stopped}/operations`, {
        action: 'kill',
        confirm: true,
        operationId: randomUUID(),
        idempotencyKey: randomUUID(),
      });
      expect(sample).not.toHaveBeenCalled();
      const starting = await f.server();
      await request(user, `/v1/servers/${starting}/operations`, {
        action: 'start',
        idempotencyKey: randomUUID(),
      });
      expect(sample).toHaveBeenCalledOnce();
      expect(sample.mock.calls[0]?.[1]).toBe(starting);
      const timings = timingRecords.filter((entry) => entry.event === 'servers.operation_request');
      expect(timings).toHaveLength(3);
      expect(timings[0]?.data).toMatchObject({
        action: 'stop',
        outcome: 'accepted',
        jobId: expect.any(String),
        principalMs: expect.any(Number),
        accessCheckMs: expect.any(Number),
        enqueueMs: expect.any(Number),
        durationMs: expect.any(Number),
      });
      expect(timings[0]?.data).not.toHaveProperty('hostSamplingMs');
      expect(timings[2]?.data).toHaveProperty('hostSamplingMs', expect.any(Number));
      for (const entry of timings)
        expect(
          Object.keys(entry.data).every((key) =>
            [
              'action',
              'jobId',
              'outcome',
              'principalMs',
              'accessCheckMs',
              'enqueueMs',
              'hostSamplingMs',
              'durationMs',
            ].includes(key),
          ),
        ).toBe(true);
    } finally {
      sample.mockRestore();
    }
  });

  it('creates durable operations over HTTP, validates confirmation and origin, and exposes safe history', async () => {
    const input = f.input();
    const before = await f.db.selectFrom('managed_servers').select('id').orderBy('id').execute();
    const rejected = await request(user, '/v1/servers', input, {
      headers: { origin: 'https://attacker.example.test' },
    });
    expect(rejected.status).toBe(403);
    expect(await f.db.selectFrom('managed_servers').select('id').orderBy('id').execute()).toEqual(
      before,
    );
    const created = await request(user, '/v1/servers', input);
    expect(created.status).toBe(202);
    const result = await created.json();
    expect(await (await request(user, '/v1/servers', input)).json()).toEqual(result);
    const job = await f.db
      .selectFrom('operation_jobs')
      .selectAll()
      .where('id', '=', result.jobId)
      .executeTakeFirstOrThrow();
    expect(job.actor_id).toBe(userId);
    expect(job.state).toBe('queued');
    const history = await request(user, `/v1/servers/${result.serverId}/operations`);
    const content = await history.text();
    expect(history.status).toBe(200);
    expect(content).toContain('jobs.queued');
    expect(content).not.toContain('policy_snapshot');
    expect(content).not.toContain('command_hash');
    expect(
      (
        await request(user, `/v1/servers/${result.serverId}/operations`, {
          action: 'delete',
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(400);
  });
  it('reuses directory identity across paths over HTTP without caching listings or authorizing outsiders', async () => {
    const server = await f.server();
    const identity = vi.mocked(f.adapter.getApplicationServer);
    const listing = vi.mocked(f.adapter.listFiles);
    const identityBefore = identity.mock.calls.length;
    const listingsBefore = listing.mock.calls.length;
    for (const path of ['', 'world', 'world/playerdata']) {
      const response = await request(user, `/v1/servers/${server}/files?path=${path}`);
      expect(response.status).toBe(200);
      expect((await response.json())[0].name).toBe('server.properties');
      expect(listing.mock.lastCall?.[1]).toBe(path);
    }
    expect(identity.mock.calls.length - identityBefore).toBe(1);
    expect(listing.mock.calls.length - listingsBefore).toBe(3);
    expect((await request(outsider, `/v1/servers/${server}/files?path=world`)).status).toBe(403);
    expect(listing.mock.calls.length - listingsBefore).toBe(3);
    // A warm directory proof cannot substitute for a fresh write identity check.
    expect(
      (
        await request(user, `/v1/servers/${server}/files`, {
          action: 'write',
          path: 'fixture.txt',
          content: 'fixture',
        })
      ).status,
    ).toBe(204);
    expect(identity.mock.calls.length - identityBefore).toBe(2);
  });
  it('authorizes directory batches once per request and keeps metadata prefetch separate from downloads', async () => {
    const server = await f.server();
    const originalSettings = f.adapter.getDirectoryBatchSettings;
    const originalBatch = f.adapter.listDirectoriesBatch;
    const originalDownloads = f.adapter.prefetchDownloads;
    const settings = vi.fn(async () => ({
      directoryBatchLimit: 48,
      directoryConcurrency: 2,
      directoryTimeoutSeconds: 8,
    }));
    const batch = vi.fn<PterodactylAdapter['listDirectoriesBatch']>(async (_id, paths) =>
      paths.map((directory) => ({ directory, files: [fileEntry('a.txt')] })),
    );
    const downloads = vi.fn(async () => {});
    Object.assign(f.adapter, {
      getDirectoryBatchSettings: settings,
      listDirectoriesBatch: batch,
      prefetchDownloads: downloads,
    });
    const path = `/v1/servers/${server}/files/directories`;
    try {
      for (const client of [null, outsider]) {
        const response = await request(client, path, { directories: ['world'] });
        expect(response.status).toBe(client ? 403 : 401);
      }
      expect(settings).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
      expect(
        (
          await request(
            user,
            path,
            { directories: ['world'] },
            {
              headers: { origin: 'https://foreign.example.test' },
            },
          )
        ).status,
      ).toBe(403);
      expect(batch).not.toHaveBeenCalled();
      const response = await request(user, path, { directories: ['world', 'logs'] });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        results: [
          { directory: 'world', files: [fileEntry('a.txt')] },
          { directory: 'logs', files: [fileEntry('a.txt')] },
        ],
      });
      expect(batch).toHaveBeenCalledExactlyOnceWith(expect.any(String), ['world', 'logs']);
      expect(downloads).not.toHaveBeenCalled();
      for (const directories of [[], ['world', 'world'], ['../world'], Array(49).fill('world')])
        expect((await request(user, path, { directories })).status).toBe(400);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(
        (await request(user, `/v1/servers/${server}/files?path=world&prepareDownloads=false`))
          .status,
      ).toBe(200);
      expect(downloads).not.toHaveBeenCalled();
      expect((await request(user, `/v1/servers/${server}/files?path=world`)).status).toBe(200);
      expect(downloads).toHaveBeenCalledTimes(1);
    } finally {
      Object.assign(f.adapter, {
        getDirectoryBatchSettings: originalSettings,
        listDirectoriesBatch: originalBatch,
        prefetchDownloads: originalDownloads,
      });
    }
  });
  it('isolates unrelated users from every server read and write surface before provider access', async () => {
    const server = await f.server();
    const reads = [
      '',
      '/operations',
      '/events',
      '/metrics',
      '/resources',
      '/files',
      '/files/content?path=server.properties',
      '/backups',
      `/backups/${backupId}/download`,
      '/console',
      '/sftp',
      '/dns',
    ];
    const before = vi.mocked(f.adapter.getApplicationServer).mock.calls.length;
    for (const suffix of reads)
      expect((await request(outsider, `/v1/servers/${server}${suffix}`)).status).toBe(403);
    for (const [suffix, data] of [
      ['/console', { command: 'status' }],
      ['/files', { action: 'write', path: 'server.properties', content: 'fixture' }],
      ['/operations', { action: 'stop', idempotencyKey: randomUUID() }],
      ['/sftp', { credentialId: randomUUID() }],
      ['/dns/preview', {}],
    ] as const)
      expect((await request(outsider, `/v1/servers/${server}${suffix}`, data)).status).toBe(403);
    expect(vi.mocked(f.adapter.getApplicationServer).mock.calls.length).toBe(before);
    expect(
      (await (await request(outsider, '/v1/servers')).json()).some(
        (entry: { id: string }) => entry.id === server,
      ),
    ).toBe(false);
    expect((await request(user, `/v1/servers/${randomUUID()}`)).status).toBe(404);
    const own = await (await request(user, `/v1/servers/${server}`)).json();
    expect(own.id).toBe(server);
    expect(own.ports[0]).toHaveProperty('port');
    expect(JSON.stringify(own)).not.toMatch(/pterodactyl|external_id|address|provision_user/);
  });
  it('applies current project viewer/operator/manager rights to files, console and backups', async () => {
    const projectResponse = await request(user, '/v1/projects', { name: 'API project' });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json();
    const server = await f.server({ projectId: project.id });
    const memberPath = `/v1/projects/${project.id}/members`;
    expect(
      (
        await request(
          outsider,
          memberPath,
          { userId: outsiderId, role: 'manager' },
          { method: 'PUT' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(user, memberPath, { userId: peerId, role: 'viewer' }, { method: 'PUT' }))
        .status,
    ).toBe(204);
    for (const suffix of ['', '/files', '/backups', '/console'])
      expect((await request(peer, `/v1/servers/${server}${suffix}`)).status).toBe(200);
    expect(
      (await request(peer, `/v1/servers/${server}/console`, { command: 'status' })).status,
    ).toBe(403);
    expect(
      (
        await request(peer, `/v1/servers/${server}/operations`, {
          action: 'stop',
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(user, memberPath, { userId: peerId, role: 'operator' }, { method: 'PUT' }))
        .status,
    ).toBe(204);
    expect(
      (
        await request(peer, `/v1/servers/${server}/files`, {
          action: 'write',
          path: 'fixture',
          content: 'private-content',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          peer,
          `/v1/servers/${server}/backups/${backupId}`,
          { confirm: true },
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(user, memberPath, { userId: peerId, role: 'manager' }, { method: 'PUT' }))
        .status,
    ).toBe(204);
    expect(
      (
        await request(peer, `/v1/servers/${server}/files`, {
          action: 'write',
          path: 'fixture',
          content: 'private-content',
        })
      ).status,
    ).toBe(204);
    expect(
      (await request(peer, `/v1/servers/${server}/console`, { command: 'private-command' })).status,
    ).toBe(204);
    expect(
      (
        await request(
          peer,
          `/v1/servers/${server}/backups/${backupId}`,
          { confirm: true },
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(204);
    expect(
      (await request(user, memberPath, { userId: peerId, role: null }, { method: 'PUT' })).status,
    ).toBe(204);
    expect((await request(peer, `/v1/servers/${server}/files`)).status).toBe(403);
    expect(await consoleAuthorization?.()).toBe(false);
    const audits = await f.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', 'in', ['server.files.requested', 'server.console.command'])
      .execute();
    expect(audits.some((audit) => audit.actor_user_id === peerId)).toBe(true);
    expect(JSON.stringify(audits)).not.toMatch(/private-content|private-command/);
  });
  it('streams safe bytes/events without privileged provider URLs or tokens', async () => {
    const server = await f.server();
    const file = await request(user, `/v1/servers/${server}/files/content?path=server.properties`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('fixture-data');
    const backup = await request(user, `/v1/servers/${server}/backups/${backupId}/download`);
    expect(backup.status).toBe(200);
    expect(await backup.text()).toBe('fixture-backup');
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="server.properties"; filename*=UTF-8\'\'server.properties',
    );
    expect(backup.headers.get('content-disposition')).toBe('attachment');
    for (const response of [file, backup]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const logsBefore = requestConsoleLogs.mock.calls.length;
    const console = await request(user, `/v1/servers/${server}/console`);
    expect(console.status).toBe(200);
    const events = await console.text();
    expect(requestConsoleLogs.mock.calls.length).toBe(logsBefore + 1);
    const resumed = await request(user, `/v1/servers/${server}/console?history=0`);
    await resumed.text();
    expect(requestConsoleLogs.mock.calls.length).toBe(logsBefore + 1);
    expect(events).toContain('Isolated console output');
    expect(events).toContain('event: closed');
    expect(events).not.toMatch(/token|socket|wss:/);
    expect(relayClose).toHaveBeenCalled();
    expect(
      (
        await request(user, `/v1/servers/${server}/files`, {
          action: 'delete',
          root: '/',
          files: ['fixture'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          user,
          `/v1/servers/${server}/console`,
          { command: 'status' },
          { headers: { origin: 'null' } },
        )
      ).status,
    ).toBe(403);
  });
  it('returns generated per-server secrets once and protects metadata, retries and rotation', async () => {
    const server = await f.server(),
      second = await f.server(),
      credentialId = randomUUID();
    const created = await request(user, `/v1/servers/${server}/sftp`, { credentialId });
    expect(created.status).toBe(201);
    const issued = await created.json();
    expect(issued.password).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const repeated = await (
      await request(user, `/v1/servers/${server}/sftp`, { credentialId })
    ).json();
    expect(repeated.password).toBeUndefined();
    const metadata = await request(user, `/v1/servers/${server}/sftp`);
    const metadataText = await metadata.text();
    expect(metadata.status).toBe(200);
    expect(metadataText).toContain(credentialId);
    expect(metadataText).not.toContain(issued.password);
    expect(metadataText).not.toMatch(/envelope|provider_ref|externalUserId|externalServerUuid/);
    expect(
      (
        await request(user, `/v1/servers/${second}/sftp/${credentialId}/rotate`, {
          rotationId: randomUUID(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          outsider,
          `/v1/servers/${server}/sftp/${credentialId}`,
          {},
          { method: 'DELETE' },
        )
      ).status,
    ).toBe(403);
    const rotationId = randomUUID();
    const rotated = await (
      await request(user, `/v1/servers/${server}/sftp/${credentialId}/rotate`, { rotationId })
    ).json();
    expect(rotated.password).not.toBe(issued.password);
    expect(rotated.password).toBeTruthy();
    expect(
      (
        await (
          await request(user, `/v1/servers/${server}/sftp/${credentialId}/rotate`, { rotationId })
        ).json()
      ).password,
    ).toBeUndefined();
    expect(
      (await request(user, `/v1/servers/${server}/sftp/${credentialId}`, {}, { method: 'DELETE' }))
        .status,
    ).toBe(200);
    const audits = await f.db.selectFrom('audit_events').selectAll().execute();
    for (const secret of [issued.password, rotated.password, providerSecret]) {
      expect(JSON.stringify(logs)).not.toContain(secret);
      expect(JSON.stringify(audits)).not.toContain(secret);
      expect(metadataText).not.toContain(secret);
    }
  });
  it('keeps support attributable and denies persistent credential issuance and Owner configuration', async () => {
    const server = await f.server();
    const proof = await (await request(owner, '/v1/identity/step-up', { password })).json();
    const response = await request(owner, '/v1/support', {
      stepUpToken: proof.token,
      subjectUserId: userId,
      reason: 'Isolated server support',
    });
    expect(response.status).toBe(201);
    const support = await response.json();
    const options = { headers: { 'x-nh-support-token': support.token } };
    expect((await request(owner, `/v1/servers/${server}/files`, undefined, options)).status).toBe(
      200,
    );
    expect(
      (
        await request(
          owner,
          `/v1/servers/${server}/console`,
          { command: 'support-status' },
          options,
        )
      ).status,
    ).toBe(204);
    expect(
      (await request(owner, `/v1/servers/${server}/sftp`, { credentialId: randomUUID() }, options))
        .status,
    ).toBe(403);
    expect((await request(owner, '/v1/owner/infrastructure', undefined, options)).status).toBe(403);
    const audit = await f.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'server.console.command')
      .where('subject_user_id', '=', userId)
      .where('correlation_id', '=', support.id)
      .executeTakeFirstOrThrow();
    expect(audit.actor_user_id).not.toBe(userId);
    await database.pool.query(
      "UPDATE support_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
      [support.id],
    );
    expect((await request(owner, `/v1/servers/${server}/files`, undefined, options)).status).toBe(
      403,
    );
  });
  it('applies current role changes to existing authenticated sessions', async () => {
    await f.db.updateTable('user').set({ role: 'operator' }).where('id', '=', peerId).execute();
    expect((await request(peer, '/v1/owner/infrastructure')).status).toBe(403);
    expect((await request(peer, '/v1/owner/runtime-mappings', {}, { method: 'PUT' })).status).toBe(
      403,
    );
    await f.db.updateTable('user').set({ role: 'user' }).where('id', '=', peerId).execute();
    expect((await (await request(peer, '/v1/me')).json()).identity.role).toBe('user');
  });
  it('reads the authenticated session once per successful request without reusing it across requests', async () => {
    const temporary = new AuthClient(identity);
    expect(
      (await temporary.request('/sign-in/email', { email: 'servers-peer@example.test', password }))
        .status,
    ).toBe(200);
    const { sessionId } = await identity.authenticate(temporary.headers());
    const sessions = vi.spyOn(identity.auth.api, 'getSession');
    try {
      expect((await request(user, '/v1/me')).status).toBe(200);
      expect(sessions).toHaveBeenCalledTimes(1);
      sessions.mockClear();
      expect((await request(temporary, '/v1/me')).status).toBe(200);
      expect(sessions).toHaveBeenCalledTimes(1);
      await database.pool.query('DELETE FROM session WHERE id=$1', [sessionId]);
      const denied = await request(temporary, '/v1/me');
      expect(denied.status).toBe(401);
      expect((await denied.json()).error.code).toBe('unauthenticated');
    } finally {
      sessions.mockRestore();
      await database.pool.query('DELETE FROM session WHERE id=$1', [sessionId]);
    }
  });
  it('resolves stored error locale lazily before authentication and preserves original errors if lookup fails', async () => {
    const previous = await f.db
      .selectFrom('user')
      .select('locale')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    await f.db.updateTable('user').set({ locale: 'it' }).where('id', '=', userId).execute();
    const sessions = vi.spyOn(identity.auth.api, 'getSession');
    try {
      const response = await request(
        user,
        '/v1/setup/owner',
        {},
        { headers: { 'accept-language': 'en' } },
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toEqual(
        localizeError(new DomainError('validation_failed'), 'it'),
      );
      expect(sessions).toHaveBeenCalledTimes(1);
      sessions.mockRejectedValueOnce(new Error('isolated locale lookup failure'));
      const failed = await request(
        user,
        '/v1/setup/owner',
        {},
        { headers: { 'accept-language': 'it' } },
      );
      expect(failed.status).toBe(400);
      expect((await failed.json()).error).toEqual(
        localizeError(new DomainError('validation_failed'), 'it'),
      );
    } finally {
      sessions.mockRestore();
      await f.db
        .updateTable('user')
        .set({ locale: previous.locale })
        .where('id', '=', userId)
        .execute();
    }
  });
  it('fails closed on remote identity drift, pending lifecycle work and sensitive upstream errors', async () => {
    const server = await f.server();
    const readRemote = vi.mocked(f.adapter.getApplicationServer).getMockImplementation();
    if (!readRemote) throw new Error('Missing provider fixture');
    vi.mocked(f.adapter.getApplicationServer).mockImplementationOnce(async (id) => ({
      ...(await readRemote(id)),
      external_id: `foreign-${randomUUID()}`,
    }));
    const before = writeFile.mock.calls.length;
    const mismatch = await request(user, `/v1/servers/${server}/files`, {
      action: 'write',
      path: 'fixture',
      content: 'fixture',
    });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).error.code).toBe('provenance_mismatch');
    expect(writeFile.mock.calls.length).toBe(before);
    vi.mocked(f.adapter.listFiles).mockRejectedValueOnce(new Error(providerSecret));
    const failed = await request(user, `/v1/servers/${server}/files`);
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain(providerSecret);
    vi.mocked(f.adapter.relayConsole).mockRejectedValueOnce(new Error(providerSecret));
    const stream = await request(user, `/v1/servers/${server}/console`);
    const output = await stream.text();
    expect(output).toContain('integration_unavailable');
    expect(output).toContain('"type":"error"');
    expect(output).not.toContain(providerSecret);
    vi.mocked(f.adapter.relayConsole).mockRejectedValueOnce(new DomainError('forbidden'));
    const deniedStream = await request(user, `/v1/servers/${server}/console`);
    expect(await deniedStream.text()).toContain('{"type":"error","code":"forbidden"}');
    expect(
      (
        await request(user, `/v1/servers/${server}/operations`, {
          action: 'stop',
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await request(user, `/v1/servers/${server}/files`, {
          action: 'write',
          path: 'fixture',
          content: 'fixture',
        })
      ).status,
    ).toBe(409);
    expect(writeFile.mock.calls.length).toBe(before);
    expect(JSON.stringify(logs)).not.toContain(providerSecret);
  });
  async function minecraftServer() {
    const server = await f.server();
    // A Minecraft profile must belong to a Minecraft mapping. Keep the generic
    // M2 fixture untouched: trusted dispatch correctly rejects a retained game
    // profile under an unrelated mapping before reaching any file hook.
    await f.db
      .insertInto('game_integrations')
      .values({
        id: minecraftManifest.id,
        version: minecraftManifest.version,
        manifest: minecraftManifest,
      })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
    const mapping = await f.db
      .selectFrom('runtime_egg_mappings')
      .selectAll()
      .where('id', '=', f.mappingId)
      .executeTakeFirstOrThrow();
    const previous = await f.db
      .selectFrom('runtime_egg_mappings')
      .select('id')
      .where('game_id', '=', minecraftManifest.id)
      .where('runtime_id', '=', 'fabric')
      .where('node_id', '=', mapping.node_id)
      .executeTakeFirst();
    const minecraftMappingId = previous?.id ?? randomUUID();
    if (!previous)
      await f.db
        .insertInto('runtime_egg_mappings')
        .values({
          ...mapping,
          id: minecraftMappingId,
          game_id: minecraftManifest.id,
          runtime_id: 'fabric',
          environment: JSON.stringify(mapping.environment),
          port_roles: JSON.stringify(mapping.port_roles),
          feature_limits: JSON.stringify(mapping.feature_limits),
        })
        .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ mapping_id: minecraftMappingId })
      .where('id', '=', server)
      .execute();
    const choiceId = randomUUID();
    const binding = {
      profile: 'fabric',
      release: '1.21.1',
      image: 'fixture/image:1',
      imageJavaMajor: 21,
      declaredEggVariables: [],
      bindings: {},
      fixedVariables: {},
      installationKind: 'fabric-installer',
      artifactPaths: { server: 'server.jar' },
      supportedProperties: [],
    };
    await f.db
      .insertInto('minecraft_combinations')
      .values({
        id: choiceId,
        mapping_id: minecraftMappingId,
        combination: '{}',
        resolved_runtime: '{}',
        binding: JSON.stringify(binding),
        mapping_digest: 'a'.repeat(64),
        identity_digest: choiceId.replaceAll('-', '').repeat(2),
      })
      .execute();
    await f.db
      .insertInto('minecraft_server_profiles')
      .values({
        server_id: server,
        combination_id: choiceId,
        configuration: '{}',
        installed: true,
        installed_manifest: JSON.stringify([
          { path: 'server.jar', sha256: 'c'.repeat(64), size: 1 },
          { path: 'libraries/fabric/loader.jar', sha256: 'd'.repeat(64), size: 1 },
        ]),
      })
      .execute();
    return server;
  }
  it('protects Minecraft launch inputs in every browser mutation without blocking worlds or mods', async () => {
    const server = await minecraftServer();
    for (const input of [
      { action: 'write', path: 'server.jar', content: 'bad' },
      {
        action: 'write',
        path: 'fabric-server-launcher.properties',
        content: 'serverJar=other.jar',
      },
      { action: 'delete', root: '', files: ['libraries'], confirm: true },
      { action: 'rename', root: '', files: [{ from: 'libraries', to: 'elsewhere' }] },
      { action: 'rename', root: '', files: [{ from: 'world.bin', to: 'server.jar' }] },
      { action: 'mkdir', root: '', name: 'server.jar' },
    ])
      expect((await request(user, `/v1/servers/${server}/files`, input)).status).toBe(400);
    const headers = user.headers();
    headers.set('content-type', 'application/octet-stream');
    headers.set('x-nh-upload-length', '1');
    expect(
      (
        await app.request(`${origin}/v1/servers/${server}/files/upload?path=server.jar`, {
          method: 'PUT',
          headers,
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(400);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(
      (
        await request(user, `/v1/servers/${server}/files`, {
          action: 'write',
          path: 'mods/config.txt',
          content: 'allowed',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(user, `/v1/servers/${server}/files`, {
          action: 'write',
          path: 'world/config.txt',
          content: 'allowed',
        })
      ).status,
    ).toBe(204);
    const files = Array.from({ length: 1001 }, (_, index) => `file-${index}.dat`);
    const entry = (name: string, isFile = true) => ({
      name,
      mode: '-rw-r--r--',
      size: 1,
      is_file: isFile,
      is_symlink: false,
      mimetype: 'application/octet-stream',
      created_at: '2026-01-01T00:00:00Z',
      modified_at: '2026-01-01T00:00:00Z',
    });
    const originalListFiles = f.adapter.listFiles;
    const originalDeleteFiles = f.adapter.deleteFiles;
    const listFiles = vi
      .fn<PterodactylAdapter['listFiles']>()
      .mockImplementation(async (_id, directory = '') => {
        if (directory === '') return [entry('world', false)];
        if (directory === 'world') return [entry('data', false)];
        if (directory === 'world/data') return files.map((name) => entry(name));
        return [];
      });
    const deleteFiles = vi.fn<PterodactylAdapter['deleteFiles']>().mockResolvedValue(undefined);
    Object.assign(f.adapter, { listFiles, deleteFiles });
    try {
      for (const input of [
        { action: 'delete', root: '', files: [...files, 'libraries'], confirm: true },
        {
          action: 'rename',
          root: '',
          files: [
            ...files.map((from) => ({ from, to: `target/${from}` })),
            { from: 'libraries', to: 'target/libraries' },
          ],
        },
        { action: 'delete', root: '', files: [...files, '../escape'], confirm: true },
        { action: 'delete', root: '', files: [...files, files[0]], confirm: true },
        { action: 'delete', root: '', files: [...files, 'FILE-0.dat'], confirm: true },
        { action: 'delete', root: '', files: [...files, 'file-0.dat/child'], confirm: true },
      ]) {
        expect((await request(user, `/v1/servers/${server}/files`, input)).status).toBe(400);
        expect(deleteFiles).not.toHaveBeenCalled();
      }
      listFiles.mockClear();
      expect(
        (
          await request(user, `/v1/servers/${server}/files`, {
            action: 'delete',
            root: 'world/data',
            files,
            confirm: true,
          })
        ).status,
      ).toBe(204);
      expect(listFiles.mock.calls.map(([, directory]) => directory)).toEqual([
        '',
        'world',
        'world/data',
      ]);
      expect(deleteFiles).toHaveBeenCalledTimes(2);
      expect(deleteFiles).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        'world/data',
        files.slice(0, 1000),
      );
      expect(deleteFiles).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        'world/data',
        files.slice(1000),
      );
    } finally {
      Object.assign(f.adapter, { listFiles: originalListFiles, deleteFiles: originalDeleteFiles });
    }
  });
  it('enforces CSRF and the larger bounded POST archive manifest through real application middleware', async () => {
    const server = await f.server();
    const listing = vi.mocked(f.adapter.listFiles);
    const original = listing.getMockImplementation();
    listing.mockImplementation(async (_id, directory = '') =>
      directory === '' ? [fileEntry('archive', { is_file: false, size: 0 })] : [],
    );
    const body = new URLSearchParams({
      root: '',
      files: `[${' '.repeat(70 * 1024)}"archive"]`,
    }).toString();
    expect(Buffer.byteLength(body)).toBeGreaterThan(64 * 1024);
    const send = (requestOrigin: string | null, payload = body) => {
      const headers = user.headers();
      headers.set('content-type', 'application/x-www-form-urlencoded');
      if (requestOrigin === null) headers.delete('origin');
      else headers.set('origin', requestOrigin);
      return app.request(`${origin}/v1/servers/${server}/files/archive`, {
        method: 'POST',
        headers,
        body: payload,
      });
    };
    try {
      for (const forged of [null, 'null', 'https://attacker.example.test']) {
        expect((await send(forged)).status).toBe(403);
        expect(listing).not.toHaveBeenCalled();
      }
      const allowed = await send(origin);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('content-type')).toContain('application/zip');
      expect((await allowed.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect((await send(origin, `files=${'x'.repeat(4 * 1024 * 1024)}`)).status).toBe(413);
    } finally {
      listing.mockImplementation(original ?? (async () => []));
    }
  });
  it('uploads binary data larger than the JSON/text limits through the authorized streaming route', async () => {
    const server = await f.server();
    const binary = new Uint8Array(2 * 1024 * 1024 + 17).fill(0xa5);
    const response = await upload(user, server, binary, binary.length);
    expect(response.status).toBe(204);
    expect(uploadFile).toHaveBeenLastCalledWith(
      expect.any(String),
      'world.bin',
      expect.objectContaining({ contentLength: binary.length, maxBytes: 64 * 1024 ** 2 }),
    );
    const audits = await f.db
      .selectFrom('audit_events')
      .select(['action', 'metadata'])
      .where('action', '=', 'server.files.uploaded')
      .execute();
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toMatch(/private-token|a5a5/);
    expect(JSON.stringify(logs)).not.toMatch(/private-token/);
  });

  it('accepts only one strict boolean overwrite query before provider work', async () => {
    const server = await f.server();
    const identityCalls = vi.mocked(f.adapter.getApplicationServer).mock.calls.length;
    const before = uploadFile.mock.calls.length;
    for (const overwrite of ['', '0', 'FALSE', 'yes', ' false', ['false', 'true']]) {
      const response = await upload(user, server, new Uint8Array(1), 1, {}, undefined, {
        overwrite,
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('validation_failed');
    }
    expect(vi.mocked(f.adapter.getApplicationServer).mock.calls).toHaveLength(identityCalls);
    expect(uploadFile.mock.calls).toHaveLength(before);
  });

  it.each([false, true])(
    'refuses every destination-name collision before upload admission with Minecraft=%s',
    async (minecraft) => {
      const server = minecraft ? await minecraftServer() : await f.server();
      const before = uploadFile.mock.calls.length;
      const pull = vi.fn();
      for (const existing of [
        fileEntry('world.bin'),
        fileEntry('WORLD.BIN'),
        fileEntry('world.bin', { is_file: false }),
        fileEntry('world.bin', { is_symlink: true }),
        fileEntry('WORLD.BIN', { is_symlink: true }),
      ]) {
        vi.mocked(f.adapter.listFiles).mockResolvedValueOnce([existing]);
        const response = await upload(
          user,
          server,
          new ReadableStream({ pull }, { highWaterMark: 0 }),
          1,
          {},
          undefined,
          { overwrite: 'false' },
        );
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('file_exists');
      }
      expect(pull).not.toHaveBeenCalled();
      expect(uploadFile.mock.calls).toHaveLength(before);
      expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
      const audits = await f.db
        .selectFrom('audit_events')
        .select('metadata')
        .where('action', '=', 'server.files.requested')
        .execute();
      expect(
        audits.some((audit) => (audit.metadata as { serverId?: string }).serverId === server),
      ).toBe(false);
    },
  );

  it.each([undefined, 'true'])(
    'preserves regular file overwrites with overwrite=%s',
    async (overwrite) => {
      const server = await minecraftServer();
      vi.mocked(f.adapter.listFiles).mockResolvedValueOnce([fileEntry('world.bin')]);
      const before = uploadFile.mock.calls.length;
      expect(
        (await upload(user, server, new Uint8Array(1), 1, {}, undefined, { overwrite })).status,
      ).toBe(204);
      expect(uploadFile.mock.calls).toHaveLength(before + 1);
    },
  );

  it.each(['protected-runtime', 'symlink-ancestor'])(
    'keeps %s guards ahead of overwrite=false destination checks',
    async (failure) => {
      const server = await minecraftServer();
      const files = vi.mocked(f.adapter.listFiles);
      const before = files.mock.calls.length;
      const uploads = uploadFile.mock.calls.length;
      if (failure === 'symlink-ancestor')
        files.mockResolvedValueOnce([fileEntry('mods', { is_file: false, is_symlink: true })]);
      const response = await upload(user, server, new Uint8Array(1), 1, {}, undefined, {
        path: failure === 'protected-runtime' ? 'server.jar' : 'mods/world.bin',
        overwrite: 'false',
      });
      expect((await response.json()).error.code).toBe(
        failure === 'protected-runtime' ? 'validation_failed' : 'conflict',
      );
      expect(files.mock.calls.slice(before).map(([, directory]) => directory)).toEqual(
        failure === 'protected-runtime' ? [] : ['', 'mods'],
      );
      expect(uploadFile.mock.calls).toHaveLength(uploads);
      expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
    },
  );

  it.each(['', 'mods', 'world/data'])(
    'shares each fresh upload directory observation between game and destination guards under %j',
    async (root) => {
      const server = await minecraftServer();
      const listings = new Map<string, ServerFile[]>();
      let directory = '';
      for (const component of root ? root.split('/') : []) {
        listings.set(directory, [fileEntry(component, { is_file: false })]);
        directory = [directory, component].filter(Boolean).join('/');
      }
      listings.set(root, []);
      const listFiles = vi.mocked(f.adapter.listFiles);
      const original = listFiles.getMockImplementation();
      const before = listFiles.mock.calls.length;
      const resourceCalls = vi.mocked(f.adapter.getResources).mock.calls.length;
      listFiles.mockImplementation(async (_id, path = '') => listings.get(path) ?? []);
      try {
        const path = [root, 'world.bin'].filter(Boolean).join('/');
        expect(
          (
            await upload(user, server, new Uint8Array(1), 1, {}, undefined, {
              path,
              overwrite: 'false',
            })
          ).status,
        ).toBe(204);
        expect(listFiles.mock.calls.slice(before).map(([, path]) => path)).toEqual([
          ...listings.keys(),
        ]);
        expect(vi.mocked(f.adapter.getResources).mock.calls).toHaveLength(resourceCalls + 1);
        // A subsequent request must see newly created destination entries.
        listings.set(root, [fileEntry('world.bin')]);
        const next = listFiles.mock.calls.length;
        const response = await upload(user, server, new Uint8Array(1), 1, {}, undefined, {
          path,
          overwrite: 'false',
        });
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('file_exists');
        expect(listFiles.mock.calls.slice(next).map(([, path]) => path)).toEqual([
          ...listings.keys(),
        ]);
      } finally {
        listFiles.mockImplementation(original ?? (async () => []));
      }
    },
  );

  it('reuses the browsing identity for 49 uploads while retaining fresh path and quota observations', async () => {
    const server = await minecraftServer();
    const identity = vi.mocked(f.adapter.getApplicationServer);
    const list = vi.mocked(f.adapter.listFiles);
    const original = list.getMockImplementation();
    const before = identity.mock.calls.length;
    const uploaded = uploadFile.mock.calls.length;
    let unsafe = false;
    list.mockImplementation(async (_id, directory = '') =>
      directory === '' ? [fileEntry('world', { is_file: false, is_symlink: unsafe })] : [],
    );
    try {
      expect((await request(user, `/v1/servers/${server}/files`)).status).toBe(200);
      const reads = list.mock.calls.length;
      const resources = vi.mocked(f.adapter.getResources).mock.calls.length;
      for (let index = 0; index < 49; index++)
        expect(
          (
            await upload(user, server, new Uint8Array(1), 1, {}, undefined, {
              path: `world/private-fixture-${index}.txt`,
              overwrite: 'false',
            })
          ).status,
        ).toBe(204);
      expect(identity.mock.calls).toHaveLength(before + 1);
      expect(uploadFile.mock.calls).toHaveLength(uploaded + 49);
      expect(list.mock.calls).toHaveLength(reads + 98);
      expect(vi.mocked(f.adapter.getResources).mock.calls).toHaveLength(resources + 49);
      const timings = timingRecords.filter(
        (record) => record.event === 'server.files_upload' && record.data.serverId === server,
      );
      expect(timings).toHaveLength(49);
      for (const { data } of timings) {
        expect(data).toMatchObject({
          outcome: 'succeeded',
          bytes: 1,
          accessMs: expect.any(Number),
          pathsMs: expect.any(Number),
          resourcesMs: expect.any(Number),
          admissionMs: expect.any(Number),
          providerMs: expect.any(Number),
          settlementMs: expect.any(Number),
          durationMs: expect.any(Number),
          requestId: expect.any(String),
        });
        expect(JSON.stringify(data)).not.toMatch(/private-fixture|private-token|wings\.example/);
      }
      // Changing an ancestor outside NickHosting must not inherit cached path safety.
      unsafe = true;
      const rejected = await upload(user, server, new Uint8Array(1), 1, {}, undefined, {
        path: 'world/private-fixture-late.txt',
        overwrite: 'false',
      });
      expect(rejected.status).toBe(409);
      expect((await rejected.json()).error.code).toBe('conflict');
      expect(uploadFile.mock.calls).toHaveLength(uploaded + 49);
      expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
      expect(
        timingRecords.findLast(
          (record) => record.event === 'server.files_upload' && record.data.serverId === server,
        )?.data.outcome,
      ).toBe('failed');
    } finally {
      list.mockImplementation(original ?? (async () => []));
    }
  });

  it('overlaps resource sampling with game directory checks before starting an upload', async () => {
    const server = await minecraftServer();
    const resources = vi.mocked(f.adapter.getResources);
    const original = resources.getMockImplementation();
    if (!original) throw new Error('Missing isolated resource fixture');
    const resourceStarted = Promise.withResolvers<void>();
    const listingStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    resources.mockImplementationOnce(async (id) => {
      resourceStarted.resolve();
      await release.promise;
      return original(id);
    });
    vi.mocked(f.adapter.listFiles).mockImplementationOnce(async () => {
      listingStarted.resolve();
      await release.promise;
      return [];
    });
    const before = uploadFile.mock.calls.length;
    let finished = false;
    const pending = upload(user, server, new Uint8Array(1), 1).then((response) => {
      finished = true;
      return response;
    });
    try {
      await Promise.race([
        Promise.all([resourceStarted.promise, listingStarted.promise]),
        delay(2000).then(() => {
          throw new Error('Independent preflight reads did not overlap');
        }),
      ]);
      expect(finished).toBe(false);
      expect(uploadFile.mock.calls).toHaveLength(before);
      expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
    } finally {
      release.resolve();
      expect((await pending).status).toBe(204);
    }
  });

  it.each(['session', 'identity'] as const)(
    'rejects batch %s drift after admission without sending bytes or retaining unused capacity',
    async (change) => {
      const server = await f.server();
      const batchId = randomUUID();
      const path = 'batch-authorization.txt';
      const { sessionId } = await identity.authenticate(user.headers());
      const originalSession = await f.db
        .selectFrom('session')
        .select('expiresAt')
        .where('id', '=', sessionId)
        .executeTakeFirstOrThrow();
      const originalServer = await f.db
        .selectFrom('managed_servers')
        .select('pterodactyl_uuid')
        .where('id', '=', server)
        .executeTakeFirstOrThrow();
      const prepared = await request(user, `/v1/servers/${server}/files/upload-batches`, {
        id: batchId,
        files: [{ id: 'file', path, bytes: 1, overwrite: false }],
      });
      expect(prepared.status).toBe(200);
      const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
      uploadFile.mockImplementationOnce(async (_identifier, filename, input) => {
        const claim = await f.db
          .selectFrom('upload_ingestion_claims')
          .selectAll()
          .where('id', '=', batchId)
          .executeTakeFirstOrThrow();
        expect(claim.scope.batch?.files[0]?.state).toBe('active');
        if (change === 'session')
          await f.db
            .updateTable('session')
            .set({ expiresAt: new Date(0) })
            .where('id', '=', sessionId)
            .execute();
        else
          await f.db
            .updateTable('managed_servers')
            .set({ pterodactyl_uuid: randomUUID() })
            .where('id', '=', server)
            .execute();
        await createUploadProxy({
          baseURL: 'https://panel.example.test',
          applicationKey: 'isolated-key',
          uploadOrigins: ['https://wings.example.test'],
          fetcher,
        })('https://wings.example.test/upload/file?token=isolated-token', filename, input);
      });
      try {
        const result = await upload(user, server, new Uint8Array(1), 1, {}, undefined, {
          batchId,
          entryId: 'file',
          path,
          overwrite: 'false',
        });
        expect(result.status).toBe(503);
        expect(fetcher).not.toHaveBeenCalled();
        expect(
          await f.db
            .selectFrom('upload_ingestion_claims')
            .select('id')
            .where('id', '=', batchId)
            .execute(),
        ).toEqual([]);
        const audits = await f.db
          .selectFrom('audit_events')
          .select('action')
          .where('metadata', '@>', { serverId: server })
          .execute();
        expect(audits.some((event) => event.action === 'server.upload.not_dispatched')).toBe(true);
        expect(
          audits.some((event) =>
            ['server.upload.confirmed', 'server.files.uploaded'].includes(event.action),
          ),
        ).toBe(false);
      } finally {
        await f.db
          .updateTable('session')
          .set(originalSession)
          .where('id', '=', sessionId)
          .execute();
        await f.db
          .updateTable('managed_servers')
          .set(originalServer)
          .where('id', '=', server)
          .execute();
      }
    },
  );

  it('omits upload diagnostics at info without suppressing uploads, durable audits or request errors', async () => {
    const server = await f.server();
    const batchId = randomUUID();
    const tracesBefore = timingRecords.length;
    const access = vi.spyOn(runtime, 'uploadBatchAccess');
    diagnosticOptions.level = 'info';
    try {
      const prepared = await request(user, `/v1/servers/${server}/files/upload-batches`, {
        id: batchId,
        files: [{ id: 'one', path: 'quiet-upload.bin', bytes: 1, overwrite: false }],
      });
      expect(prepared.status).toBe(200);
      expect(
        (
          await upload(user, server, new Uint8Array(1), 1, {}, undefined, {
            batchId,
            entryId: 'one',
            path: 'quiet-upload.bin',
            overwrite: 'false',
          })
        ).status,
      ).toBe(204);
      expect(access.mock.calls.every((args) => args[4] === undefined)).toBe(true);
      expect((await upload(user, server, new Uint8Array(1), 1)).status).toBe(204);
      const failed = await upload(null, server, new Uint8Array(1), 1);
      expect(failed.status).toBe(401);
      expect(
        timingRecords
          .slice(tracesBefore)
          .filter((entry) => entry.event.startsWith('server.files_upload')),
      ).toEqual([]);
      const audit = await f.db
        .selectFrom('audit_events')
        .select('action')
        .where('metadata', '@>', { serverId: server })
        .execute();
      expect(audit.filter((entry) => entry.action === 'server.files.uploaded')).toHaveLength(2);
      expect(logs).toContainEqual(
        expect.objectContaining({ event: 'request.failed', code: 'unauthenticated' }),
      );
    } finally {
      access.mockRestore();
      diagnosticOptions.level = 'debug';
    }
  });

  it('prepares 49 files once, transfers two concurrently and rejects replay without repeating remote checks', async () => {
    const server = await minecraftServer();
    const list = vi.mocked(f.adapter.listFiles),
      resources = vi.mocked(f.adapter.getResources);
    const originalList = list.getMockImplementation(),
      originalUpload = uploadFile.getMockImplementation();
    if (!originalUpload) throw new Error('Missing upload fixture');
    list.mockImplementation(async (_id, directory = '') =>
      directory === '' ? [fileEntry('world', { is_file: false })] : [],
    );
    const batchId = randomUUID();
    const files = Array.from({ length: 49 }, (_, index) => ({
      id: String(index),
      path: `world/batch-${index}.txt`,
      bytes: 1,
      overwrite: false,
    }));
    const reads = list.mock.calls.length,
      samples = resources.mock.calls.length;
    const bothStarted = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const bulk = vi.mocked(f.adapter.prepareUploadBatch);
    const issued = bulk.mock.calls.length;
    const singles = vi.mocked(f.adapter.prepareUpload).mock.calls.length;
    bulk.mockImplementationOnce(async (identifier, paths) => ({
      expiresAt: Date.now() + 900_000,
      uploads: paths.map((path) => (input) => uploadFile(identifier, path, input)),
    }));
    let active = 0,
      peak = 0;
    try {
      const prepared = await request(user, `/v1/servers/${server}/files/upload-batches`, {
        id: batchId,
        files,
      });
      expect(prepared.status).toBe(200);
      expect(await prepared.json()).toMatchObject({ id: batchId, concurrency: 2, rejected: [] });
      expect(
        (await request(user, `/v1/servers/${server}/files/upload-batches`, { id: batchId, files }))
          .status,
      ).toBe(200);
      expect(list.mock.calls.length - reads).toBe(2);
      expect(resources.mock.calls.length - samples).toBe(1);
      expect(bulk.mock.calls.length - issued).toBe(1);
      expect(
        (
          await request(outsider, `/v1/servers/${server}/files/upload-batches`, {
            id: batchId,
            files,
          })
        ).status,
      ).toBe(403);
      uploadFile.mockImplementation(async (...args) => {
        active++;
        peak = Math.max(peak, active);
        if (active === 2) bothStarted.resolve();
        try {
          await release.promise;
          await originalUpload(...args);
        } finally {
          active--;
        }
      });
      const send = (index: number) =>
        upload(user, server, new Uint8Array(1), 1, {}, undefined, {
          path: files[index]?.path,
          overwrite: 'false',
          batchId,
          entryId: String(index),
        });
      const pending = [send(0), send(1)];
      try {
        await Promise.race([
          bothStarted.promise,
          delay(3000).then(() => {
            throw new Error('Uploads serialized');
          }),
        ]);
        const busy = await send(2);
        expect(busy.status).toBe(409);
        expect((await busy.json()).error.code).toBe('operation_busy');
        // Generic mutations cannot race the active shared transfer locks.
        expect(
          (
            await request(user, `/v1/servers/${server}/files`, {
              action: 'delete',
              root: '',
              files: ['world'],
              confirm: true,
            })
          ).status,
        ).toBe(409);
      } finally {
        release.resolve();
      }
      expect((await Promise.all(pending)).map((response) => response.status)).toEqual([204, 204]);
      expect(peak).toBe(2);
      expect((await send(0)).status).toBe(409);
      for (let index = 2; index < 49; index += 2)
        expect(
          (await Promise.all([send(index), ...(index + 1 < 49 ? [send(index + 1)] : [])])).every(
            (response) => response.status === 204,
          ),
        ).toBe(true);
      expect(list.mock.calls.length - reads).toBe(2);
      expect(resources.mock.calls.length - samples).toBe(1);
      expect(
        await f.db
          .selectFrom('upload_ingestion_claims')
          .selectAll()
          .where('server_id', '=', server)
          .execute(),
      ).toEqual([]);
      expect(
        (await request(user, `/v1/servers/${server}/files/upload-batches`, { id: batchId, files }))
          .status,
      ).toBe(409);
      const timings = timingRecords.filter(
        (record) =>
          record.event === 'server.files_upload' &&
          record.data.serverId === server &&
          record.data.outcome === 'succeeded',
      );
      expect(timings).toHaveLength(49);
      expect(timings.every((record) => typeof record.data.signedUrlMs === 'number')).toBe(true);
      expect(timings.every((record) => record.level === 'debug')).toBe(true);
      for (const { data } of timings) {
        const atomic = data.atomic as Record<
          string,
          { count: number; totalMs: number; maxMs: number }
        >;
        expect(atomic['request.principal']?.count).toBe(1);
        expect(atomic['access.connectionAcquire']?.count).toBe(1);
        expect(atomic['access.sessionFirst']?.count).toBe(1);
        expect(atomic['access.sessionSecond']).toBeUndefined();
        expect(atomic['access.permissionSecond']).toBeUndefined();
        expect(atomic['admission.resourceLock']).toBeUndefined();
        expect(atomic['settlement.resourceLock']).toBeUndefined();
        expect(atomic['completion.audit']).toBeUndefined();
        expect(atomic['transfer.sessionRead']?.count).toBeGreaterThanOrEqual(1);
        expect(atomic['transfer.serverPermission']?.count).toBe(
          atomic['transfer.sessionRead']?.count,
        );
        expect(atomic['access.connectionRelease']?.count).toBe(1);
        expect(Object.keys(atomic).length).toBeLessThanOrEqual(64);
        for (const value of Object.values(atomic)) {
          expect(value.totalMs).toBeGreaterThanOrEqual(0);
          expect(value.maxMs).toBeLessThanOrEqual(value.totalMs);
          expect(value.count).toBeGreaterThan(0);
        }
        expect(JSON.stringify(atomic)).not.toMatch(/private-|world|https?:|SELECT|INSERT/);
      }
      expect(
        timings.reduce(
          (sum, record) =>
            sum +
            ((record.data.atomic as Record<string, { count: number }>)[
              'settlementRelease.resourceLock'
            ]?.count ?? 0),
          0,
        ),
      ).toBe(1);
      const completedAudits = await f.db
        .selectFrom('audit_events')
        .select(['action', 'metadata'])
        .where('action', 'in', ['server.upload.confirmed', 'server.files.uploaded'])
        .execute();
      for (const action of ['server.upload.confirmed', 'server.files.uploaded'])
        expect(
          completedAudits.filter(
            (event) =>
              event.action === action &&
              (event.metadata as { serverId?: string }).serverId === server,
          ),
        ).toHaveLength(49);
      expect(bulk.mock.calls.length - issued).toBe(1);
      expect(vi.mocked(f.adapter.prepareUpload).mock.calls.length).toBe(singles);
    } finally {
      release.resolve();
      await vi.waitFor(() => expect(active).toBe(0));
      await request(user, `/v1/servers/${server}/files/upload-batches/${batchId}`, undefined, {
        method: 'DELETE',
      });
      list.mockImplementation(originalList ?? (async () => []));
      uploadFile.mockImplementation(originalUpload);
    }
  });

  it('normalizes real bulk handoffs and coalesces cache restart refresh without sharing cancellation', async () => {
    const server = await minecraftServer();
    const batchId = randomUUID();
    const originalApp = app;
    const list = vi.mocked(f.adapter.listFiles),
      bulk = vi.mocked(f.adapter.prepareUploadBatch);
    const originalList = list.getMockImplementation(),
      originalBulk = bulk.getMockImplementation();
    const refreshStarted = Promise.withResolvers<void>(),
      releaseRefresh = Promise.withResolvers<void>();
    const abortFirst = new AbortController();
    let issuances = 0;
    const uploaded: string[] = [];
    const pending: Promise<Response>[] = [];
    const paths = ['world/first.bin', 'world/second.bin'];
    const adapter = createPterodactylAdapter({
      baseURL: 'https://panel.example.test',
      applicationKey: 'isolated-application-key',
      clientKey: 'isolated-owner-key',
      uploadOrigins: ['https://wings.example.test'],
      fetcher: async (url, init) => {
        const target = new URL(String(url));
        if (target.origin === 'https://panel.example.test') {
          if (target.pathname.endsWith('/transfer-settings')) {
            expect(init?.method).toBe('GET');
            return Response.json({
              downloadBatchLimit: 2500,
              uploadBatchLimit: 500,
              signedUrlTtlSeconds: 900,
            });
          }
          expect(target.pathname).toMatch(
            /^\/api\/client\/extensions\/nickhosting\/servers\/[^/]+\/upload-urls$/,
          );
          expect(init?.method).toBe('POST');
          expect(JSON.parse(String(init?.body))).toEqual({ count: 2 });
          const issuance = ++issuances;
          if (issuance === 2) {
            refreshStarted.resolve();
            await releaseRefresh.promise;
          }
          return Response.json({
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            urls: paths.map(
              (_, index) =>
                `https://wings.example.test/upload/file?token=isolated-${issuance}-${index}`,
            ),
          });
        }
        expect(target.origin).toBe('https://wings.example.test');
        expect(target.pathname).toBe('/upload/file');
        expect(target.searchParams.get('directory')).toBe('/world');
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        const content = await new Response(init?.body).text();
        const filename = /filename="([^"]+)"/.exec(content)?.[1];
        if (!filename) throw new Error('Missing multipart fixture filename');
        uploaded.push(filename);
        return new Response(null, { status: 204 });
      },
    });
    list.mockImplementation(async (_identifier, directory = '') =>
      directory === '' ? [fileEntry('world', { is_file: false })] : [],
    );
    bulk.mockImplementation((...args) => adapter.prepareUploadBatch(...args));
    try {
      const response = await request(user, `/v1/servers/${server}/files/upload-batches`, {
        id: batchId,
        files: paths.map((path, index) => ({
          id: String(index),
          path,
          bytes: 1,
          overwrite: false,
        })),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(/isolated-|wings\.example/);
      expect(issuances).toBe(1);
      expect(uploaded).toEqual([]);
      expect(bulk.mock.lastCall?.[1]).toEqual(paths);

      // A fresh API instance retains PostgreSQL claims but has no in-memory URLs.
      app = createApp({
        database,
        identity: async () => identity,
        codec,
        origins: [origin],
        env,
        management: async () => runtime,
      });
      pending.push(
        upload(user, server, new Uint8Array(1), 1, {}, abortFirst.signal, {
          path: paths[0],
          batchId,
          entryId: '0',
          overwrite: 'false',
        }),
      );
      await Promise.race([
        refreshStarted.promise,
        delay(3000).then(() => {
          throw new Error('Missing cache restart refresh');
        }),
      ]);
      pending.push(
        upload(user, server, new Uint8Array(1), 1, {}, undefined, {
          path: paths[1],
          batchId,
          entryId: '1',
          overwrite: 'false',
        }),
      );
      await vi.waitFor(async () => {
        const claim = await f.db
          .selectFrom('upload_ingestion_claims')
          .select('scope')
          .where('id', '=', batchId)
          .executeTakeFirstOrThrow();
        expect(claim.scope.batch?.files.map((file) => file.state)).toEqual(['active', 'active']);
      });
      abortFirst.abort();
      releaseRefresh.resolve();
      const completed = await Promise.all(pending);
      expect(completed.map((item) => item.status)).toEqual([503, 204]);
      expect(issuances).toBe(2);
      expect(uploaded).toEqual(['second.bin']);
      expect(
        await f.db
          .selectFrom('upload_ingestion_claims')
          .select('id')
          .where('id', '=', batchId)
          .execute(),
      ).toEqual([]);
    } finally {
      abortFirst.abort();
      releaseRefresh.resolve();
      await Promise.allSettled(pending);
      await request(user, `/v1/servers/${server}/files/upload-batches/${batchId}`, undefined, {
        method: 'DELETE',
      });
      app = originalApp;
      list.mockImplementation(originalList ?? (async () => []));
      bulk.mockImplementation(originalBulk ?? (async () => null));
    }
  });

  it('prepares unaffected siblings, checks total growth once and validates the initial ancestor', async () => {
    const server = await minecraftServer();
    const list = vi.mocked(f.adapter.listFiles),
      original = list.getMockImplementation();
    const files = [
      { id: 'existing', path: 'world/present.txt', bytes: 1, overwrite: false },
      { id: 'new', path: 'world/new.txt', bytes: 1, overwrite: false },
    ];
    list.mockImplementation(async (_id, directory = '') =>
      directory === '' ? [fileEntry('world', { is_file: false })] : [fileEntry('present.txt')],
    );
    try {
      const batchId = randomUUID();
      const prepared = await request(user, `/v1/servers/${server}/files/upload-batches`, {
        id: batchId,
        files,
      });
      expect(prepared.status).toBe(200);
      expect(await prepared.json()).toMatchObject({
        id: batchId,
        rejected: [{ id: 'existing', code: 'file_exists' }],
        files: [{ id: 'new' }],
      });
      expect(
        (
          await upload(user, server, new Uint8Array(1), 1, {}, undefined, {
            path: 'world/different.txt',
            overwrite: 'false',
            batchId,
            entryId: 'new',
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(user, `/v1/servers/${server}/files/upload-batches/${batchId}`, undefined, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(204);
      list.mockImplementation(async (_id, directory = '') =>
        directory === '' ? [fileEntry('world', { is_file: false, is_symlink: true })] : [],
      );
      expect(
        (
          await request(user, `/v1/servers/${server}/files/upload-batches`, {
            id: randomUUID(),
            files,
          })
        ).status,
      ).toBe(409);
      expect(
        await f.db
          .selectFrom('upload_ingestion_claims')
          .selectAll()
          .where('server_id', '=', server)
          .execute(),
      ).toEqual([]);
    } finally {
      list.mockImplementation(original ?? (async () => []));
    }
  });

  it('requests a private upload URL while entry admission waits, without dispatching before admission', async () => {
    const server = await f.server();
    const batchId = randomUUID();
    const files = [{ id: 'one', path: 'prefetched.txt', bytes: 1, overwrite: true }];
    expect(
      (await request(user, `/v1/servers/${server}/files/upload-batches`, { id: batchId, files }))
        .status,
    ).toBe(200);
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = f.db.transaction().execute(async (tx) => {
      await lockResources(tx);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const ready = Promise.withResolvers<void>();
    const prepare = vi.mocked(f.adapter.prepareUpload),
      original = prepare.getMockImplementation();
    if (!original) throw new Error('Missing preparation fixture');
    prepare.mockImplementationOnce(async (...args) => {
      ready.resolve();
      return original(...args);
    });
    const writes = uploadFile.mock.calls.length;
    const pending = upload(user, server, new Uint8Array(1), 1, {}, undefined, {
      path: 'prefetched.txt',
      batchId,
      entryId: 'one',
    });
    try {
      await Promise.race([
        ready.promise,
        delay(3000).then(() => {
          throw new Error('Signed URL lookup waited for admission');
        }),
      ]);
      expect(uploadFile.mock.calls).toHaveLength(writes);
    } finally {
      release.resolve();
      await blocker;
    }
    expect((await pending).status).toBe(204);
    expect(uploadFile.mock.calls).toHaveLength(writes + 1);
  });

  it.each(['game-guard', 'listing', 'resources'])(
    'drains concurrent preflight reads and retains the lock after %s fails',
    async (failure) => {
      const server = await minecraftServer();
      const resources = vi.mocked(f.adapter.getResources);
      const originalResources = resources.getMockImplementation();
      if (!originalResources) throw new Error('Missing isolated resource fixture');
      const failed = Promise.withResolvers<void>();
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const originalGuard = runtime.assertFileMutation;
      const guard = vi.spyOn(runtime, 'assertFileMutation').mockImplementation(async (...args) => {
        try {
          await originalGuard(...args);
        } catch (error) {
          if (failure === 'game-guard') failed.resolve();
          throw error;
        }
      });
      if (failure === 'resources') {
        resources.mockImplementationOnce(() => {
          failed.resolve();
          throw new DomainError('integration_unavailable');
        });
        vi.mocked(f.adapter.listFiles).mockImplementationOnce(async () => {
          blocked.resolve();
          await release.promise;
          return [];
        });
      } else {
        resources.mockImplementationOnce(async (id) => {
          blocked.resolve();
          await release.promise;
          if (failure === 'game-guard') throw new DomainError('integration_unavailable');
          return originalResources(id);
        });
        if (failure === 'listing')
          vi.mocked(f.adapter.listFiles).mockImplementationOnce(async () => {
            failed.resolve();
            throw new DomainError('conflict');
          });
      }
      const before = uploadFile.mock.calls.length;
      let finished = false;
      const pending = upload(user, server, new Uint8Array(1), 1, {}, undefined, {
        path: failure === 'game-guard' ? 'server.jar' : 'world.bin',
      }).then((response) => {
        finished = true;
        return response;
      });
      let response: Response;
      try {
        await Promise.race([
          Promise.all([failed.promise, blocked.promise]),
          delay(2000).then(() => {
            throw new Error('Missing isolated preflight failure barrier');
          }),
        ]);
        expect(finished).toBe(false);
        const contender = await request(user, `/v1/servers/${server}/files`, {
          action: 'write',
          path: 'other.txt',
          content: 'must-not-run',
        });
        expect(contender.status).toBe(409);
        expect((await contender.json()).error.code).toBe('operation_busy');
        expect(uploadFile.mock.calls).toHaveLength(before);
        expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
      } finally {
        release.resolve();
        response = await pending;
        guard.mockRestore();
      }
      const expected =
        failure === 'game-guard'
          ? 'validation_failed'
          : failure === 'listing'
            ? 'conflict'
            : 'integration_unavailable';
      expect((await response.json()).error.code).toBe(expected);
      expect(uploadFile.mock.calls).toHaveLength(before);
    },
  );

  it.each([
    'already-aborted',
    'token-failed',
    'token-aborted',
    'invalid-target',
    'authorization-failed',
  ])(
    'releases the ingestion claim after %s before POST and accepts the next upload',
    async (failure) => {
      const server = await f.server();
      const controller = new AbortController();
      if (failure === 'already-aborted') controller.abort();
      const waiting = Promise.withResolvers<Response>();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        expect(init?.method).toBe('GET');
        if (failure === 'token-failed') return new Response(null, { status: 403 });
        if (failure === 'token-aborted') {
          controller.abort();
          return waiting.promise;
        }
        return Response.json({
          attributes: { url: 'https://untrusted.example.test/upload/file?token=private-token' },
        });
      });
      const adapter = createPterodactylAdapter({
        baseURL: 'https://panel.example.test',
        applicationKey: 'isolated-key',
        clientKey: 'isolated-client-key',
        uploadOrigins: ['https://wings.example.test'],
        fetcher,
      });
      uploadFile.mockImplementationOnce((id, path, input) =>
        adapter.uploadFile(id, path, {
          ...input,
          ...(failure === 'authorization-failed'
            ? {
                authorize: async () => {
                  throw new DomainError('forbidden');
                },
              }
            : {}),
        }),
      );
      const response = await upload(user, server, new Uint8Array(1), 1, {}, controller.signal);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(/private-token|wings.example|untrusted.example/);
      waiting.resolve(
        Response.json({ attributes: { url: 'https://wings.example.test/upload/file' } }),
      );
      await delay(1);
      expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
      expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
      const audits = (
        await f.db.selectFrom('audit_events').select(['action', 'metadata']).execute()
      ).filter((audit) => (audit.metadata as { serverId?: string }).serverId === server);
      expect(audits.some((audit) => audit.action === 'server.upload.not_dispatched')).toBe(true);
      expect(
        audits.some((audit) =>
          ['server.upload.confirmed', 'server.files.uploaded', 'server.upload.recovered'].includes(
            audit.action,
          ),
        ),
      ).toBe(false);
      expect((await upload(user, server, new Uint8Array(1), 1)).status).toBe(204);
    },
  );

  it.each(['abort', 'synchronous-throw', 'early-success', 'generic-rejected'])(
    'keeps the ingestion claim and blocks the next upload after %s without pre-dispatch proof',
    async (failure) => {
      const server = await f.server();
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
        if (failure === 'synchronous-throw') throw new Error('unknown delivery');
        if (failure === 'early-success')
          return Promise.resolve(new Response(null, { status: 204 }));
        controller.abort();
        return new Promise<Response>(() => {});
      });
      if (failure === 'generic-rejected') {
        uploadFile.mockRejectedValueOnce(new PterodactylError('unavailable', 'client', 'rejected'));
      } else {
        const proxy = createUploadProxy({
          baseURL: 'https://panel.example.test',
          applicationKey: 'isolated-key',
          uploadOrigins: ['https://wings.example.test'],
          fetcher,
        });
        uploadFile.mockImplementationOnce((_id, path, input) =>
          proxy('https://wings.example.test/upload/file', path, {
            ...input,
            // The provider never acknowledges cancellation in this fixture.
            idleTimeoutMs: 50,
          }),
        );
      }
      expect((await upload(user, server, new Uint8Array(1), 1, {}, controller.signal)).status).toBe(
        503,
      );
      if (failure !== 'generic-rejected') expect(fetcher).toHaveBeenCalledOnce();
      expect(
        await f.db
          .selectFrom('upload_ingestion_claims')
          .selectAll()
          .where('server_id', '=', server)
          .execute(),
      ).toHaveLength(1);
      const before = uploadFile.mock.calls.length;
      const blocked = await upload(user, server, new Uint8Array(1), 1);
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).error.code).toBe('operation_uncertain');
      expect(uploadFile.mock.calls).toHaveLength(before);
      if (failure === 'generic-rejected') {
        const sibling = await f.server();
        const hostBlocked = await upload(user, sibling, new Uint8Array(1), 1);
        expect(hostBlocked.status).toBe(409);
        expect((await hostBlocked.json()).error.code).toBe('conflict');
        expect(uploadFile.mock.calls).toHaveLength(before);
      }
      const audits = (
        await f.db.selectFrom('audit_events').select(['action', 'metadata']).execute()
      ).filter((audit) => (audit.metadata as { serverId?: string }).serverId === server);
      expect(
        audits.some((audit) =>
          [
            'server.upload.not_dispatched',
            'server.upload.confirmed',
            'server.files.uploaded',
          ].includes(audit.action),
        ),
      ).toBe(false);
      await recoverFixtureUploads();
    },
  );

  it('allows upload while reconciliation awaits provider I/O outside its short commit lock', async () => {
    const server = await f.server();
    const getRemote = vi.mocked(f.adapter.getApplicationServer);
    const implementation = getRemote.getMockImplementation();
    if (!implementation) throw new Error('Missing isolated provider identity implementation');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    getRemote.mockImplementationOnce(async (id) => {
      entered.resolve();
      await release.promise;
      return implementation(id);
    });
    const reconciliation = reconcileManagedServer(f.db, server, {
      adapter: f.adapter,
      authorizeEffect: async () => {},
    });
    try {
      await entered.promise;
      const before = uploadFile.mock.calls.length;
      const response = await upload(user, server, new Uint8Array(1), 1);
      expect(response.status).toBe(204);
      expect(uploadFile.mock.calls).toHaveLength(before + 1);
      const audits = await f.db
        .selectFrom('audit_events')
        .select('metadata')
        .where('action', '=', 'server.files.requested')
        .execute();
      expect(
        audits.some((audit) => (audit.metadata as { serverId?: string }).serverId === server),
      ).toBe(true);
    } finally {
      release.resolve();
      expect(await reconciliation).toBe('observed');
    }
    const before = uploadFile.mock.calls.length;
    expect((await upload(user, server, new Uint8Array(1), 1)).status).toBe(204);
    expect(uploadFile.mock.calls).toHaveLength(before + 1);
  });

  it('enforces binary upload authentication, current project permissions and origin', async () => {
    const project = await (
      await request(user, '/v1/projects', { name: 'Transfer authorization' })
    ).json();
    const server = await f.server({ projectId: project.id });
    const before = uploadFile.mock.calls.length;
    expect((await upload(null, server, new Uint8Array(1), 1)).status).toBe(401);
    expect((await upload(outsider, server, new Uint8Array(1), 1)).status).toBe(403);
    expect(
      (
        await upload(user, server, new Uint8Array(1), 1, {
          origin: 'https://attacker.example.test',
        })
      ).status,
    ).toBe(403);
    for (const role of ['viewer', 'operator']) {
      expect(
        (
          await request(
            user,
            `/v1/projects/${project.id}/members`,
            { userId: peerId, role },
            { method: 'PUT' },
          )
        ).status,
      ).toBe(204);
      expect((await upload(peer, server, new Uint8Array(1), 1)).status).toBe(403);
    }
    expect(uploadFile.mock.calls.length).toBe(before);
    expect(
      (
        await request(
          user,
          `/v1/projects/${project.id}/members`,
          { userId: peerId, role: 'manager' },
          { method: 'PUT' },
        )
      ).status,
    ).toBe(204);
    expect((await upload(peer, server, new Uint8Array(1), 1)).status).toBe(204);
  });

  it.each(['blocked', 'applying'] as const)(
    'permits only blocked cleanup during a %s storage transition and keeps ordinary writes fenced',
    async (status) => {
      const server = await f.server();
      const transitionId = randomUUID();
      const originalDelete = f.adapter.deleteFiles;
      const deleteFiles = vi.fn<PterodactylAdapter['deleteFiles']>().mockResolvedValue(undefined);
      f.adapter.deleteFiles = deleteFiles;
      const beforeBackups = deleteBackup.mock.calls.length;
      const beforeWrites = writeFile.mock.calls.length;
      const beforeUploads = uploadFile.mock.calls.length;
      const actor = await identity.authenticate(owner.headers());
      await f.db
        .insertInto('storage_policy_transitions')
        .values({
          id: transitionId,
          actor_user_id: actor.context.actorUserId,
          status,
          policy: 'PER_USER_BUDGET',
          previous_policy: 'GLOBAL_POOL',
          default_user_storage_mib: 1024,
          plan: '{}',
        })
        .execute();
      try {
        const deletion = { action: 'delete', root: '', files: ['old.log'], confirm: true };
        const file = await request(user, `/v1/servers/${server}/files`, deletion);
        expect(file.status, await file.clone().text()).toBe(status === 'blocked' ? 204 : 409);
        const backup = await request(
          user,
          `/v1/servers/${server}/backups/${backupId}`,
          { confirm: true },
          { method: 'DELETE' },
        );
        expect(backup.status, await backup.clone().text()).toBe(status === 'blocked' ? 204 : 409);
        expect(deleteFiles).toHaveBeenCalledTimes(status === 'blocked' ? 1 : 0);
        expect(deleteBackup.mock.calls.length - beforeBackups).toBe(status === 'blocked' ? 1 : 0);

        expect(
          (
            await request(user, `/v1/servers/${server}/files`, {
              action: 'write',
              path: 'old.log',
              content: 'blocked write',
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await request(user, `/v1/servers/${server}/files/copy`, {
              root: '',
              files: ['old.log'],
              destination: 'copied',
            })
          ).status,
        ).toBe(409);
        expect((await upload(user, server, new Uint8Array(1), 1)).status).toBe(409);
        expect(writeFile.mock.calls).toHaveLength(beforeWrites);
        expect(uploadFile.mock.calls).toHaveLength(beforeUploads);

        // The cleanup exception never confers access to another user's server.
        const unauthorized = await request(outsider, `/v1/servers/${server}/files`, deletion);
        expect([403, 404]).toContain(unauthorized.status);
        expect(deleteFiles).toHaveBeenCalledTimes(status === 'blocked' ? 1 : 0);
      } finally {
        f.adapter.deleteFiles = originalDelete;
        await f.db
          .deleteFrom('storage_policy_transitions')
          .where('id', '=', transitionId)
          .execute();
      }
    },
  );

  it('uploads singly and in batches with disk=0 while retaining finite declared and provider limits', async () => {
    const server = await f.server({ limits: { ...f.limits, disk: 0 } });
    try {
      expect((await upload(user, server, new Uint8Array(3), 3)).status).toBe(204);
      expect(uploadFile.mock.calls.at(-1)?.[2].maxBytes).toBe(3);
      const batchId = randomUUID();
      const path = 'unlimited-batch.bin';
      const prepared = await request(user, `/v1/servers/${server}/files/upload-batches`, {
        id: batchId,
        files: [{ id: 'file', path, bytes: 2, overwrite: false }],
      });
      expect(prepared.status).toBe(200);
      expect(
        (
          await upload(user, server, new Uint8Array(2), 2, {}, undefined, {
            path,
            batchId,
            entryId: 'file',
            overwrite: 'false',
          })
        ).status,
      ).toBe(204);
      expect(uploadFile.mock.calls.at(-1)?.[2].maxBytes).toBe(2);
      const before = uploadFile.mock.calls.length;
      const host = await f.db
        .selectFrom('physical_hosts')
        .select('upload_policy')
        .where('id', '=', f.hostId)
        .executeTakeFirstOrThrow();
      if (!host.upload_policy) throw new Error('Missing fixture upload policy');
      expect(
        (await upload(user, server, new Uint8Array(1), host.upload_policy.providerMaxFileBytes + 1))
          .status,
      ).toBe(413);
      expect(uploadFile.mock.calls).toHaveLength(before);
    } finally {
      await f.db
        .updateTable('managed_servers')
        .set({ limits: JSON.stringify(f.limits) })
        .where('id', '=', server)
        .execute();
    }
  });

  it('rejects invalid upload declarations, quota violations and lifecycle conflicts before provider writes', async () => {
    const server = await f.server();
    const before = uploadFile.mock.calls.length;
    for (const headers of [
      { 'content-type': 'application/json' },
      { 'x-nh-upload-length': '-1' },
      { 'x-nh-upload-length': 'NaN' },
      { 'content-length': '2' },
      { 'content-encoding': 'gzip' },
    ] as Record<string, string>[])
      expect((await upload(user, server, new Uint8Array(1), 1, headers)).status).toBe(400);
    expect((await upload(user, server, new Uint8Array(1), 65 * 1024 ** 2)).status).toBe(413);
    vi.mocked(f.adapter.getResources).mockResolvedValueOnce({
      current_state: 'offline',
      is_suspended: false,
      resources: {
        memory_bytes: 0,
        cpu_absolute: 0,
        disk_bytes: 64 * 1024 ** 2,
        network_rx_bytes: 0,
        network_tx_bytes: 0,
      },
    });
    expect((await upload(user, server, new Uint8Array(1), 1)).status).toBe(413);
    expect(
      (
        await request(user, `/v1/servers/${server}/operations`, {
          action: 'stop',
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(202);
    const activeOperation = await upload(user, server, new Uint8Array(1), 1);
    expect(activeOperation.status).toBe(409);
    expect((await activeOperation.json()).error.code).toBe('conflict');
    expect(uploadFile.mock.calls.length).toBe(before);
  });

  it('rejects disabled or over-provider uploads without requesting a token or reading browser bytes', async () => {
    const server = await f.server();
    const original = await f.db
      .selectFrom('physical_hosts')
      .selectAll()
      .where('id', '=', f.hostId)
      .executeTakeFirstOrThrow();
    if (!original.upload_policy) throw new Error('Missing isolated upload policy');
    const before = uploadFile.mock.calls.length;
    let reads = 0;
    const source = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads++;
            controller.enqueue(new Uint8Array(2));
          },
        },
        { highWaterMark: 0 },
      );
    try {
      env.NH_UPLOAD_POLICIES = JSON.stringify({ [f.hostId]: null });
      const disabled = await upload(user, server, source(), 2);
      expect(disabled.status).toBe(400);
      expect((await disabled.json()).error.code).toBe('configuration_invalid');
      const policy = { ...original.upload_policy, providerMaxFileBytes: 1 };
      env.NH_UPLOAD_POLICIES = JSON.stringify({ [f.hostId]: policy });
      expect((await upload(user, server, source(), 2)).status).toBe(413);
      const hosts = await request(owner, '/v1/owner/resource-hosts');
      expect(hosts.status).toBe(200);
      expect(await hosts.json()).toEqual([
        expect.objectContaining({ effectiveUploadPolicy: policy, uploadPolicyLocked: true }),
      ]);
      const edit = await request(
        owner,
        '/v1/owner/resource-hosts',
        {
          id: original.id,
          name: original.name,
          memoryLimitMiB: original.memory_limit_mib,
          cpuLimitPercent: original.cpu_limit_percent,
          storagePoolMiB: Number(original.storage_pool_mib),
          memoryHeadroomMiB: original.memory_headroom_mib,
          cpuHeadroomPercent: original.cpu_headroom_percent,
          diskHeadroomMiB: Number(original.disk_headroom_mib),
          localDiskPath: original.local_disk_path,
          observerId: original.observer_id,
          enabled: original.enabled,
          uploadPolicy: policy,
        },
        { method: 'PUT' },
      );
      expect(edit.status).toBe(409);
    } finally {
      delete env.NH_UPLOAD_POLICIES;
    }
    expect(reads).toBe(0);
    expect(uploadFile.mock.calls.length).toBe(before);
    expect(await f.db.selectFrom('upload_ingestion_claims').selectAll().execute()).toEqual([]);
  });

  it('does not use overwrite credit for the temporary multipart and destination copies', async () => {
    const server = await f.server(),
      bytes = 2 * 1024 ** 2;
    const original = await f.db
      .selectFrom('physical_hosts')
      .select('upload_policy')
      .where('id', '=', f.hostId)
      .executeTakeFirstOrThrow();
    if (!original.upload_policy) throw new Error('Missing isolated upload policy');
    env.NH_UPLOAD_POLICIES = JSON.stringify({
      [f.hostId]: { ...original.upload_policy, temporaryDiskBudgetBytes: bytes },
    });
    vi.mocked(f.adapter.getResources).mockResolvedValueOnce({
      current_state: 'offline',
      is_suspended: false,
      resources: {
        memory_bytes: 0,
        cpu_absolute: 0,
        disk_bytes: 64 * 1024 ** 2,
        network_rx_bytes: 0,
        network_tx_bytes: 0,
      },
    });
    vi.mocked(f.adapter.listFiles).mockResolvedValueOnce([
      {
        name: 'world.bin',
        size: bytes,
        mode: '-rw-r--r--',
        is_file: true,
        is_symlink: false,
        mimetype: 'application/octet-stream',
        created_at: new Date().toISOString(),
        modified_at: new Date().toISOString(),
      },
    ]);
    const before = uploadFile.mock.calls.length;
    let reads = 0;
    try {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads++;
            controller.enqueue(new Uint8Array(1));
          },
        },
        { highWaterMark: 0 },
      );
      expect((await upload(user, server, body, bytes)).status).toBe(413);
      expect(reads).toBe(0);
      expect(uploadFile.mock.calls.length).toBe(before);
    } finally {
      delete env.NH_UPLOAD_POLICIES;
    }
  });

  it('never reports success for truncated or excess binary uploads', async () => {
    const server = await f.server();
    for (const actual of [1, 3]) {
      const response = await upload(user, server, new Uint8Array(actual), 2);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(/private-token|wings.example/);
      await recoverFixtureUploads();
    }
    const audits = await f.db
      .selectFrom('audit_events')
      .select('metadata')
      .where('action', '=', 'server.files.uploaded')
      .execute();
    expect(
      audits.some((entry) => (entry.metadata as { serverId: string }).serverId === server),
    ).toBe(false);
  });

  it('names file attachments using only the validated basename with UTF-8 and safe ASCII fallback', async () => {
    const server = await f.server();
    for (const [path, expected] of [
      ['world/server.jar', 'filename="server.jar"; filename*=UTF-8\'\'server.jar'],
      [
        'world/World notes 2026.txt',
        'filename="World notes 2026.txt"; filename*=UTF-8\'\'World%20notes%202026.txt',
      ],
      [
        'world/Città 日本語.txt',
        'filename="Citt_ ___.txt"; filename*=UTF-8\'\'Citt%C3%A0%20%E6%97%A5%E6%9C%AC%E8%AA%9E.txt',
      ],
      [
        'world/notes "owner\'s" (1)*.txt',
        "filename=\"notes _owner's_ (1)*.txt\"; filename*=UTF-8''notes%20%22owner%27s%22%20%281%29%2A.txt",
      ],
    ] as const) {
      const file = await request(
        user,
        `/v1/servers/${server}/files/content?path=${encodeURIComponent(path)}`,
      );
      expect(file.status).toBe(200);
      expect(file.headers.get('content-disposition')).toBe(`attachment; ${expected}`);
      expect(await file.text()).toBe('fixture-data');
      expect(vi.mocked(f.adapter.downloadFile).mock.lastCall?.[1]).toBe(path);
    }
    const calls = vi.mocked(f.adapter.downloadFile).mock.calls.length;
    for (const path of ['', 'world/', '../secret.txt', 'world\\secret.txt', 'bad\r\nX-Evil: yes']) {
      const file = await request(
        user,
        `/v1/servers/${server}/files/content?path=${encodeURIComponent(path)}`,
      );
      expect(file.status).toBe(400);
      expect(file.headers.get('content-disposition')).toBeNull();
      expect(file.headers.get('x-evil')).toBeNull();
    }
    expect(vi.mocked(f.adapter.downloadFile).mock.calls.length).toBe(calls);
  });

  it.each(['file', 'backup'])(
    'ends an established %s download when the real session is revoked',
    async (kind) => {
      const server = await f.server();
      const sessions = await f.db
        .selectFrom('session')
        .selectAll()
        .where('userId', '=', userId)
        .execute();
      let cancelled = false;
      const proxy = createDownloadProxy({
        baseURL: 'https://panel.example.test',
        applicationKey: 'isolated-key',
        fetcher: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      });
      const method = kind === 'file' ? f.adapter.downloadFile : f.adapter.downloadBackup;
      vi.mocked(method).mockImplementationOnce(async (_id, _path, input) =>
        proxy('https://panel.example.test/file?token=private', {
          ...input,
          authorizationIntervalMs: 10,
        }),
      );
      try {
        const response = await request(
          user,
          `/v1/servers/${server}/${kind === 'file' ? 'files/content?path=world.bin' : `backups/${backupId}/download`}`,
        );
        expect(response.status).toBe(200);
        const reader = response.body?.getReader();
        expect((await reader?.read())?.value).toEqual(new Uint8Array([1]));
        await f.db.deleteFrom('session').where('userId', '=', userId).execute();
        await expect(reader?.read()).rejects.toMatchObject({ reason: 'unavailable' });
        expect(cancelled).toBe(true);
      } finally {
        await f.db.insertInto('session').values(sessions).execute();
      }
    },
  );

  it('revokes a streaming upload after a real session expires and retains the lifecycle lock until it ends', async () => {
    const server = await f.server();
    const sessions = await f.db
      .selectFrom('session')
      .selectAll()
      .where('userId', '=', userId)
      .execute();
    let cancelled = false,
      expired = false;
    const source = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (expired) return new Promise<void>(() => {});
          expired = true;
          await delay(20);
          await f.db
            .updateTable('session')
            .set({ expiresAt: new Date(0) })
            .where('userId', '=', userId)
            .execute();
          if (!cancelled) controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    try {
      const response = await upload(user, server, source, 1024 ** 2);
      expect(response.status).toBe(503);
      expect(cancelled).toBe(true);
      expect(await response.text()).not.toContain('private-token');
    } finally {
      for (const session of sessions)
        await f.db
          .updateTable('session')
          .set({ expiresAt: session.expiresAt })
          .where('id', '=', session.id)
          .execute();
    }
    // Ambiguous uploads retain their ingestion claim until the Owner verifies cleanup.
    const blocked = await request(user, `/v1/servers/${server}/files`, {
      action: 'write',
      path: 'fixture',
      content: 'not-before-review',
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe('operation_uncertain');
    await recoverFixtureUploads();
    // A subsequent write can take the same server lock after reviewed fixture cleanup.
    expect(
      (
        await request(user, `/v1/servers/${server}/files`, {
          action: 'write',
          path: 'fixture',
          content: 'after-cancel',
        })
      ).status,
    ).toBe(204);
  });

  it('reserves pool capacity for logout and reads across distinct-server uploads and app instances', async () => {
    const first = await f.server(),
      second = await f.server();
    const small = createDatabase(process.env.NH_TEST_DATABASE_URL ?? '', {
      max: 2,
      options: `-c search_path=${database.schema}`,
    });
    const identity = createIdentity({
      secretCodec: codec,
      pool: small.pool,
      baseURL: origin,
      authSecret: randomBytes(32).toString('base64url'),
      mail: async () => {},
      completeSetup: async () => {},
    });
    const client = new AuthClient(identity);
    expect(
      (await client.request('/sign-in/email', { email: 'servers-user@example.test', password }))
        .status,
    ).toBe(200);
    const settings = {
      database: small,
      env,
      identity: async () => identity,
      codec,
      origins: [origin],
      management: () => createManagementRuntime({ db: small.db, codec, adapter: f.adapter, env }),
    };
    const primary = createApp(settings),
      sibling = createApp(settings);
    const entered = Promise.withResolvers<void>();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await delay(5);
          if (!cancelled) {
            entered.resolve();
            controller.enqueue(new Uint8Array(1024));
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const uploadHeaders = client.headers();
    uploadHeaders.set('content-type', 'application/octet-stream');
    uploadHeaders.set('x-nh-upload-length', String(1024 ** 2));
    const init: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      headers: uploadHeaders,
      body: source,
      duplex: 'half',
    };
    const inProgress = primary.request(
      `${origin}/v1/servers/${first}/files/upload?path=world.bin`,
      init,
    );
    try {
      await Promise.race([
        entered.promise,
        Promise.resolve(inProgress).then(async (response) => {
          throw new Error(
            `Upload ended before first byte: ${response.status} ${await response.text()}`,
          );
        }),
      ]);
      const claimsResponse = await request(owner, '/v1/owner/uploads');
      expect(claimsResponse.status).toBe(200);
      const claims = (await claimsResponse.json()) as { id: string; scope_hash: string }[];
      expect(claims).toHaveLength(1);
      const claim = claims[0];
      if (!claim) throw new Error('Missing active claim');
      const recovery = {
        confirm: true,
        remoteTransferFinished: true,
        temporaryFilesRemoved: true,
        scopeHash: claim.scope_hash,
        reason: 'Isolated recovery must wait',
        evidence: 'The fixture upload is active, so this request must be refused.',
      };
      expect((await request(user, '/v1/owner/uploads')).status).toBe(403);
      expect((await request(user, `/v1/owner/uploads/${claim.id}/recover`, recovery)).status).toBe(
        403,
      );
      expect((await request(owner, `/v1/owner/uploads/${claim.id}/recover`, recovery)).status).toBe(
        409,
      );
      const beforeContenders = uploadFile.mock.calls.length;
      const anonymous = await sibling.request(
        `${origin}/v1/servers/${second}/files/upload?path=world.bin`,
        {
          method: 'PUT',
          headers: {
            origin,
            'content-type': 'application/octet-stream',
            'x-nh-upload-length': '1',
          },
          body: new Uint8Array(1),
        },
      );
      expect(anonymous.status).toBe(401);
      expect((await anonymous.json()).error.code).toBe('unauthenticated');
      const contenders = await Promise.all(
        Array.from({ length: 8 }, (_, index) => {
          const headers = client.headers();
          headers.set('content-type', 'application/octet-stream');
          headers.set('x-nh-upload-length', '1');
          return (index % 2 ? primary : sibling).request(
            `${origin}/v1/servers/${index % 2 ? first : second}/files/upload?path=world.bin`,
            { method: 'PUT', headers, body: new Uint8Array(1) },
          );
        }),
      );
      expect(contenders.map((response) => response.status)).toEqual(Array(8).fill(409));
      expect(
        await Promise.all(contenders.map(async (response) => (await response.json()).error.code)),
      ).toEqual(Array(8).fill('operation_busy'));
      expect(uploadFile.mock.calls).toHaveLength(beforeContenders);
      const jsonHeaders = client.headers();
      jsonHeaders.set('content-type', 'application/json');
      // Batch preparation must leave the same pool headroom as binary transfers.
      const preparation = await sibling.request(
        `${origin}/v1/servers/${second}/files/upload-batches`,
        {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({
            id: randomUUID(),
            files: [{ id: 'one', path: 'one.txt', bytes: 1, overwrite: true }],
          }),
        },
      );
      expect(preparation.status).toBe(409);
      expect((await preparation.json()).error.code).toBe('operation_busy');
      const write = await sibling.request(`${origin}/v1/servers/${first}/files`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ action: 'write', path: 'fixture', content: 'must-not-wait' }),
      });
      expect(write.status).toBe(409);
      expect((await write.json()).error.code).toBe('operation_busy');
      const read = await sibling.request(`${origin}/v1/servers/${second}/files`, {
        headers: client.headers(),
      });
      expect(read.status).toBe(200);
      const logout = await sibling.request(`${origin}/api/auth/sign-out`, {
        method: 'POST',
        headers: jsonHeaders,
        body: '{}',
      });
      expect(logout.status).toBe(200);
      expect((await inProgress).status).toBe(503);
      expect(cancelled).toBe(true);
      await recoverFixtureUploads();
      expect(
        (await client.request('/sign-in/email', { email: 'servers-user@example.test', password }))
          .status,
      ).toBe(200);
      const headers = client.headers();
      headers.set('content-type', 'application/octet-stream');
      headers.set('x-nh-upload-length', '1');
      expect(
        (
          await sibling.request(`${origin}/v1/servers/${second}/files/upload?path=world.bin`, {
            method: 'PUT',
            headers,
            body: new Uint8Array(1),
          })
        ).status,
      ).toBe(204);
    } finally {
      const current = await identity.authenticate(client.headers()).catch(() => null);
      if (current)
        await small.db.deleteFrom('session').where('id', '=', current.sessionId).execute();
      await inProgress;
      await small.db.destroy();
    }
  });

  it('reuses only the current session console relay and never replays uncertain dispatch', async () => {
    sendCommand.mockClear();
    const serverId = await f.server();
    let input: ConsoleRelayOptions | undefined;
    const dispatched = vi.fn(async () => {
      if (!(await input?.authorizeCommand?.())) throw new DomainError('forbidden');
    });
    vi.mocked(f.adapter.relayConsole).mockImplementationOnce(async (_id, options) => {
      input = options;
      options.onEvent({ type: 'status', data: 'running' });
      return {
        close: vi.fn(),
        sendCommand: dispatched,
        requestLogs: async () => {},
        requestStats: async () => {},
      };
    });
    const response = await request(user, `/v1/servers/${serverId}/console`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing console stream');
    try {
      let events = '';
      while (!events.includes('event: connected'))
        events += new TextDecoder().decode((await reader.read()).value);
      expect(input?.canSendCommands).toBe(true);
      expect(
        (await request(user, `/v1/servers/${serverId}/console`, { command: 'list' })).status,
      ).toBe(204);
      expect(dispatched).toHaveBeenCalledWith('list');
      expect(sendCommand).not.toHaveBeenCalled();
      // Another authorized identity must never borrow this user's authenticated transport.
      expect(
        (await request(owner, `/v1/servers/${serverId}/console`, { command: 'list' })).status,
      ).toBe(204);
      expect(sendCommand).toHaveBeenCalledOnce();
      dispatched.mockRejectedValueOnce(new DomainError('integration_unavailable'));
      expect(
        (await request(user, `/v1/servers/${serverId}/console`, { command: 'say fixture' })).status,
      ).toBe(503);
      expect(sendCommand).toHaveBeenCalledOnce();
      // Current ownership is still checked before any send, including through a retained socket.
      await f.db
        .updateTable('managed_servers')
        .set({ owner_id: outsiderId })
        .where('id', '=', serverId)
        .execute();
      expect(
        (await request(user, `/v1/servers/${serverId}/console`, { command: 'list' })).status,
      ).toBe(403);
      expect(dispatched).toHaveBeenCalledTimes(2);
      await f.db
        .updateTable('managed_servers')
        .set({ owner_id: userId })
        .where('id', '=', serverId)
        .execute();
      input?.onEvent({ type: 'closed' });
      while (!(await reader.read()).done) {}
      expect(
        (await request(user, `/v1/servers/${serverId}/console`, { command: 'list' })).status,
      ).toBe(204);
      expect(sendCommand).toHaveBeenCalledTimes(2);
    } finally {
      await reader.cancel();
    }
  });

  it('closes a console relay when its provider credential rotates during connection', async () => {
    const serverId = await f.server();
    let binding = 'credential-before-connect';
    const bindingSpy = vi
      .spyOn(runtime, 'consoleBindingForServer')
      .mockImplementation(async () => binding);
    const close = vi.fn();
    const dispatch = vi.fn(async () => {});
    const history = vi.fn(async () => {});
    vi.mocked(f.adapter.relayConsole).mockImplementationOnce(async () => {
      binding = 'credential-after-connect';
      return { close, sendCommand: dispatch, requestLogs: history, requestStats: async () => {} };
    });
    try {
      const response = await request(user, `/v1/servers/${serverId}/console`);
      const events = await response.text();
      expect(events).toContain('integration_unavailable');
      expect(events).not.toContain('event: connected');
      expect(close).toHaveBeenCalledOnce();
      expect(history).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      sendCommand.mockClear();
      expect(
        (await request(user, `/v1/servers/${serverId}/console`, { command: 'list' })).status,
      ).toBe(204);
      expect(sendCommand).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      bindingSpy.mockRestore();
    }
  });

  it('closes a newly opened console if credential lookup becomes unavailable', async () => {
    const serverId = await f.server();
    const bindingSpy = vi
      .spyOn(runtime, 'consoleBindingForServer')
      .mockResolvedValueOnce('credential-before-connect')
      .mockRejectedValue(new DomainError('integration_unavailable'));
    const close = vi.fn();
    const history = vi.fn(async () => {});
    vi.mocked(f.adapter.relayConsole).mockImplementationOnce(async () => ({
      close,
      sendCommand: async () => {},
      requestLogs: history,
      requestStats: async () => {},
    }));
    try {
      const response = await request(user, `/v1/servers/${serverId}/console`);
      const events = await response.text();
      expect(events).toContain('integration_unavailable');
      expect(events).not.toContain('event: connected');
      expect(close).toHaveBeenCalledOnce();
      expect(history).not.toHaveBeenCalled();
    } finally {
      bindingSpy.mockRestore();
    }
  });

  it('rejects retained console authorization and command reuse after provider key rotation', async () => {
    const serverId = await f.server();
    let binding = 'credential-current';
    const bindingSpy = vi
      .spyOn(runtime, 'consoleBindingForServer')
      .mockImplementation(async () => binding);
    let input: ConsoleRelayOptions | undefined;
    const dispatch = vi.fn(async () => {});
    vi.mocked(f.adapter.relayConsole).mockImplementationOnce(async (_id, options) => {
      input = options;
      return {
        close: vi.fn(),
        sendCommand: dispatch,
        requestLogs: async () => {},
        requestStats: async () => {},
      };
    });
    const response = await request(user, `/v1/servers/${serverId}/console`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing console stream');
    try {
      let events = '';
      while (!events.includes('event: connected'))
        events += new TextDecoder().decode((await reader.read()).value);
      expect(await input?.authorize()).toBe(true);
      expect(await input?.authorizeCommand?.()).toBe(true);
      binding = 'credential-rotated';
      expect(await input?.authorize()).toBe(false);
      expect(await input?.authorizeCommand?.()).toBe(false);
      sendCommand.mockClear();
      expect(
        (await request(user, `/v1/servers/${serverId}/console`, { command: 'list' })).status,
      ).toBe(204);
      expect(dispatch).not.toHaveBeenCalled();
      expect(sendCommand).toHaveBeenCalledOnce();
    } finally {
      input?.onEvent({ type: 'closed' });
      await reader.cancel();
      bindingSpy.mockRestore();
    }
  });

  it('keeps an idle console HTTP connection alive and closes it on authorization loss', async () => {
    const serverId = await f.server();
    let relayInput: ConsoleRelayOptions | undefined;
    const close = vi.fn();
    vi.mocked(f.adapter.relayConsole).mockImplementationOnce(async (_id, input) => {
      relayInput = input;
      expect(await input.authorize()).toBe(true);
      input.onEvent({ type: 'status', data: 'offline' });
      return {
        close,
        sendCommand: async () => {},
        requestLogs: async () => {},
        requestStats: async () => {},
      };
    });
    const interval = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const server = createServer(getRequestListener(app.fetch));
    // Shorter than production's 30 seconds, longer than the real heartbeat.
    server.setTimeout(12000);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/servers/${serverId}/console`,
        { headers: user.headers() },
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing console stream');
      let text = '';
      // Two real heartbeats prove the connection survives an otherwise fatal idle timeout.
      while ((text.match(/event: heartbeat/g) ?? []).length < 2) {
        const next = await reader.read();
        expect(next.done).toBe(false);
        text += new TextDecoder().decode(next.value);
      }
      expect(text.match(/event: status/g)).toHaveLength(1);
      expect(text).not.toContain('event: error');
      await f.db
        .updateTable('managed_servers')
        .set({ owner_id: outsiderId })
        .where('id', '=', serverId)
        .execute();
      expect(await relayInput?.authorize()).toBe(false);
      relayInput?.onEvent({ type: 'closed' });
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += new TextDecoder().decode(next.value);
      }
      expect(text).toContain('{"type":"error","code":"forbidden"}');
      expect(close).toHaveBeenCalledOnce();
      const heartbeatIndex = interval.mock.calls.findIndex((call) => call[1] === 10000);
      expect(heartbeatIndex).toBeGreaterThanOrEqual(0);
      expect(clear).toHaveBeenCalledWith(interval.mock.results[heartbeatIndex]?.value);
    } finally {
      interval.mockRestore();
      clear.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Two 10-second heartbeats already consume the default 20-second test budget.
  }, 30000);

  it('streams binary uploads and downloads through the actual Node/Hono HTTP bridge', async () => {
    const serverId = await f.server();
    const binary = new Uint8Array(2 * 1024 ** 2 + 11).fill(0xa5);
    const server = createServer(getRequestListener(app.fetch));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const base = `http://127.0.0.1:${address.port}/v1/servers/${serverId}`;
    vi.mocked(f.adapter.downloadFile).mockImplementationOnce(async (_id, _path, input) =>
      createDownloadProxy({
        baseURL: 'https://panel.example.test',
        applicationKey: 'isolated-key',
        fetcher: async () =>
          new Response(binary, { headers: { 'Content-Length': String(binary.length) } }),
      })('https://panel.example.test/file?token=private', input),
    );
    try {
      const headers = user.headers();
      headers.set('content-type', 'application/octet-stream');
      headers.set('x-nh-upload-length', String(binary.length));
      const uploaded = await fetch(`${base}/files/upload?path=world.bin`, {
        method: 'PUT',
        headers,
        body: binary,
      });
      expect(uploaded.status).toBe(204);
      const downloaded = await fetch(`${base}/files/content?path=world.bin`, {
        headers: user.headers(),
      });
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-length')).toBe(String(binary.length));
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(Buffer.from(binary));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('settles two cancelled HTTP uploads after multipart rejection and accepts another batch', async () => {
    const serverId = await f.server();
    const batchId = randomUUID();
    const paths = ['cancel-a.bin', 'cancel-b.bin'];
    const controllers = paths.map(() => new AbortController());
    const original = uploadFile.getMockImplementation();
    let entered = 0;
    let writes = 0;
    const proxy = createUploadProxy({
      baseURL: 'https://panel.example.test',
      applicationKey: 'isolated-key',
      uploadOrigins: ['https://wings.example.test'],
      fetcher: async (_url, init) => {
        entered++;
        try {
          await new Request('https://wings.example.test/upload/file', {
            ...init,
            duplex: 'half',
          } as RequestInit).formData();
        } catch {
          return Response.json(
            { error: 'Failed to get multipart form data from request.' },
            { status: 400 },
          );
        }
        writes++;
        return new Response(null, { status: 204 });
      },
    });
    uploadFile.mockImplementation((_id, path, input) =>
      proxy('https://wings.example.test/upload/file', path, input),
    );
    const server = createServer(getRequestListener(app.fetch));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const statusPath = `/v1/servers/${serverId}/files/upload-batches/${batchId}`;
    const pending: Promise<unknown>[] = [];
    try {
      expect(
        (
          await request(user, `/v1/servers/${serverId}/files/upload-batches`, {
            id: batchId,
            files: paths.map((path, index) => ({
              id: String(index),
              path,
              bytes: 1024 ** 2,
              overwrite: false,
            })),
          })
        ).status,
      ).toBe(200);
      expect((await request(outsider, statusPath)).status).toBe(403);
      for (const [index, path] of paths.entries()) {
        const headers = user.headers();
        headers.set('content-type', 'application/octet-stream');
        headers.set('x-nh-upload-length', String(1024 ** 2));
        pending.push(
          fetch(
            `http://127.0.0.1:${address.port}/v1/servers/${serverId}/files/upload?path=${path}&batchId=${batchId}&entryId=${index}&overwrite=false`,
            {
              method: 'PUT',
              headers,
              signal: controllers[index]?.signal,
              duplex: 'half',
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(1024));
                },
              }),
            } as RequestInit,
          ).catch(() => undefined),
        );
      }
      await vi.waitFor(() => expect(entered).toBe(2));
      expect((await (await request(user, statusPath)).json()).files).toEqual([
        { id: '0', state: 'active' },
        { id: '1', state: 'active' },
      ]);
      for (const controller of controllers) controller.abort();
      await Promise.all(pending);
      await vi.waitFor(
        async () => {
          expect(await (await request(user, statusPath)).json()).toEqual({
            closed: true,
            files: [],
          });
        },
        { timeout: 3000 },
      );
      expect(writes).toBe(0);
      const audits = await f.db
        .selectFrom('audit_events')
        .select('action')
        .where('metadata', '@>', { claimId: batchId })
        .execute();
      expect(audits.filter((event) => event.action === 'server.upload.cancelled')).toHaveLength(2);
      expect(audits.some((event) => event.action === 'server.upload.uncertain')).toBe(false);
      const nextId = randomUUID();
      expect(
        (
          await request(user, `/v1/servers/${serverId}/files/upload-batches`, {
            id: nextId,
            files: [{ id: 'next', path: 'next.bin', bytes: 1, overwrite: false }],
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await upload(user, serverId, new Uint8Array(1), 1, {}, undefined, {
            batchId: nextId,
            entryId: 'next',
            path: 'next.bin',
            overwrite: 'false',
          })
        ).status,
      ).toBe(204);
      expect(writes).toBe(1);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(pending);
      if (original) uploadFile.mockImplementation(original);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('propagates a real browser HTTP disconnect through Hono to the provider stream', async () => {
    const serverId = await f.server();
    let cancelled = false;
    const server = createServer(getRequestListener(app.fetch));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    vi.mocked(f.adapter.downloadFile).mockImplementationOnce(async (_id, _path, input) =>
      createDownloadProxy({
        baseURL: 'https://panel.example.test',
        applicationKey: 'isolated-key',
        fetcher: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(64 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      })('https://panel.example.test/file?token=private', input),
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/servers/${serverId}/files/content?path=world.bin`,
        { headers: user.headers() },
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      await reader?.read();
      await reader?.cancel();
      await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 1000 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('filters visibility before list pagination even with many newer unrelated servers', async () => {
    const server = await f.server();
    await database.pool.query(
      `INSERT INTO managed_servers(id,owner_id,mapping_id,node_id,name,external_id,limits,created_at)
      SELECT id,$1,$2,$3,'pagination-fixture','nh-'||id::text,$4::jsonb,now()+interval '1 day'
      FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,1001)) fixture`,
      [outsiderId, f.mappingId, f.nodeId, JSON.stringify(f.limits)],
    );
    try {
      const response = await request(user, '/v1/servers');
      expect(response.status).toBe(200);
      const visible = await response.json();
      expect(visible.some((entry: { id: string }) => entry.id === server)).toBe(true);
      expect(visible.every((entry: { ownerId: string }) => entry.ownerId === userId)).toBe(true);
    } finally {
      await f.db.deleteFrom('managed_servers').where('name', '=', 'pagination-fixture').execute();
    }
  });
  it.each(['regular-logout', 'support-revoked', 'support-parent-logout', 'owner-demoted'] as const)(
    'denies an HTTP file mutation after %s during provider verification without issuing writes',
    async (reason) => {
      const server = await f.server();
      const client = new AuthClient(owner.identity);
      const email =
        reason === 'regular-logout' ? 'servers-user@example.test' : 'servers-owner@example.test';
      expect((await request(client, '/api/auth/sign-in/email', { email, password })).status).toBe(
        200,
      );
      let supportToken: string | undefined, supportId: string | undefined;
      if (reason.startsWith('support')) {
        const proof = await (await request(client, '/v1/identity/step-up', { password })).json();
        const opened = await request(client, '/v1/support', {
          stepUpToken: proof.token,
          subjectUserId: userId,
          reason: 'Queued mutation revocation test',
        });
        expect(opened.status).toBe(201);
        const support = await opened.json();
        supportToken = support.token;
        supportId = support.id;
      }
      const authenticated = await client.identity.authenticate(client.headers(), supportToken);
      expect(authenticated.context[authSessionId]).toBe(authenticated.sessionId);
      const headers = supportToken ? { 'x-nh-support-token': supportToken } : undefined;
      const me = await request(client, '/v1/me', undefined, { headers });
      expect(await me.text()).not.toContain(authenticated.sessionId);
      const before = writeFile.mock.calls.length;
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const original = vi.mocked(f.adapter.getApplicationServer).getMockImplementation();
      if (!original) throw new Error('Missing identity fixture');
      vi.mocked(f.adapter.getApplicationServer).mockImplementationOnce(async (id) => {
        entered.resolve();
        await release.promise;
        return original(id);
      });
      const response = request(
        client,
        `/v1/servers/${server}/files`,
        { action: 'write', path: 'fixture', content: 'must-never-write' },
        { headers },
      );
      try {
        await entered.promise;
        if (reason === 'regular-logout' || reason === 'support-parent-logout')
          await database.pool.query('DELETE FROM session WHERE id=$1', [authenticated.sessionId]);
        else if (reason === 'support-revoked')
          await database.pool.query('UPDATE support_sessions SET revoked_at=now() WHERE id=$1', [
            supportId,
          ]);
        else
          await f.db
            .updateTable('user')
            .set({ role: 'user' })
            .where('id', '=', authenticated.context.actorUserId)
            .execute();
      } finally {
        release.resolve();
      }
      try {
        const result = await response;
        expect(result?.status).toBe(reason.includes('logout') ? 401 : 403);
        expect(writeFile.mock.calls.length).toBe(before);
      } finally {
        if (reason === 'owner-demoted')
          await f.db
            .updateTable('user')
            .set({ role: 'owner' })
            .where('id', '=', authenticated.context.actorUserId)
            .execute();
      }
    },
  );
  it('rechecks logout occurring during remote identity corroboration before a file write', async () => {
    const server = await f.server(),
      client = new AuthClient(user.identity);
    expect(
      (
        await request(client, '/api/auth/sign-in/email', {
          email: 'servers-user@example.test',
          password,
        })
      ).status,
    ).toBe(200);
    const { sessionId } = await client.identity.authenticate(client.headers());
    const readRemote = vi.mocked(f.adapter.getApplicationServer).getMockImplementation();
    if (!readRemote) throw new Error('Missing remote fixture');
    vi.mocked(f.adapter.getApplicationServer).mockImplementationOnce(async (id) => {
      await database.pool.query('DELETE FROM session WHERE id=$1', [sessionId]);
      return readRemote(id);
    });
    const before = writeFile.mock.calls.length;
    const response = await request(client, `/v1/servers/${server}/files`, {
      action: 'write',
      path: 'fixture',
      content: 'must-never-write',
    });
    expect(response.status).toBe(401);
    expect(writeFile.mock.calls.length).toBe(before);
  });
});
