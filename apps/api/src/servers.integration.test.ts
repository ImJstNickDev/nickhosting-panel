import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getRequestListener } from '@hono/node-server';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { authSessionId, SecretCodec } from '@nickhosting/core';
import { createDatabase } from '@nickhosting/database';
import { createTestDatabase } from '@nickhosting/database/testing';
import type { ConsoleRelayOptions, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { createManagementRuntime } from '@nickhosting/server-management';
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
  let runtime: Awaited<ReturnType<typeof createManagementRuntime>>;
  let owner: AuthClient, user: AuthClient, peer: AuthClient, outsider: AuthClient;
  let userId: string, peerId: string, outsiderId: string;
  const env: Record<string, string | undefined> = {};
  const origin = 'http://localhost:3999';
  const password = 'Isolated-API-password-593!';
  const mails: IdentityMail[] = [],
    logs: unknown[] = [];
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
    };
    return app.request(`${origin}/v1/servers/${server}/files/upload?path=world.bin`, init);
  }
  const relayClose = vi.fn();
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
    await f.db.deleteFrom('user').where('id', '=', f.owner.actorUserId).execute();
    const bootstrapToken = randomBytes(32).toString('base64url');
    const identity = createIdentity({
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
      downloadFile: vi.fn(async (_id, _path, input) =>
        createDownloadProxy({
          baseURL: 'https://panel.example.test',
          applicationKey: 'isolated-key',
          fetcher: async () => new Response('fixture-data'),
        })('https://panel.example.test/file?token=private-fixture', input),
      ),
      uploadFile,
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
          requestLogs: async () => {},
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
      revokeCredential: async () => {},
    });
    app = createApp({
      database,
      identity: async () => identity,
      codec,
      origins: [origin],
      env,
      management: async () => runtime,
      log: (entry) => logs.push(entry),
    });
    expect(
      (
        await request(owner, '/v1/setup/owner', {
          token: bootstrapToken,
          name: 'Owner',
          email: 'servers-owner@example.test',
          password,
        })
      ).status,
    ).toBe(201);
    await verify(owner, 'servers-owner@example.test');
    userId = await invited(user, 'servers-user@example.test');
    peerId = await invited(peer, 'servers-peer@example.test');
    outsiderId = await invited(outsider, 'servers-outsider@example.test');
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
      const create = await request(user, '/v1/servers', f.input());
      expect(create.status).toBe(409);
      expect((await create.json()).error.code).toBe('allocation_unavailable');
      expect(await f.db.selectFrom('managed_servers').select('id').execute()).toEqual([]);
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
  it('creates durable operations over HTTP, validates confirmation and origin, and exposes safe history', async () => {
    const input = f.input();
    const rejected = await request(user, '/v1/servers', input, {
      headers: { origin: 'https://attacker.example.test' },
    });
    expect(rejected.status).toBe(403);
    expect(await f.db.selectFrom('managed_servers').select('id').execute()).toEqual([]);
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
    for (const response of [file, backup]) {
      expect(response.headers.get('content-disposition')).toBe('attachment');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const console = await request(user, `/v1/servers/${server}/console`);
    expect(console.status).toBe(200);
    const events = await console.text();
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
    expect(output).not.toContain(providerSecret);
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
  it('protects Minecraft launch inputs in every browser mutation without blocking worlds or mods', async () => {
    const server = await f.server();
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
        mapping_id: f.mappingId,
        combination: '{}',
        resolved_runtime: '{}',
        binding: JSON.stringify(binding),
        mapping_digest: 'a'.repeat(64),
        identity_digest: 'b'.repeat(64),
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
    expect((await upload(user, server, new Uint8Array(1), 1)).status).toBe(409);
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
      const jsonHeaders = client.headers();
      jsonHeaders.set('content-type', 'application/json');
      const write = await sibling.request(`${origin}/v1/servers/${first}/files`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ action: 'write', path: 'fixture', content: 'must-not-wait' }),
      });
      expect(write.status).toBe(409);
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
