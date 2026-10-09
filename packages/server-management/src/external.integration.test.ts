import { randomBytes, randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { CloudflareDnsProvider, SftpGoAdapter } from '@nickhosting/external-services';
import type { GameManifest } from '@nickhosting/game-sdk';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assignServerDns,
  cleanupServerExternalServices,
  createSftpCredential,
  deleteServerDns,
  type ExternalServiceOptions,
  listServerDns,
  listSftpCredentials,
  previewServerDns,
  reconcileExternalServices,
  revokeSftpCredential,
  rotateSftpCredential,
  updateServerDns,
} from './external.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let sequence = 0;
beforeEach(async () => {
  database = await createTestDatabase();
});
afterEach(async () => {
  await database?.destroy();
});
async function fixture(mode: 'custom-subdomain' | 'static-host-port' = 'custom-subdomain') {
  const db = database.db;
  const userId = randomUUID(),
    otherId = randomUUID(),
    hostId = randomUUID(),
    nodeId = randomUUID(),
    mappingId = randomUUID(),
    serverId = randomUUID(),
    instanceId = randomUUID();
  const number = ++sequence;
  await sql`insert into "user"(id,name,email,role) values(${userId},'fixture',${`${userId}@example.test`},'user'),(${otherId},'other',${`${otherId}@example.test`},'user')`.execute(
    db,
  );
  const context: AuthContext = {
    [authSessionId]: randomUUID(),
    actorUserId: userId,
    subjectUserId: userId,
    role: 'user',
    sessionType: 'regular',
    ownerElevation: false,
  };
  const other: AuthContext = {
    ...context,
    [authSessionId]: randomUUID(),
    actorUserId: otherId,
    subjectUserId: otherId,
  };
  for (const actor of [context, other])
    await database.pool.query(
      'INSERT INTO session(id,token,"userId","expiresAt") VALUES($1,$2,$3,now()+interval \'1 day\')',
      [actor[authSessionId], randomUUID(), actor.actorUserId],
    );
  const manifest: GameManifest = {
    id: `fixture-${number}`,
    version: '1.0.0',
    nameKey: `games.fixture-${number}.name`,
    capabilities: {
      console: true,
      files: true,
      backups: false,
      players: false,
      mods: false,
      worlds: false,
      idleDetection: false,
      gracefulStop: false,
      readiness: false,
      wake: 'unsupported',
    },
    connection:
      mode === 'custom-subdomain'
        ? { mode, zoneSettingKey: 'dnsBaseDomain', srv: { service: '_fixture', proto: 'tcp' } }
        : { mode, hostnameSettingKey: 'staticGameHostname', showPort: true },
    ports: [{ role: 'game', transport: 'tcp', required: true }],
    runtimes: [
      {
        id: 'fixture',
        nameKey: `games.fixture-${number}.runtime`,
        supportedGameVersions: [],
        supports: {},
      },
    ],
    wizard: { steps: [] },
    management: [],
    contentProviders: [],
    localizations: { namespace: `games.fixture-${number}`, locales: ['en', 'it'] },
  };
  await db
    .insertInto('game_integrations')
    .values({ id: manifest.id, version: manifest.version, manifest })
    .execute();
  await db
    .insertInto('physical_hosts')
    .values({
      id: hostId,
      name: 'isolated',
      memory_limit_mib: 2048,
      cpu_limit_percent: 200,
      storage_pool_mib: '10000',
      memory_headroom_mib: 256,
      cpu_headroom_percent: 20,
      disk_headroom_mib: '100',
      local_disk_path: 'fixture',
      observer_id: 'fixture',
    })
    .execute();
  await db
    .insertInto('managed_nodes')
    .values({
      id: nodeId,
      physical_host_id: hostId,
      pterodactyl_node_id: number,
      provision_user_id: 1,
    })
    .execute();
  await db
    .insertInto('runtime_egg_mappings')
    .values({
      id: mappingId,
      game_id: manifest.id,
      runtime_id: 'fixture',
      node_id: nodeId,
      nest_id: 1,
      egg_id: 1,
      docker_image: 'fixture/image:1',
      startup: 'fixture',
      environment: '{}',
      port_roles: JSON.stringify([{ role: 'game', protocols: ['tcp'], primary: true }]),
      feature_limits: JSON.stringify({ databases: 0, allocations: 1, backups: 0 }),
    })
    .execute();
  await db
    .insertInto('managed_servers')
    .values({
      id: serverId,
      owner_id: userId,
      project_id: null,
      mapping_id: mappingId,
      node_id: nodeId,
      name: 'fixture',
      external_id: `nh-${serverId}`,
      pterodactyl_id: number,
      pterodactyl_uuid: randomUUID(),
      pterodactyl_identifier: serverId.slice(0, 8),
      limits: JSON.stringify({ memory: 128, cpu: 10, disk: 64, swap: 0, io: 500 }),
      active_operation_id: null,
      last_observed_at: null,
      deleted_at: null,
    })
    .execute();
  await db
    .insertInto('server_allocations')
    .values({
      id: randomUUID(),
      server_id: serverId,
      node_id: nodeId,
      pterodactyl_allocation_id: number,
      address: '192.0.2.10',
      backend_address: '192.0.2.10',
      port: 25000 + number,
      role: 'game',
      protocols: ['tcp'],
      is_primary: true,
    })
    .execute();
  const users = new Map<string, Record<string, unknown>>();
  const records = new Map<string, Record<string, unknown>>();
  let userSequence = 0,
    recordSequence = 0;
  let loseSftpWrite = false,
    failSftpReadAfterWrite = false,
    loseDnsWrite = false,
    failDns = false;
  const sftpCalls: string[] = [],
    dnsCalls: string[] = [];
  const sftpFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      username = url.pathname.split('/').at(-1) ?? '',
      method = init?.method ?? 'GET';
    sftpCalls.push(method);
    if (method === 'GET') {
      if (failSftpReadAfterWrite) {
        failSftpReadAfterWrite = false;
        throw new Error('isolated unavailable');
      }
      return Response.json(users.get(username) ?? {}, { status: users.has(username) ? 200 : 404 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === 'POST') users.set(body.username, { ...body, id: ++userSequence });
    if (method === 'PUT') users.set(username, { ...users.get(username), ...body });
    if (method === 'DELETE') users.delete(username);
    if (loseSftpWrite) {
      loseSftpWrite = false;
      failSftpReadAfterWrite = true;
      throw new Error('isolated response lost');
    }
    return Response.json(method === 'POST' ? users.get(body.username) : {});
  };
  const dnsFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      id = url.pathname.split('/').at(-1) ?? '',
      method = init?.method ?? 'GET';
    dnsCalls.push(method);
    if (failDns) throw new Error('isolated unavailable');
    let result: unknown;
    if (method === 'GET' && url.searchParams.has('name'))
      result = [...records.values()].filter((entry) => entry.name === url.searchParams.get('name'));
    else if (method === 'GET') {
      result = records.get(id);
      if (!result) return Response.json({}, { status: 404 });
    } else {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (method === 'POST') {
        const next = (++recordSequence).toString(16).padStart(32, '0');
        result = { ...body, id: next };
        records.set(next, result as Record<string, unknown>);
      }
      if (method === 'PUT') {
        result = { ...body, id };
        records.set(id, result as Record<string, unknown>);
      }
      if (method === 'DELETE') {
        records.delete(id);
        result = { id };
      }
      if (loseDnsWrite) {
        loseDnsWrite = false;
        throw new Error('isolated response lost');
      }
    }
    return Response.json({ success: true, result, result_info: { total_pages: 1 } });
  };
  let clock = new Date();
  const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });
  const options: ExternalServiceOptions = {
    codec,
    now: () => clock,
    env: {
      NH_SFTPGO_BASE_URL: 'http://sftp.example.test',
      NH_SFTPGO_INSTANCE_ID: instanceId,
      NH_SFTPGO_DATA_ROOT: '/isolated',
      NH_SFTPGO_API_KEY: 'fixture-key',
      NH_DNS_INSTANCE_ID: instanceId,
      NH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
      NH_CLOUDFLARE_API_TOKEN: 'fixture-token',
      NH_DNS_BASE_DOMAIN: 'example.test',
      NH_DNS_TARGET: '192.0.2.10',
      NH_STATIC_GAME_HOSTNAME: 'static.example.test',
    },
    verifyServer: vi.fn(async () => {}),
    sftpFactory: (config, apiKey) =>
      new SftpGoAdapter({
        baseURL: config.sftpgoBaseUrl ?? '',
        instanceId: config.sftpgoInstanceId ?? '',
        dataRoot: config.sftpgoDataRoot ?? '',
        auth: { apiKey },
        fetcher: sftpFetch,
        now: () => clock.getTime(),
      }),
    dnsFactory: (config, apiToken) =>
      new CloudflareDnsProvider({
        instanceId: config.dnsInstanceId ?? '',
        apiToken,
        fetcher: dnsFetch,
      }),
  };
  return {
    db,
    context,
    other,
    serverId,
    options,
    users,
    records,
    sftpCalls,
    dnsCalls,
    codec,
    loseSftp: () => {
      loseSftpWrite = true;
    },
    loseDns: () => {
      loseDnsWrite = true;
    },
    failDns: (value: boolean) => {
      failDns = value;
    },
    tick: () => {
      clock = new Date(clock.getTime() + 3_700_000);
    },
    subdomain: `fixture-${number}`,
  };
}

describe('durable server external services', () => {
  it.each(['support-revoked', 'parent-revoked'] as const)(
    'rejects external cleanup through %s interactive support',
    async (reason) => {
      const f = await fixture(),
        credentialId = randomUUID(),
        assignmentId = randomUUID(),
        supportId = randomUUID();
      await createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options);
      await assignServerDns(
        f.db,
        f.context,
        f.serverId,
        { assignmentId, subdomain: f.subdomain },
        f.options,
      );
      await f.db
        .updateTable('user')
        .set({ role: 'owner' })
        .where('id', '=', f.other.actorUserId)
        .execute();
      const startedAt = new Date(),
        expiresAt = new Date(Date.now() + 600_000);
      await database.pool.query(
        'INSERT INTO support_sessions(id,token_hash,actor_user_id,subject_user_id,parent_session_id,reason,origin,audit_correlation_id,started_at,expires_at,last_activity_at) VALUES($1,$2,$3,$4,$5,$6,$7,$1,$8,$9,$8)',
        [
          supportId,
          randomUUID(),
          f.other.actorUserId,
          f.context.subjectUserId,
          f.other[authSessionId],
          'External revocation fixture',
          'http://localhost:3999',
          startedAt,
          expiresAt,
        ],
      );
      const context: AuthContext = {
        ...f.other,
        role: 'owner',
        subjectUserId: f.context.subjectUserId,
        sessionType: 'support',
        ownerElevation: true,
        support: {
          id: supportId,
          startedAt,
          expiresAt,
          lastActivityAt: startedAt,
          revokedAt: null,
          reason: 'External revocation fixture',
        },
      };
      if (reason === 'support-revoked')
        await database.pool.query('UPDATE support_sessions SET revoked_at=now() WHERE id=$1', [
          supportId,
        ]);
      else await database.pool.query('DELETE FROM session WHERE id=$1', [f.other[authSessionId]]);
      const before = [f.sftpCalls.length, f.dnsCalls.length];
      const code = reason === 'support-revoked' ? 'support_invalid' : 'unauthenticated';
      await expect(
        revokeSftpCredential(f.db, context, f.serverId, credentialId, f.options),
      ).rejects.toThrow(code);
      await expect(
        deleteServerDns(f.db, context, f.serverId, assignmentId, f.options),
      ).rejects.toThrow(code);
      expect([f.sftpCalls.length, f.dnsCalls.length]).toEqual(before);
    },
  );
  it('recovers a committed DNS intent after logout without requiring a browser session', async () => {
    const f = await fixture(),
      assignmentId = randomUUID();
    f.failDns(true);
    await expect(
      assignServerDns(
        f.db,
        f.context,
        f.serverId,
        { assignmentId, subdomain: f.subdomain },
        f.options,
      ),
    ).rejects.toThrow();
    await database.pool.query('DELETE FROM session WHERE id=$1', [f.context[authSessionId]]);
    f.failDns(false);
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 1, failed: 0 });
    expect(f.records.size).toBe(2);
    expect((await listServerDns(f.db, f.context, f.serverId))[0]?.state).toBe('active');
  });
  it.each([
    'sftp-create',
    'sftp-rotate',
    'sftp-revoke',
    'dns-assign',
    'dns-update',
    'dns-delete',
  ] as const)(
    'rejects %s after lock contention and session revocation without provider mutations',
    async (action) => {
      const f = await fixture(),
        credentialId = randomUUID(),
        assignmentId = randomUUID();
      await createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options);
      await assignServerDns(
        f.db,
        f.context,
        f.serverId,
        { assignmentId, subdomain: f.subdomain },
        f.options,
      );
      const mutation = () => {
        if (action === 'sftp-create')
          return createSftpCredential(
            f.db,
            f.context,
            f.serverId,
            { credentialId: randomUUID() },
            f.options,
          );
        if (action === 'sftp-rotate')
          return rotateSftpCredential(
            f.db,
            f.context,
            f.serverId,
            credentialId,
            { rotationId: randomUUID() },
            f.options,
          );
        if (action === 'sftp-revoke')
          return revokeSftpCredential(f.db, f.context, f.serverId, credentialId, f.options);
        if (action === 'dns-assign')
          return assignServerDns(
            f.db,
            f.context,
            f.serverId,
            { assignmentId: randomUUID(), subdomain: `${f.subdomain}-new` },
            f.options,
          );
        if (action === 'dns-update')
          return updateServerDns(
            f.db,
            f.context,
            f.serverId,
            assignmentId,
            { subdomain: `${f.subdomain}-new` },
            f.options,
          );
        return deleteServerDns(f.db, f.context, f.serverId, assignmentId, f.options);
      };
      const before = { sftp: f.sftpCalls.length, dns: f.dnsCalls.length };
      const lock = await database.pool.connect();
      try {
        await lock.query('SELECT pg_advisory_lock(hashtextextended(current_schema() || $1,0))', [
          `:nickhosting:server:${f.serverId}`,
        ]);
        // External orchestration deliberately uses try-locks: contention rejects
        // immediately, and a retry must authenticate anew after acquiring the lock.
        await expect(mutation()).rejects.toThrow('conflict');
        await lock.query('DELETE FROM session WHERE id=$1', [f.context[authSessionId]]);
      } finally {
        await lock.query('SELECT pg_advisory_unlock_all()');
        lock.release();
      }
      await expect(mutation()).rejects.toThrow('unauthenticated');
      expect(f.sftpCalls).toHaveLength(before.sftp);
      expect(f.dnsCalls).toHaveLength(before.dns);
      expect(f.users.size).toBe(1);
      expect(f.records.size).toBe(2);
    },
  );
  it.each(['sftp', 'dns'] as const)(
    'revalidates a %s request whose connection acquisition waited across logout',
    async (service) => {
      const f = await fixture();
      // Exhaust only this test-owned pool; no production or other suite connection
      // participates. The mutation already captured a formerly valid AuthContext.
      const held = await Promise.all(
        Array.from({ length: database.pool.options.max ?? 15 }, () => database.pool.connect()),
      );
      const controller = held[0];
      if (!controller) throw new Error('Missing pool fixture');
      let pending: Promise<unknown> | undefined;
      try {
        await controller.query(
          'SELECT pg_advisory_lock(hashtextextended(current_schema() || $1,0))',
          [`:nickhosting:server:${f.serverId}`],
        );
        const mutation =
          service === 'sftp'
            ? createSftpCredential(
                f.db,
                f.context,
                f.serverId,
                { credentialId: randomUUID() },
                f.options,
              )
            : assignServerDns(
                f.db,
                f.context,
                f.serverId,
                { assignmentId: randomUUID(), subdomain: f.subdomain },
                f.options,
              );
        pending = mutation.then(
          () => ({ success: true }),
          (error: unknown) => error,
        );
        await vi.waitFor(() => expect(database.pool.waitingCount).toBe(1), {
          timeout: 3000,
          interval: 10,
        });
        await controller.query('DELETE FROM session WHERE id=$1', [f.context[authSessionId]]);
        await controller.query('SELECT pg_advisory_unlock_all()');
      } finally {
        for (const connection of held) connection.release();
      }
      expect(await pending).toMatchObject({ code: 'unauthenticated' });
      expect(f.sftpCalls).toHaveLength(0);
      expect(f.dnsCalls).toHaveLength(0);
    },
  );
  it('does not deliver a password after logout during provider creation while retaining background recovery', async () => {
    const f = await fixture(),
      credentialId = randomUUID();
    const verify = f.options.verifyServer;
    f.options.verifyServer = async (db, serverId) => {
      await verify(db, serverId);
      await database.pool.query('DELETE FROM session WHERE id=$1', [f.context[authSessionId]]);
    };
    await expect(
      createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options),
    ).rejects.toThrow('unauthenticated');
    expect(f.users.size).toBe(1);
    const stored = await f.db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .executeTakeFirstOrThrow();
    expect(
      JSON.parse(f.codec.decrypt(stored.envelope, `external-sftp:${credentialId}`)).delivered,
    ).toBe(false);
    // A committed provider intent is durable work, and may finish after browser
    // logout. It must still enforce issuer role/membership, tested separately.
    await f.db
      .updateTable('external_sftp_credentials')
      .set({ state: 'uncertain' })
      .where('id', '=', credentialId)
      .execute();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 1, failed: 0 });
    expect(f.users.size).toBe(1);
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(1);
  });
  it('revokes issued logins when the issuer loses project authority while retaining valid server and Owner credentials', async () => {
    const f = await fixture(),
      projectId = randomUUID(),
      memberCredential = randomUUID(),
      ownerCredential = randomUUID();
    await f.db
      .insertInto('projects')
      .values({ id: projectId, owner_id: f.context.subjectUserId, name: 'Access revalidation' })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ project_id: projectId })
      .where('id', '=', f.serverId)
      .execute();
    await f.db
      .insertInto('project_members')
      .values({ project_id: projectId, user_id: f.other.subjectUserId, role: 'manager' })
      .execute();
    const member = await createSftpCredential(
      f.db,
      f.other,
      f.serverId,
      { credentialId: memberCredential },
      f.options,
    );
    await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId: randomUUID() },
      f.options,
    );
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 0 });
    await f.db
      .updateTable('project_members')
      .set({ role: 'viewer' })
      .where('project_id', '=', projectId)
      .where('user_id', '=', f.other.subjectUserId)
      .execute();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 1, failed: 0 });
    expect(f.users.has(member.username ?? '')).toBe(false);
    expect(f.users.size).toBe(1);
    expect(
      (
        await f.db
          .selectFrom('external_sftp_credentials')
          .select('state')
          .where('id', '=', memberCredential)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('revoked');
    const audit = await f.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', '=', 'server.sftp.access_revoked')
      .executeTakeFirstOrThrow();
    expect(audit.actor_user_id).toBe(f.other.actorUserId);
    expect(audit.metadata).toMatchObject({
      credentialId: memberCredential,
      reason: 'issuer_permission_removed',
    });
    await f.db
      .updateTable('user')
      .set({ role: 'owner' })
      .where('id', '=', f.other.actorUserId)
      .execute();
    const owner = await createSftpCredential(
      f.db,
      { ...f.other, role: 'owner' },
      f.serverId,
      { credentialId: ownerCredential },
      f.options,
    );
    await f.db.deleteFrom('project_members').where('project_id', '=', projectId).execute();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 0 });
    expect(f.users.has(owner.username ?? '')).toBe(true);
    await f.db
      .updateTable('user')
      .set({ role: 'user' })
      .where('id', '=', f.other.actorUserId)
      .execute();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 1, failed: 0 });
    expect(f.users.has(owner.username ?? '')).toBe(false);
    expect(f.users.size).toBe(1);
  });
  it('encrypts credential intents, returns password once and excludes secrets/provider identifiers from metadata', async () => {
    const f = await fixture(),
      credentialId = randomUUID();
    const created = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId },
      f.options,
    );
    expect(created.password?.length).toBeGreaterThanOrEqual(32);
    expect(
      (await createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options))
        .password,
    ).toBeUndefined();
    const rows = await f.db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .execute();
    expect(JSON.stringify(rows)).not.toContain(created.password);
    const metadata = await listSftpCredentials(f.db, f.context, f.serverId);
    expect(JSON.stringify(metadata)).not.toContain('envelope');
    expect(JSON.stringify(metadata)).not.toContain('externalUserId');
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(1);
  });
  it('denies unrelated users and support sessions before provider writes', async () => {
    const f = await fixture();
    await expect(
      createSftpCredential(f.db, f.other, f.serverId, { credentialId: randomUUID() }, f.options),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      createSftpCredential(
        f.db,
        { ...f.context, sessionType: 'support' },
        f.serverId,
        { credentialId: randomUUID() },
        f.options,
      ),
    ).rejects.toThrow();
    expect(f.sftpCalls).toHaveLength(0);
    await expect(
      assignServerDns(
        f.db,
        f.other,
        f.serverId,
        { assignmentId: randomUUID(), subdomain: f.subdomain },
        f.options,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.dnsCalls).toHaveLength(0);
  });
  it('recovers an unknown create after worker restart without duplicate account or plaintext persistence', async () => {
    const f = await fixture(),
      credentialId = randomUUID();
    f.loseSftp();
    await expect(
      createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(f.users.size).toBe(1);
    expect(await reconcileExternalServices(f.db, f.options)).toMatchObject({ failed: 0 });
    const result = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId },
      f.options,
    );
    expect(result.password).toBeDefined();
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(1);
  });
  it('rotates idempotently, audits actions and expires credentials through revocation', async () => {
    const f = await fixture(),
      credentialId = randomUUID(),
      rotationId = randomUUID();
    const original = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId },
      f.options,
    );
    const rotated = await rotateSftpCredential(
      f.db,
      f.context,
      f.serverId,
      credentialId,
      { rotationId },
      f.options,
    );
    expect(rotated.password).not.toBe(original.password);
    expect(
      (
        await rotateSftpCredential(
          f.db,
          f.context,
          f.serverId,
          credentialId,
          { rotationId },
          f.options,
        )
      ).password,
    ).toBeUndefined();
    expect(f.sftpCalls.filter((method) => method === 'PUT')).toHaveLength(1);
    f.tick();
    await reconcileExternalServices(f.db, f.options);
    expect(f.users.size).toBe(0);
    expect((await listSftpCredentials(f.db, f.context, f.serverId))[0]?.state).toBe('revoked');
    const audit = await f.db
      .selectFrom('audit_events')
      .selectAll()
      .where('actor_user_id', '=', f.context.actorUserId)
      .execute();
    expect(audit.map((entry) => entry.action)).toContain('server.sftp.rotated');
    expect(JSON.stringify(audit)).not.toContain(rotated.password);
  });
  it('revokes an uncertain account without creating it again and fails closed on configuration drift', async () => {
    const f = await fixture(),
      credentialId = randomUUID();
    f.loseSftp();
    await expect(
      createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options),
    ).rejects.toThrow();
    await revokeSftpCredential(f.db, f.context, f.serverId, credentialId, f.options);
    expect(f.users.size).toBe(0);
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(1);
    const other = randomUUID();
    await createSftpCredential(f.db, f.context, f.serverId, { credentialId: other }, f.options);
    f.options.env = { ...f.options.env, NH_SFTPGO_BASE_URL: 'http://changed.example.test' };
    await expect(
      revokeSftpCredential(f.db, f.context, f.serverId, other, f.options),
    ).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(f.users.size).toBe(1);
  });
  it('serializes concurrent credential creation and returns the secret at most once', async () => {
    const f = await fixture(),
      credentialId = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled' && result.value.password),
    ).toHaveLength(1);
    expect(f.users.size).toBe(1);
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(1);
  });
  it('uses plugin-declared SRV and assigned port; static mode performs no provider calls', async () => {
    const f = await fixture();
    const plan = await previewServerDns(
      f.db,
      f.context,
      f.serverId,
      { subdomain: f.subdomain },
      f.options,
    );
    expect(plan.records[1]).toMatchObject({ type: 'SRV', data: { port: plan.port } });
    const s = await fixture('static-host-port');
    const result = await assignServerDns(
      s.db,
      s.context,
      s.serverId,
      { assignmentId: randomUUID() },
      s.options,
    );
    expect(result.state).toBe('static');
    expect(result.connection.records).toEqual([]);
    expect(s.dnsCalls).toEqual([]);
  });
  it('persists DNS ownership before effects, updates and releases hostname only after safe cleanup', async () => {
    const f = await fixture(),
      assignmentId = randomUUID();
    await assignServerDns(
      f.db,
      f.context,
      f.serverId,
      { assignmentId, subdomain: f.subdomain },
      f.options,
    );
    expect(f.records.size).toBe(2);
    await updateServerDns(
      f.db,
      f.context,
      f.serverId,
      assignmentId,
      { subdomain: `${f.subdomain}-new` },
      f.options,
    );
    expect(f.records.size).toBe(2);
    expect(
      [...f.records.values()].every((entry) => String(entry.name).includes(`${f.subdomain}-new`)),
    ).toBe(true);
    await deleteServerDns(f.db, f.context, f.serverId, assignmentId, f.options);
    expect(f.records.size).toBe(0);
    expect(await listServerDns(f.db, f.context, f.serverId)).toEqual([]);
    await assignServerDns(
      f.db,
      f.context,
      f.serverId,
      { assignmentId: randomUUID(), subdomain: `${f.subdomain}-new` },
      f.options,
    );
    expect(f.records.size).toBe(2);
  });
  it('recovers lost DNS POST without duplicates and deletes uncertain effects without creating missing records', async () => {
    const f = await fixture(),
      assignmentId = randomUUID();
    f.loseDns();
    await expect(
      assignServerDns(
        f.db,
        f.context,
        f.serverId,
        { assignmentId, subdomain: f.subdomain },
        f.options,
      ),
    ).rejects.toThrow();
    expect(f.records.size).toBe(1);
    await deleteServerDns(f.db, f.context, f.serverId, assignmentId, f.options);
    expect(f.records.size).toBe(0);
    expect(f.dnsCalls.filter((method) => method === 'POST')).toHaveLength(1);
    const next = randomUUID();
    f.loseDns();
    await expect(
      assignServerDns(
        f.db,
        f.context,
        f.serverId,
        { assignmentId: next, subdomain: `${f.subdomain}-next` },
        f.options,
      ),
    ).rejects.toThrow();
    const result = await reconcileExternalServices(f.db, f.options);
    expect(result.failed).toBe(0);
    expect(f.records.size).toBe(2);
  });
  it('denies duplicate DNS ownership and blocks deletion callback until providers confirm cleanup', async () => {
    const f = await fixture(),
      assignmentId = randomUUID();
    await assignServerDns(
      f.db,
      f.context,
      f.serverId,
      { assignmentId, subdomain: f.subdomain },
      f.options,
    );
    await expect(
      assignServerDns(
        f.db,
        f.context,
        f.serverId,
        { assignmentId: randomUUID(), subdomain: f.subdomain },
        f.options,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId: randomUUID() },
      f.options,
    );
    f.failDns(true);
    await expect(cleanupServerExternalServices(f.db, f.serverId, f.options)).rejects.toThrow();
    expect(f.users.size).toBe(0);
    expect(f.records.size).toBe(2);
    f.failDns(false);
    await f.db.connection().execute(async (connection) => {
      const key = `:nickhosting:server:${f.serverId}`;
      await sql`select pg_advisory_lock(hashtextextended(current_schema() || ${key},0))`.execute(
        connection,
      );
      try {
        await cleanupServerExternalServices(connection, f.serverId, f.options);
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(current_schema() || ${key},0))`.execute(
          connection,
        );
      }
    });
    expect(f.records.size).toBe(0);
  });
});
