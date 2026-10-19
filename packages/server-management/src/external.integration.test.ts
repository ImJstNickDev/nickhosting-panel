import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type AuthContext, authSessionId, dnsNameWords, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { CloudflareDnsProvider, SftpGoAdapter } from '@nickhosting/external-services';
import type { GameManifest } from '@nickhosting/game-sdk';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGameConnectionAvailability,
  reserveGameConnection,
  suggestGameConnection,
} from './dns.js';
import { consumeDnsWizardReservation, reserveDnsWizardHostname } from './dns-reservations.js';
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
  reconcileServerStorageQuota,
  revealSftpCredential,
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
  const allocation = await db
    .selectFrom('server_allocations')
    .select('id')
    .where('server_id', '=', serverId)
    .executeTakeFirstOrThrow();
  await db
    .insertInto('gateway_routes')
    .values({
      id: randomUUID(),
      gateway_id: randomUUID(),
      server_id: serverId,
      allocation_id: allocation.id,
      public_address: '192.0.2.10',
      public_port: 25000 + number,
      transport: 'tcp',
    })
    .execute();
  const users = new Map<string, Record<string, unknown>>();
  const records = new Map<string, Record<string, unknown>>();
  let userSequence = 0,
    recordSequence = 0;
  let loseSftpWrite = false,
    failSftpReadAfterWrite = false,
    failSftpWrites = false,
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
    if (failSftpWrites) throw new Error('isolated provider unavailable before write');
    if (method === 'POST')
      users.set(body.username, { ...body, id: ++userSequence, used_quota_size: 0 });
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
    readServerDiskUsage: vi.fn(async () => 0),
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
    gameId: manifest.id,
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
    failSftpWrites: (value: boolean) => {
      failSftpWrites = value;
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
  it.each(['primary', 'auxiliary'] as const)(
    'reveals an active %s password repeatedly without provider work or credential mutation',
    async (kind) => {
      const f = await fixture();
      const credentialId = randomUUID();
      const issued = await createSftpCredential(
        f.db,
        f.context,
        f.serverId,
        { credentialId, kind },
        f.options,
      );
      const before = await f.db
        .selectFrom('external_sftp_credentials')
        .selectAll()
        .where('id', '=', credentialId)
        .executeTakeFirstOrThrow();
      const options: ExternalServiceOptions = {
        ...f.options,
        env: {},
        verifyServer: vi.fn(async () => {
          throw new Error('Disclosure must not scan provider identity');
        }),
        readServerDiskUsage: vi.fn(async () => {
          throw new Error('Disclosure must not read disk');
        }),
        sftpFactory: vi.fn(() => {
          throw new Error('Disclosure must not construct a provider');
        }),
      };
      const providerCalls = [...f.sftpCalls];
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          await revealSftpCredential(f.db, f.context, f.serverId, credentialId, {}, options),
        ).toEqual(issued);
      expect(f.sftpCalls).toEqual(providerCalls);
      expect(options.verifyServer).not.toHaveBeenCalled();
      expect(options.readServerDiskUsage).not.toHaveBeenCalled();
      expect(options.sftpFactory).not.toHaveBeenCalled();
      expect(
        await f.db
          .selectFrom('external_sftp_credentials')
          .selectAll()
          .where('id', '=', credentialId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      const rotated = await rotateSftpCredential(
        f.db,
        f.context,
        f.serverId,
        credentialId,
        { rotationId: randomUUID() },
        f.options,
      );
      expect(rotated.password).not.toBe(issued.password);
      expect(
        await revealSftpCredential(f.db, f.context, f.serverId, credentialId, {}, options),
      ).toEqual(rotated);
      const listed = await listSftpCredentials(f.db, f.context, f.serverId);
      const audits = await f.db.selectFrom('audit_events').selectAll().execute();
      const disclosures = audits.filter(
        (entry) => entry.action === 'server.sftp.password_revealed',
      );
      expect(disclosures).toHaveLength(3);
      for (const audit of disclosures)
        expect(audit.metadata).toEqual({ serverId: f.serverId, credentialId });
      for (const secret of [issued.password, rotated.password]) {
        expect(JSON.stringify(listed)).not.toContain(secret);
        expect(JSON.stringify(audits)).not.toContain(secret);
      }
    },
  );

  it('rejects disclosure by another actor including an Owner, across servers, support and lost authority', async () => {
    const f = await fixture();
    const credentialId = randomUUID();
    await createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options);
    const reveal = (context = f.context, serverId = f.serverId) =>
      revealSftpCredential(f.db, context, serverId, credentialId, {}, f.options);
    await expect(reveal(f.other)).rejects.toMatchObject({ code: 'forbidden' });
    await f.db
      .updateTable('user')
      .set({ role: 'owner' })
      .where('id', '=', f.other.actorUserId)
      .execute();
    await expect(reveal(f.other)).rejects.toMatchObject({ code: 'forbidden' });
    const otherServer = await fixture();
    await expect(reveal(f.other, otherServer.serverId)).rejects.toMatchObject({
      code: 'not_found',
    });
    const at = new Date();
    await expect(
      reveal({
        ...f.other,
        role: 'owner',
        subjectUserId: f.context.actorUserId,
        sessionType: 'support',
        ownerElevation: true,
        support: {
          id: randomUUID(),
          startedAt: at,
          expiresAt: new Date(at.getTime() + 600_000),
          lastActivityAt: at,
          revokedAt: null,
          reason: 'Fixture support',
          idleTtlSeconds: 600,
          absoluteTtlSeconds: 600,
        },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await f.db
      .updateTable('managed_servers')
      .set({ owner_id: f.other.actorUserId })
      .where('id', '=', f.serverId)
      .execute();
    await expect(reveal()).rejects.toMatchObject({ code: 'forbidden' });
    await f.db
      .updateTable('managed_servers')
      .set({ owner_id: f.context.actorUserId })
      .where('id', '=', f.serverId)
      .execute();
    await expect(reveal({ ...f.context, [authSessionId]: undefined })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(
      reveal({ ...f.context, [authSessionId]: f.other[authSessionId] }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    await f.db
      .updateTable('session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', f.context[authSessionId] ?? '')
      .execute();
    await expect(reveal()).rejects.toMatchObject({ code: 'unauthenticated' });
    await f.db
      .deleteFrom('session')
      .where('id', '=', f.context[authSessionId] ?? '')
      .execute();
    await expect(reveal()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(
      await f.db
        .selectFrom('audit_events')
        .selectAll()
        .where('action', '=', 'server.sftp.password_revealed')
        .execute(),
    ).toEqual([]);
  });

  it('rejects inactive, expired and corrupt credentials and accepts retained legacy passwords', async () => {
    const f = await fixture();
    const credentialId = randomUUID();
    await createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options);
    const reveal = () =>
      revealSftpCredential(f.db, f.context, f.serverId, credentialId, {}, f.options);
    for (const state of ['pending', 'uncertain', 'revoking', 'revoked'] as const) {
      await f.db
        .updateTable('external_sftp_credentials')
        .set({ state })
        .where('id', '=', credentialId)
        .execute();
      await expect(reveal()).rejects.toMatchObject({ code: 'conflict' });
    }
    await f.db
      .updateTable('external_sftp_credentials')
      .set({ state: 'active' })
      .where('id', '=', credentialId)
      .execute();
    const original = await f.db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .executeTakeFirstOrThrow();
    const intent = JSON.parse(f.codec.decrypt(original.envelope, `external-sftp:${credentialId}`));
    const save = async (value: unknown) => {
      await f.db
        .updateTable('external_sftp_credentials')
        .set({
          envelope: JSON.stringify(
            f.codec.encrypt(JSON.stringify(value), `external-sftp:${credentialId}`),
          ),
        })
        .where('id', '=', credentialId)
        .execute();
    };
    for (const password of ['', null, 123]) {
      await save({ ...intent, request: { ...intent.request, password } });
      await expect(reveal()).rejects.toMatchObject({ code: 'secret_invalid' });
    }
    await save({ ...intent, request: { ...intent.request, serverId: randomUUID() } });
    await expect(reveal()).rejects.toMatchObject({ code: 'secret_invalid' });
    await f.db
      .updateTable('external_sftp_credentials')
      .set({ envelope: '{}' })
      .where('id', '=', credentialId)
      .execute();
    await expect(reveal()).rejects.toMatchObject({ code: 'secret_invalid' });
    const legacyPassword = randomBytes(32).toString('base64url');
    await save({
      ...intent,
      delivered: true,
      request: { ...intent.request, password: legacyPassword },
    });
    expect((await reveal()).password).toBe(legacyPassword);
    f.tick();
    await expect(reveal()).rejects.toMatchObject({ code: 'conflict' });
  });

  it('serializes disclosure with rotation and does not disclose a pending replacement', async () => {
    const f = await fixture();
    const credentialId = randomUUID();
    const issued = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId },
      f.options,
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.options.verifyServer = async () => {
      entered.resolve();
      await release.promise;
    };
    const rotation = rotateSftpCredential(
      f.db,
      f.context,
      f.serverId,
      credentialId,
      { rotationId: randomUUID() },
      f.options,
    );
    await entered.promise;
    try {
      await expect(
        revealSftpCredential(f.db, f.context, f.serverId, credentialId, {}, f.options),
      ).rejects.toMatchObject({ code: 'conflict' });
    } finally {
      release.resolve();
    }
    const rotated = await rotation;
    expect(rotated.password).not.toBe(issued.password);
    expect(
      (await revealSftpCredential(f.db, f.context, f.serverId, credentialId, {}, f.options))
        .password,
    ).toBe(rotated.password);
  });

  it('keeps one stable primary login without expiry, only rotates explicitly, and forbids direct deletion', async () => {
    const f = await fixture();
    const credentialId = randomUUID();
    const user = await f.db
      .selectFrom('user')
      .select('username')
      .where('id', '=', f.context.actorUserId)
      .executeTakeFirstOrThrow();
    const issued = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId, kind: 'primary' },
      f.options,
    );
    expect(issued).toMatchObject({
      id: credentialId,
      kind: 'primary',
      label: null,
      expiresAt: null,
      username: `${user.username}-${f.serverId.slice(0, 8)}`,
    });
    expect(issued.password).toHaveLength(16);
    const remote = f.users.get(issued.username ?? '');
    expect(remote).toMatchObject({ expiration_date: 0, password: issued.password });
    f.tick();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 0 });
    const replay = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId: randomUUID(), kind: 'primary' },
      f.options,
    );
    expect(replay).toMatchObject({ id: credentialId, expiresAt: null });
    expect(replay.password).toBeUndefined();
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(1);
    await expect(
      revokeSftpCredential(f.db, f.context, f.serverId, credentialId, f.options),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const rotationId = randomUUID();
    const rotated = await rotateSftpCredential(
      f.db,
      f.context,
      f.serverId,
      credentialId,
      { rotationId },
      f.options,
    );
    expect(rotated).toMatchObject({ username: issued.username, expiresAt: null });
    expect(rotated.password).toHaveLength(16);
    expect(rotated.password).not.toBe(issued.password);
    expect(f.users.get(issued.username ?? '')).toMatchObject({
      expiration_date: 0,
      password: rotated.password,
    });
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
    await cleanupServerExternalServices(f.db, f.serverId, f.options);
    expect(f.users.size).toBe(0);
  });

  it('reserves one primary before remote effects under concurrent requests and recovers its original password', async () => {
    const f = await fixture();
    f.loseSftp();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.options.verifyServer = async () => {
      entered.resolve();
      await release.promise;
    };
    const first = createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId: randomUUID(), kind: 'primary' },
      f.options,
    );
    const firstFailure = expect(first).rejects.toThrow();
    await entered.promise;
    try {
      await expect(
        createSftpCredential(
          f.db,
          f.context,
          f.serverId,
          { credentialId: randomUUID(), kind: 'primary' },
          f.options,
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
    } finally {
      release.resolve();
    }
    await firstFailure;
    const rows = await f.db.selectFrom('external_sftp_credentials').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'primary', state: 'uncertain', expires_at: null });
    const pendingPassword = [...f.users.values()][0]?.password;
    const recovered = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId: randomUUID(), kind: 'primary' },
      f.options,
    );
    expect(recovered.password).toBe(pendingPassword);
    expect(f.users.size).toBe(1);
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(1);
  });

  it('does not overwrite an unrelated remote account with the primary username', async () => {
    const f = await fixture();
    const user = await f.db
      .selectFrom('user')
      .select('username')
      .where('id', '=', f.context.actorUserId)
      .executeTakeFirstOrThrow();
    const username = `${user.username}-${f.serverId.slice(0, 8)}`;
    const unrelated = {
      id: 987,
      username,
      password: 'unrelated',
      additional_info: '{}',
      status: 1,
      home_dir: '/unrelated',
      expiration_date: 0,
      quota_size: 0,
      filesystem: { provider: 0 },
      permissions: { '/': ['list'] },
      filters: {},
    };
    f.users.set(username, unrelated);
    await expect(
      createSftpCredential(
        f.db,
        f.context,
        f.serverId,
        { credentialId: randomUUID(), kind: 'primary' },
        f.options,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.users.get(username)).toEqual(unrelated);
    expect(f.sftpCalls.every((method) => method === 'GET')).toBe(true);
  });

  it('rejects cross-server ID replays and reserves colliding primary usernames before remote writes', async () => {
    const f = await fixture();
    const credentialId = randomUUID();
    await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId, kind: 'primary' },
      f.options,
    );
    const secondId = `${f.serverId.slice(0, 8)}${randomUUID().slice(8)}`;
    await sql`insert into managed_servers
      (id, owner_id, mapping_id, node_id, name, external_id, limits,
       pterodactyl_id, pterodactyl_uuid, pterodactyl_identifier)
      select ${secondId}, owner_id, mapping_id, node_id, 'Second', ${`nh-${secondId}`}, limits,
        pterodactyl_id + 100000, ${randomUUID()}::uuid, ${randomUUID().slice(0, 8)}
      from managed_servers where id=${f.serverId}`.execute(f.db);
    const before = f.sftpCalls.length;
    for (const id of [credentialId, randomUUID()])
      await expect(
        createSftpCredential(
          f.db,
          f.context,
          secondId,
          { credentialId: id, kind: 'primary' },
          f.options,
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
    expect(f.sftpCalls).toHaveLength(before);
    expect(await f.db.selectFrom('external_sftp_credentials').select('id').execute()).toHaveLength(
      1,
    );
  });

  it('enforces auxiliary limits per actor including uncertain rows and isolates listing and ID replays', async () => {
    const f = await fixture();
    f.options.env = { ...f.options.env, NH_SFTP_AUXILIARY_LIMIT: '1' };
    const projectId = randomUUID();
    await f.db
      .insertInto('projects')
      .values({ id: projectId, owner_id: f.context.actorUserId, name: 'Shared' })
      .execute();
    await f.db
      .updateTable('managed_servers')
      .set({ project_id: projectId })
      .where('id', '=', f.serverId)
      .execute();
    await f.db
      .insertInto('project_members')
      .values({ project_id: projectId, user_id: f.other.actorUserId, role: 'manager' })
      .execute();
    const credentialId = randomUUID();
    f.failSftpWrites(true);
    await expect(
      createSftpCredential(
        f.db,
        f.context,
        f.serverId,
        { credentialId, label: 'Deploy' },
        f.options,
      ),
    ).rejects.toThrow();
    f.failSftpWrites(false);
    await expect(
      createSftpCredential(f.db, f.context, f.serverId, { credentialId: randomUUID() }, f.options),
    ).rejects.toMatchObject({ code: 'conflict' });
    const own = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId, label: 'Deploy' },
      f.options,
    );
    const other = await createSftpCredential(
      f.db,
      f.other,
      f.serverId,
      { credentialId: randomUUID() },
      f.options,
    );
    expect(own).toMatchObject({ kind: 'auxiliary', label: 'Deploy' });
    expect(own.expiresAt).toBeInstanceOf(Date);
    expect((await listSftpCredentials(f.db, f.other, f.serverId)).map((row) => row.id)).toEqual([
      other.id,
    ]);
    await expect(
      createSftpCredential(f.db, f.other, f.serverId, { credentialId, label: 'Deploy' }, f.options),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      rotateSftpCredential(
        f.db,
        f.other,
        f.serverId,
        credentialId,
        { rotationId: randomUUID() },
        f.options,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      revokeSftpCredential(f.db, f.other, f.serverId, credentialId, f.options),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId: randomUUID(), kind: 'primary' },
      f.options,
    );
    const otherPrimary = await createSftpCredential(
      f.db,
      f.other,
      f.serverId,
      { credentialId: randomUUID(), kind: 'primary' },
      f.options,
    );
    expect((await listSftpCredentials(f.db, f.other, f.serverId)).map((row) => row.id)).toEqual([
      otherPrimary.id,
      other.id,
    ]);
    await revokeSftpCredential(f.db, f.context, f.serverId, credentialId, f.options);
    await expect(
      createSftpCredential(f.db, f.context, f.serverId, { credentialId: randomUUID() }, f.options),
    ).resolves.toMatchObject({ kind: 'auxiliary' });
  });

  it('permits a primary when auxiliary issuance is disabled', async () => {
    const f = await fixture();
    f.options.env = { ...f.options.env, NH_SFTP_AUXILIARY_LIMIT: '0' };
    await expect(
      createSftpCredential(f.db, f.context, f.serverId, { credentialId: randomUUID() }, f.options),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      createSftpCredential(
        f.db,
        f.context,
        f.serverId,
        { credentialId: randomUUID(), kind: 'primary' },
        f.options,
      ),
    ).resolves.toMatchObject({ kind: 'primary' });
  });

  it.each(['applying', 'blocked'] as const)(
    'fences new and rotated credentials while storage policy is %s but permits reconciliation',
    async (status) => {
      const f = await fixture();
      const credentialId = randomUUID();
      await createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options);
      await f.db
        .insertInto('storage_policy_transitions')
        .values({
          id: randomUUID(),
          actor_user_id: f.context.actorUserId,
          status,
          policy: 'GLOBAL_POOL',
          previous_policy: 'PER_USER_BUDGET',
          default_user_storage_mib: 1024,
          plan: '{}',
        })
        .execute();
      const before = f.sftpCalls.length;
      await expect(
        createSftpCredential(
          f.db,
          f.context,
          f.serverId,
          { credentialId: randomUUID() },
          f.options,
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        rotateSftpCredential(
          f.db,
          f.context,
          f.serverId,
          credentialId,
          { rotationId: randomUUID() },
          f.options,
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(f.sftpCalls).toHaveLength(before);
      expect(await reconcileServerStorageQuota(f.db, f.serverId, 0, f.options)).toEqual({
        reconciled: 1,
      });
    },
  );
  it('updates an absent pending credential intent without issuing access until ordinary recovery', async () => {
    const f = await fixture();
    const credentialId = randomUUID();
    f.failSftpWrites(true);
    await expect(
      createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options),
    ).rejects.toThrow();
    f.failSftpWrites(false);
    const before = await f.db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .executeTakeFirstOrThrow();
    const oldIntent = JSON.parse(f.codec.decrypt(before.envelope, `external-sftp:${credentialId}`));
    expect(await reconcileServerStorageQuota(f.db, f.serverId, 0, f.options)).toEqual({
      reconciled: 1,
    });
    expect(f.users.size).toBe(0);
    const after = await f.db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .executeTakeFirstOrThrow();
    const updated = JSON.parse(f.codec.decrypt(after.envelope, `external-sftp:${credentialId}`));
    expect(updated).toMatchObject({
      delivered: false,
      request: { quotaBytes: 0, password: oldIntent.request.password },
    });
    expect(after.state).toBe(before.state);
    // The storage transition commits the provider-confirmed cap before the
    // ordinary credential recovery worker is allowed to resume.
    await sql`update managed_servers set limits=jsonb_set(limits,'{disk}','0'::jsonb) where id=${f.serverId}`.execute(
      f.db,
    );
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 2, failed: 0 });
    expect([...f.users.values()][0]).toMatchObject({
      quota_size: 0,
      password: oldIntent.request.password,
    });
  });
  it('issues unlimited SFTP credentials and reconciles active quotas without redelivery or rotation', async () => {
    const f = await fixture();
    const server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    await f.db
      .updateTable('managed_servers')
      .set({ limits: JSON.stringify({ ...server.limits, disk: 0 }) })
      .where('id', '=', f.serverId)
      .execute();
    const credentialId = randomUUID();
    const issued = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId },
      f.options,
    );
    const username = issued.username;
    if (!username) throw new Error('Missing fixture credential');
    expect(f.users.get(username)?.quota_size).toBe(0);
    const password = f.users.get(username)?.password;
    const expires = f.users.get(username)?.expiration_date;
    expect(await reconcileServerStorageQuota(f.db, f.serverId, 64, f.options)).toEqual({
      reconciled: 1,
    });
    expect(f.users.get(username)).toMatchObject({
      quota_size: 64 * 1_048_576,
      password,
      expiration_date: expires,
    });
    expect(await reconcileServerStorageQuota(f.db, f.serverId, 0, f.options)).toEqual({
      reconciled: 1,
    });
    expect(f.users.get(username)).toMatchObject({
      quota_size: 0,
      password,
      expiration_date: expires,
    });
    const puts = f.sftpCalls.filter((method) => method === 'PUT').length;
    await reconcileServerStorageQuota(f.db, f.serverId, 0, f.options);
    expect(f.sftpCalls.filter((method) => method === 'PUT')).toHaveLength(puts);
    const row = await f.db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .executeTakeFirstOrThrow();
    expect(row.provider_ref).toMatchObject({ quotaBytes: 0 });
    const intent = JSON.parse(f.codec.decrypt(row.envelope, `external-sftp:${credentialId}`));
    expect(intent).toMatchObject({ delivered: true, request: { quotaBytes: 0, password } });
    expect(
      (await createSftpCredential(f.db, f.context, f.serverId, { credentialId }, f.options))
        .password,
    ).toBeUndefined();
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(1);
  });
  it('fails quota reconciliation before mutation when ownership or finite usage cannot be proven', async () => {
    const f = await fixture();
    const credentialId = randomUUID();
    const issued = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId },
      f.options,
    );
    if (!issued.username) throw new Error('Missing fixture credential');
    const remote = f.users.get(issued.username);
    if (!remote) throw new Error('Missing fixture account');
    remote.used_quota_size = 2 * 1_048_576;
    await expect(reconcileServerStorageQuota(f.db, f.serverId, 1, f.options)).rejects.toMatchObject(
      { code: 'resources_unavailable' },
    );
    remote.additional_info = '{}';
    await expect(reconcileServerStorageQuota(f.db, f.serverId, 0, f.options)).rejects.toMatchObject(
      { code: 'conflict' },
    );
    expect(f.sftpCalls.filter((method) => method === 'PUT')).toHaveLength(0);
    const row = await f.db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .executeTakeFirstOrThrow();
    expect(row.provider_ref).toMatchObject({ quotaBytes: 64 * 1_048_576 });
  });
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
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 2, failed: 0 });
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
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 2, failed: 0 });
    expect(f.users.size).toBe(2);
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(2);
  });
  it.each(['primary', 'auxiliary'] as const)(
    'revokes %s logins when issuer authority is lost while retaining valid credentials',
    async (kind) => {
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
        { credentialId: memberCredential, kind },
        f.options,
      );
      await createSftpCredential(
        f.db,
        f.context,
        f.serverId,
        { credentialId: randomUUID() },
        f.options,
      );
      expect(await reconcileExternalServices(f.db, f.options)).toEqual({
        recovered: kind === 'primary' ? 1 : 2,
        failed: 0,
      });
      await f.db
        .updateTable('project_members')
        .set({ role: 'viewer' })
        .where('project_id', '=', projectId)
        .where('user_id', '=', f.other.subjectUserId)
        .execute();
      if (kind === 'primary') {
        await f.db
          .insertInto('storage_policy_transitions')
          .values({
            id: randomUUID(),
            actor_user_id: f.context.actorUserId,
            status: 'blocked',
            policy: 'GLOBAL_POOL',
            previous_policy: 'PER_USER_BUDGET',
            default_user_storage_mib: 1024,
            plan: '{}',
          })
          .execute();
      }
      expect(await reconcileExternalServices(f.db, f.options)).toEqual({
        recovered: kind === 'primary' ? 1 : 2,
        failed: 0,
      });
      await f.db.deleteFrom('storage_policy_transitions').execute();
      expect(f.users.has(member.username ?? '')).toBe(false);
      expect(f.users.size).toBe(2);
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
        .where('actor_user_id', '=', f.other.actorUserId)
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
        { credentialId: ownerCredential, kind },
        f.options,
      );
      await f.db.deleteFrom('project_members').where('project_id', '=', projectId).execute();
      expect(await reconcileExternalServices(f.db, f.options)).toEqual({
        recovered: kind === 'primary' ? 0 : 1,
        failed: 0,
      });
      expect(f.users.has(owner.username ?? '')).toBe(true);
      await f.db
        .updateTable('user')
        .set({ role: 'user' })
        .where('id', '=', f.other.actorUserId)
        .execute();
      expect(await reconcileExternalServices(f.db, f.options)).toEqual({
        recovered: kind === 'primary' ? 1 : 2,
        failed: 0,
      });
      expect(f.users.has(owner.username ?? '')).toBe(false);
      expect(f.users.size).toBe(2);
    },
  );
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
    expect(created.password).toHaveLength(16);
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
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(2);
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
    expect(f.users.size).toBe(1);
    expect(
      (await listSftpCredentials(f.db, f.context, f.serverId)).find(
        (row) => row.id === credentialId,
      )?.state,
    ).toBe('revoked');
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
  it('plans direct DNS from immutable external endpoint and refuses missing endpoints', async () => {
    for (const mode of ['custom-subdomain', 'static-host-port'] as const) {
      const port = mode === 'static-host-port' ? 28091 : 28090;
      const f = await fixture(mode);
      await f.db
        .updateTable('managed_servers')
        .set({ connection_mode: 'direct' })
        .where('id', '=', f.serverId)
        .execute();
      const request = mode === 'custom-subdomain' ? { subdomain: f.subdomain } : {};
      await expect(
        previewServerDns(f.db, f.context, f.serverId, request, f.options),
      ).rejects.toThrow('configuration_invalid');
      await f.db
        .updateTable('server_allocations')
        .set({ direct_endpoint: JSON.stringify({ hostname: 'direct.example.test', port }) })
        .where('server_id', '=', f.serverId)
        .execute();
      const plan = await previewServerDns(f.db, f.context, f.serverId, request, f.options);
      expect(plan.port).toBe(port);
      if (mode === 'static-host-port') expect(plan.hostname).toBe('direct.example.test');
      else {
        expect(plan.records[0]).toMatchObject({ type: 'CNAME', content: 'direct.example.test' });
        expect(plan.records[1]).toMatchObject({ type: 'SRV', data: { port } });
      }
      expect(f.dnsCalls).toEqual([]);
    }
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

async function grantProjectManager(f: Awaited<ReturnType<typeof fixture>>) {
  const projectId = randomUUID();
  await f.db
    .insertInto('projects')
    .values({ id: projectId, owner_id: f.context.actorUserId, name: 'SFTP grants' })
    .execute();
  await f.db
    .updateTable('managed_servers')
    .set({ project_id: projectId })
    .where('id', '=', f.serverId)
    .execute();
  await f.db
    .insertInto('project_members')
    .values({ project_id: projectId, user_id: f.other.actorUserId, role: 'manager' })
    .execute();
  return projectId;
}
async function livePrimaries(f: Awaited<ReturnType<typeof fixture>>) {
  return f.db
    .selectFrom('external_sftp_credentials')
    .selectAll()
    .where('server_id', '=', f.serverId)
    .where('kind', '=', 'primary')
    .where('state', '!=', 'revoked')
    .execute();
}

describe('automatic personal primary SFTP reconciliation', () => {
  it('advances bounded retry batches past a full batch of persistent provider failures', async () => {
    const f = await fixture();
    await reconcileExternalServices(f.db, f.options);
    const original = (await livePrimaries(f))[0];
    if (!original) throw new Error('missing fixture primary');
    const baseIntent = JSON.parse(
      f.codec.decrypt(original.envelope, `external-sftp:${original.id}`),
    );
    const server = await f.db
      .selectFrom('managed_servers')
      .selectAll()
      .where('id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    const ids = Array.from(
      { length: 101 },
      (_, index) => `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    );
    await f.db
      .insertInto('managed_servers')
      .values(
        ids.map((id, index) => ({
          id,
          owner_id: server.owner_id,
          project_id: null,
          mapping_id: server.mapping_id,
          node_id: server.node_id,
          name: 'Batch fixture',
          external_id: `batch-${id}`,
          pterodactyl_id: 500000 + index,
          pterodactyl_uuid: id,
          pterodactyl_identifier: id.slice(0, 8),
          limits: JSON.stringify(server.limits),
          active_operation_id: null,
          last_observed_at: null,
          deleted_at: null,
        })),
      )
      .execute();
    await f.db
      .insertInto('external_sftp_credentials')
      .values(
        ids.map((id) => {
          const username = `batch-${id.slice(0, 8)}`;
          const intent = {
            ...baseIntent,
            request: {
              ...baseIntent.request,
              serverId: id,
              externalServerUuid: id,
              credentialId: id,
              username,
              password: randomBytes(12).toString('base64url'),
            },
          };
          return {
            id,
            server_id: id,
            actor_id: server.owner_id,
            kind: 'primary' as const,
            label: null,
            primary_username: username,
            provider_ref: null,
            expires_at: null,
            state: 'pending' as const,
            envelope: JSON.stringify(
              f.codec.encrypt(JSON.stringify(intent), `external-sftp:${id}`),
            ),
          };
        }),
      )
      .execute();
    const factory = f.options.sftpFactory;
    if (!factory) throw new Error('missing fixture provider');
    f.options.sftpFactory = (config, key) => {
      const provider = factory(config, key);
      const ensure = provider.ensureCredential.bind(provider);
      vi.spyOn(provider, 'ensureCredential').mockImplementation(async (request) => {
        if (request.credentialId !== ids.at(-1)) throw new Error('persistent fixture outage');
        return ensure(request);
      });
      return provider;
    };
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 100 });
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 1, failed: 99 });
    expect(
      await f.db
        .selectFrom('external_sftp_credentials')
        .select('state')
        .where('id', '=', ids.at(-1) ?? '')
        .executeTakeFirst(),
    ).toEqual({ state: 'active' });
  });
  it('creates owner, manager and global Owner accounts without browser sessions, but not read-only/operator access', async () => {
    const f = await fixture();
    const projectId = await grantProjectManager(f);
    const globalOwner = randomUUID(),
      viewer = randomUUID(),
      operator = randomUUID();
    await sql`insert into "user"(id,name,email,role) values
      (${globalOwner},'Owner',${`${globalOwner}@example.test`},'owner'),
      (${viewer},'Viewer',${`${viewer}@example.test`},'user'),
      (${operator},'Operator',${`${operator}@example.test`},'operator')`.execute(f.db);
    await f.db
      .insertInto('project_members')
      .values([
        { project_id: projectId, user_id: viewer, role: 'viewer' },
        { project_id: projectId, user_id: operator, role: 'operator' },
      ])
      .execute();
    await f.db.deleteFrom('session').execute();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 3, failed: 0 });
    const rows = await livePrimaries(f);
    expect(rows.map((row) => row.actor_id).sort()).toEqual(
      [f.context.actorUserId, f.other.actorUserId, globalOwner].sort(),
    );
    for (const row of rows) {
      const intent = JSON.parse(f.codec.decrypt(row.envelope, `external-sftp:${row.id}`));
      expect(intent).toMatchObject({
        service: { kind: 'personal-primary', subjectUserId: row.actor_id },
        delivered: false,
        request: { expiresAt: 0 },
      });
      expect(intent).not.toHaveProperty('context');
      expect(JSON.stringify(row)).not.toContain(intent.request.password);
    }
    expect(
      await f.db
        .selectFrom('audit_events')
        .select(['actor_user_id', 'subject_user_id'])
        .where('action', '=', 'server.sftp.issued')
        .execute(),
    ).toEqual(
      expect.arrayContaining(
        rows.map((row) => ({ actor_user_id: null, subject_user_id: row.actor_id })),
      ),
    );
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 0 });
    expect(f.sftpCalls.filter((call) => call === 'POST')).toHaveLength(3);
  });
  it('shares one encrypted primary with interactive reveal/rotation and concurrent manual creation', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    f.options.verifyServer = async () => {
      entered.resolve();
      await resume.promise;
    };
    const reconciliation = reconcileExternalServices(f.db, f.options);
    await entered.promise;
    await expect(
      createSftpCredential(
        f.db,
        f.context,
        f.serverId,
        { credentialId: randomUUID(), kind: 'primary' },
        f.options,
      ),
    ).rejects.toThrow('conflict');
    expect(await livePrimaries(f)).toHaveLength(1);
    resume.resolve();
    expect(await reconciliation).toEqual({ recovered: 1, failed: 0 });
    const row = (await livePrimaries(f))[0];
    if (!row) throw new Error('missing primary');
    const password = await revealSftpCredential(f.db, f.context, f.serverId, row.id, {}, f.options);
    const claimed = await createSftpCredential(
      f.db,
      f.context,
      f.serverId,
      { credentialId: randomUUID(), kind: 'primary' },
      f.options,
    );
    expect(claimed).toMatchObject({ id: row.id, password: password.password });
    await f.db
      .updateTable('user')
      .set({ role: 'owner' })
      .where('id', '=', f.other.actorUserId)
      .execute();
    await expect(
      revealSftpCredential(f.db, { ...f.other, role: 'owner' }, f.serverId, row.id, {}, f.options),
    ).rejects.toThrow('forbidden');
    const rotated = await rotateSftpCredential(
      f.db,
      f.context,
      f.serverId,
      row.id,
      { rotationId: randomUUID() },
      f.options,
    );
    expect(rotated.password).not.toBe(password.password);
    expect(f.sftpCalls.filter((call) => call === 'POST')).toHaveLength(1);
  });
  it('persists the same credential and password across an uncertain provider response and worker rescan', async () => {
    const f = await fixture();
    f.loseSftp();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 1 });
    const row = (await livePrimaries(f))[0];
    if (!row) throw new Error('missing primary');
    const before = JSON.parse(f.codec.decrypt(row.envelope, `external-sftp:${row.id}`));
    expect(row.state).toBe('uncertain');
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 1, failed: 0 });
    const recovered = (await livePrimaries(f))[0];
    expect(recovered?.id).toBe(row.id);
    expect(
      JSON.parse(f.codec.decrypt(recovered?.envelope, `external-sftp:${row.id}`)).request.password,
    ).toBe(before.request.password);
    expect(f.sftpCalls.filter((call) => call === 'POST')).toHaveLength(1);
  });
  it('retries missing configuration and provider outages without losing the desired grant', async () => {
    const f = await fixture();
    expect(await reconcileExternalServices(f.db, { ...f.options, env: {} })).toEqual({
      recovered: 0,
      failed: 1,
    });
    expect(await livePrimaries(f)).toHaveLength(0);
    f.failSftpWrites(true);
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 1 });
    expect(await livePrimaries(f)).toHaveLength(1);
    f.failSftpWrites(false);
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 1, failed: 0 });
    expect((await livePrimaries(f))[0]?.state).toBe('active');
  });
  it('revokes lost manager access before regranting with a new credential and password', async () => {
    const f = await fixture();
    const projectId = await grantProjectManager(f);
    await reconcileExternalServices(f.db, f.options);
    const original = (await livePrimaries(f)).find((row) => row.actor_id === f.other.actorUserId);
    if (!original) throw new Error('missing manager primary');
    const oldPassword = JSON.parse(
      f.codec.decrypt(original.envelope, `external-sftp:${original.id}`),
    ).request.password;
    await f.db.deleteFrom('project_members').where('project_id', '=', projectId).execute();
    f.failSftpWrites(true);
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 1 });
    expect((await livePrimaries(f)).find((row) => row.id === original.id)?.state).toBe('revoking');
    await f.db
      .insertInto('project_members')
      .values({ project_id: projectId, user_id: f.other.actorUserId, role: 'manager' })
      .execute();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 1 });
    f.failSftpWrites(false);
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 2, failed: 0 });
    const renewed = (await livePrimaries(f)).find((row) => row.actor_id === f.other.actorUserId);
    expect(renewed?.id).not.toBe(original.id);
    expect(renewed?.primary_username).toBe(original.primary_username);
    expect(
      JSON.parse(f.codec.decrypt(renewed?.envelope, `external-sftp:${renewed?.id}`)).request
        .password,
    ).not.toBe(oldPassword);
    expect(f.users.size).toBe(2);
  });
  it('does not issue access revoked during identity verification and revokes deleted servers', async () => {
    const f = await fixture();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 1, failed: 0 });
    const projectId = await grantProjectManager(f);
    const initial = f.options.verifyServer;
    f.options.verifyServer = async (...args) => {
      await initial(...args);
      await f.db.deleteFrom('project_members').where('project_id', '=', projectId).execute();
    };
    await reconcileExternalServices(f.db, f.options);
    await reconcileExternalServices(f.db, f.options);
    expect(f.sftpCalls.filter((method) => method === 'POST')).toHaveLength(1);
    expect((await livePrimaries(f)).map((row) => row.actor_id)).toEqual([f.context.actorUserId]);
    expect(f.users.size).toBe(1);
    await f.db
      .updateTable('managed_servers')
      .set({ deleted_at: new Date() })
      .where('id', '=', f.serverId)
      .execute();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 1, failed: 0 });
    expect(await livePrimaries(f)).toHaveLength(0);
    expect(f.users.size).toBe(0);
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 0 });
  });
  it('never creates accounts while a server operation owns the lifecycle', async () => {
    const f = await fixture();
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: randomUUID() })
      .where('id', '=', f.serverId)
      .execute();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 0, failed: 0 });
    expect(f.sftpCalls).toHaveLength(0);
    await f.db
      .updateTable('managed_servers')
      .set({ active_operation_id: null })
      .where('id', '=', f.serverId)
      .execute();
    expect(await reconcileExternalServices(f.db, f.options)).toEqual({ recovered: 1, failed: 0 });
  });
});

describe('managed domain choices and durable automatic addresses', () => {
  it('recovers legacy zone intents after domain choices change without adopting another zone', async () => {
    const f = await fixture();
    const id = randomUUID();
    await assignServerDns(
      f.db,
      f.context,
      f.serverId,
      { assignmentId: id, subdomain: f.subdomain },
      f.options,
    );
    const row = await f.db
      .selectFrom('dns_assignments')
      .select('plan')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const intent = row.plan as { zoneId: string; instanceId: string };
    await f.db
      .updateTable('dns_assignments')
      .set({
        plan: JSON.stringify({
          ...intent,
          version: 1,
          scope: createHash('sha256')
            .update(JSON.stringify([intent.zoneId, intent.instanceId]))
            .digest('hex'),
        }),
        state: 'uncertain',
      })
      .where('id', '=', id)
      .execute();
    const env: NodeJS.ProcessEnv = {
      ...f.options.env,
      NH_DNS_DOMAINS: JSON.stringify([
        {
          id: 'replacement',
          hostname: 'other.test',
          zoneId: 'b'.repeat(32),
          target: '192.0.2.20',
          enabled: true,
        },
      ]),
    };
    delete env.NH_CLOUDFLARE_ZONE_ID;
    await reconcileExternalServices(f.db, { ...f.options, env });
    expect((await listServerDns(f.db, f.context, f.serverId))[0]).toMatchObject({
      state: 'active',
      connection: { hostname: `${f.subdomain}.example.test` },
    });
    expect(f.records.size).toBe(2);
  });

  it('cancels a foreign-name failure without deleting foreign records and permits a fresh default', async () => {
    const f = await fixture();
    const foreign = {
      id: 'f'.repeat(32),
      type: 'A',
      name: `${f.subdomain}.example.test`,
      content: '192.0.2.10',
      ttl: 120,
      proxied: false,
      comment: 'unrelated-owner',
    };
    f.records.set(foreign.id, foreign);
    const id = randomUUID();
    await expect(
      assignServerDns(
        f.db,
        f.context,
        f.serverId,
        { assignmentId: id, subdomain: f.subdomain },
        f.options,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await listServerDns(f.db, f.context, f.serverId))[0]?.state).toBe('uncertain');
    await deleteServerDns(f.db, f.context, f.serverId, id, f.options);
    expect(f.records.get(foreign.id)).toEqual(foreign);
    const fresh = await assignServerDns(f.db, f.context, f.serverId, {}, f.options);
    expect(fresh.state).toBe('active');
    expect(fresh.id).not.toBe(id);
    expect(f.records.get(foreign.id)).toEqual(foreign);
  });

  it('adopts a pre-preference assignment without creating a second primary', async () => {
    const f = await fixture();
    const original = await assignServerDns(
      f.db,
      f.context,
      f.serverId,
      { subdomain: f.subdomain },
      f.options,
    );
    await f.db.deleteFrom('server_dns_preferences').where('server_id', '=', f.serverId).execute();
    const calls = f.dnsCalls.length;
    expect((await assignServerDns(f.db, f.context, f.serverId, {}, f.options)).id).toBe(
      original.id,
    );
    expect(f.dnsCalls).toHaveLength(calls);
    await expect(
      assignServerDns(
        f.db,
        f.context,
        f.serverId,
        { assignmentId: randomUUID(), subdomain: 'another-name' },
        f.options,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await f.db.selectFrom('dns_assignments').select('id').execute()).toHaveLength(1);
  });

  async function shared(f: Awaited<ReturnType<typeof fixture>>, customizable = true) {
    const mapping = await f.db
      .selectFrom('managed_servers as s')
      .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
      .select('m.game_id')
      .where('s.id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    await sql`update game_integrations set manifest=jsonb_set(manifest,'{connection}',${JSON.stringify({ mode: 'shared-host', defaultLabel: 'fixture-shared', allowCustomSubdomain: customizable })}::jsonb) where id=${mapping.game_id}`.execute(
      f.db,
    );
  }
  it('does not opt existing servers into automatic publication, then persists one generated name after explicit opt-in', async () => {
    const f = await fixture();
    await reconcileExternalServices(f.db, f.options);
    expect(f.dnsCalls).toEqual([]);
    const generated = await assignServerDns(f.db, f.context, f.serverId, {}, f.options);
    expect(generated.connection.hostname).toMatch(/^[a-z]+-[a-z]+-[a-z]+\.example\.test$/);
    expect(
      (await assignServerDns(f.db, f.context, f.serverId, {}, f.options)).connection.hostname,
    ).toBe(generated.connection.hostname);
    expect(f.records.size).toBe(2);
  });
  it('pins generated preview and resolves Gateway public port instead of backend port', async () => {
    const f = await fixture();
    await f.db
      .updateTable('gateway_routes')
      .set({ public_port: 28001 })
      .where('server_id', '=', f.serverId)
      .execute();
    const preview = await previewServerDns(f.db, f.context, f.serverId, {}, f.options);
    expect(preview.port).toBe(28001);
    expect(preview.records[1]).toMatchObject({ type: 'SRV', data: { port: 28001 } });
    const saved = await assignServerDns(
      f.db,
      f.context,
      f.serverId,
      { subdomain: preview.subdomain, domainId: preview.domainId },
      f.options,
    );
    expect(saved.connection).toMatchObject({
      hostname: preview.hostname,
      displayAddress: preview.hostname,
    });
  });
  it('does not reserve names when credentials are unavailable', async () => {
    const f = await fixture();
    const env = { ...f.options.env };
    delete env.NH_CLOUDFLARE_API_TOKEN;
    await expect(
      assignServerDns(
        f.db,
        f.context,
        f.serverId,
        { subdomain: f.subdomain },
        { ...f.options, env },
      ),
    ).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(await f.db.selectFrom('dns_hostname_reservations').selectAll().execute()).toEqual([]);
    expect(await f.db.selectFrom('dns_assignments').selectAll().execute()).toEqual([]);
  });
  it('applies domain policies and an empty-by-default term blacklist without changing existing names', async () => {
    const f = await fixture();
    const env: NodeJS.ProcessEnv = {
      ...f.options.env,
      NH_DNS_DOMAINS: JSON.stringify([
        {
          id: 'first',
          hostname: 'example.test',
          zoneId: 'a'.repeat(32),
          target: '192.0.2.10',
          enabled: true,
        },
        {
          id: 'second',
          hostname: 'other.test',
          zoneId: 'b'.repeat(32),
          target: '192.0.2.20',
          enabled: true,
        },
      ]),
      NH_DNS_BLOCKED_TERMS: JSON.stringify([{ value: 'bad', match: 'word' }]),
    };
    await expect(
      previewServerDns(
        f.db,
        f.context,
        f.serverId,
        { domainId: 'second', subdomain: 'a-bad-name' },
        { ...f.options, env },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const plan = await previewServerDns(
      f.db,
      f.context,
      f.serverId,
      { domainId: 'second', subdomain: 'valid-name' },
      { ...f.options, env },
    );
    expect(plan.hostname).toBe('valid-name.other.test');
    expect(plan.records[0]).toMatchObject({ content: '192.0.2.20' });
  });
  it('renames across zones, keeps the old confirmed address during failure, then recovers and quarantines the old name', async () => {
    const f = await fixture();
    const options = {
      ...f.options,
      env: {
        ...f.options.env,
        NH_DNS_DOMAINS: JSON.stringify([
          {
            id: 'first',
            hostname: 'example.test',
            zoneId: 'a'.repeat(32),
            target: '192.0.2.10',
            enabled: true,
          },
          {
            id: 'second',
            hostname: 'other.test',
            zoneId: 'b'.repeat(32),
            target: '192.0.2.20',
            enabled: true,
          },
        ]),
        NH_DNS_NAME_REUSE_DELAY_SECONDS: '60',
      },
    };
    const id = randomUUID();
    await assignServerDns(
      f.db,
      f.context,
      f.serverId,
      { assignmentId: id, domainId: 'first', subdomain: 'old-name' },
      options,
    );
    f.failDns(true);
    await expect(
      updateServerDns(
        f.db,
        f.context,
        f.serverId,
        id,
        { domainId: 'second', subdomain: 'new-name' },
        options,
      ),
    ).rejects.toBeDefined();
    expect((await listServerDns(f.db, f.context, f.serverId))[0]?.connection.hostname).toBe(
      'old-name.example.test',
    );
    expect(f.records.size).toBe(2);
    f.failDns(false);
    await reconcileExternalServices(f.db, options);
    expect((await listServerDns(f.db, f.context, f.serverId))[0]).toMatchObject({
      state: 'active',
      connection: { hostname: 'new-name.other.test' },
    });
    expect(
      [...f.records.values()].every((record) =>
        String(record.name).includes('new-name.other.test'),
      ),
    ).toBe(true);
    await deleteServerDns(f.db, f.context, f.serverId, id, options);
    await expect(
      assignServerDns(
        f.db,
        f.context,
        f.serverId,
        { assignmentId: randomUUID(), domainId: 'first', subdomain: 'old-name' },
        options,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    f.tick();
    await assignServerDns(
      f.db,
      f.context,
      f.serverId,
      { assignmentId: randomUUID(), domainId: 'first', subdomain: 'old-name' },
      options,
    );
  });
  it('keeps shared host ownership after server cleanup and removes old custom records when reverting to shared', async () => {
    const f = await fixture();
    await shared(f);
    const id = randomUUID();
    await assignServerDns(
      f.db,
      f.context,
      f.serverId,
      { assignmentId: id, subdomain: 'custom-name' },
      f.options,
    );
    expect(f.records.size).toBe(1);
    const result = await updateServerDns(f.db, f.context, f.serverId, id, {}, f.options);
    expect(result.connection.displayAddress).toMatch(/^fixture-shared\.example\.test:\d+$/);
    expect(f.records.size).toBe(1);
    expect([...f.records.values()][0]?.name).toBe('fixture-shared.example.test');
    await deleteServerDns(f.db, f.context, f.serverId, id, f.options);
    expect(f.records.size).toBe(1);
    expect(await f.db.selectFrom('shared_dns_hosts').select('state').execute()).toEqual([
      { state: 'active' },
    ]);
  });
  it('updates owned shared targets and uses the configured host instead of a direct endpoint override', async () => {
    const f = await fixture();
    await shared(f);
    await f.db
      .updateTable('managed_servers')
      .set({ connection_mode: 'direct' })
      .where('id', '=', f.serverId)
      .execute();
    await f.db
      .updateTable('server_allocations')
      .set({ direct_endpoint: JSON.stringify({ hostname: 'different.example.test', port: 27001 }) })
      .where('server_id', '=', f.serverId)
      .execute();
    const created = await assignServerDns(f.db, f.context, f.serverId, {}, f.options);
    expect(created.connection.displayAddress).toBe('fixture-shared.example.test:27001');
    const before = [...f.records.values()][0];
    expect(before).toMatchObject({ content: '192.0.2.10' });
    await reconcileExternalServices(f.db, {
      ...f.options,
      env: { ...f.options.env, NH_DNS_TARGET: '192.0.2.99' },
    });
    expect(f.records.size).toBe(1);
    expect([...f.records.values()][0]).toMatchObject({
      id: before?.id,
      comment: before?.comment,
      content: '192.0.2.99',
    });
  });
  it('reconciles new creation preferences once without requiring a browser session', async () => {
    const f = await fixture();
    await f.db
      .insertInto('server_dns_preferences')
      .values({
        server_id: f.serverId,
        domain_id: 'legacy',
        subdomain: null,
        assignment_id: null,
        enabled: true,
      })
      .execute();
    await f.db.deleteFrom('session').where('userId', '=', f.context.actorUserId).execute();
    await reconcileExternalServices(f.db, f.options);
    const rows = await f.db.selectFrom('dns_assignments').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('active');
    await reconcileExternalServices(f.db, f.options);
    expect(await f.db.selectFrom('dns_assignments').select('id').execute()).toHaveLength(1);
  });
});

describe('wizard DNS availability and reservations', () => {
  async function ready() {
    const f = await fixture();
    await f.db
      .insertInto('game_rollouts')
      .values({ integration_id: f.gameId, state: 'public', allowlist: [] })
      .execute();
    return f;
  }
  it('suggests and reserves generated names using only local claims, even if the DNS provider is unavailable', async () => {
    const f = await ready();
    const provider = vi.fn(() => {
      throw new Error('must not contact DNS');
    });
    f.options.dnsFactory = provider;
    const result = await suggestGameConnection(f.db, f.context, f.gameId, {}, f.options);
    expect(result).toMatchObject({ available: true, domainId: 'legacy' });
    expect(result.subdomain.split('-')).toHaveLength(3);
    expect(result.hostname).toBe(`${result.subdomain}.example.test`);
    expect(f.records.size).toBe(0);
    expect(await f.db.selectFrom('dns_hostname_reservations').selectAll().execute()).toEqual([]);
    expect(await f.db.selectFrom('dns_assignments').selectAll().execute()).toEqual([]);
    const selection = { domainId: result.domainId, subdomain: result.subdomain };
    const held = await reserveGameConnection(f.db, f.context, f.gameId, selection, f.options);
    expect(held.hostname).toBe(result.hostname);
    expect(
      await getGameConnectionAvailability(f.db, f.context, f.gameId, selection, f.options),
    ).toEqual({ available: true, hostname: result.hostname });
    expect(
      await getGameConnectionAvailability(f.db, f.other, f.gameId, selection, f.options),
    ).toEqual({ available: false, hostname: result.hostname });
    await expect(
      reserveGameConnection(f.db, f.other, f.gameId, selection, f.options),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(provider).not.toHaveBeenCalled();
    expect(f.dnsCalls).toEqual([]);
  });
  it('keeps generated-name claims, reuse cooldowns and reservation races authoritative locally', async () => {
    const f = await ready();
    const provider = vi.fn(() => {
      throw new Error('must not contact DNS');
    });
    f.options.dnsFactory = provider;
    const subdomain = 'cute-panda-bag';
    const hostname = `${subdomain}.example.test`;
    const check = () =>
      getGameConnectionAvailability(f.db, f.context, f.gameId, { subdomain }, f.options);
    await f.db
      .insertInto('dns_hostname_reservations')
      .values({
        hostname,
        owner_id: f.serverId,
        release_after: null,
      })
      .execute();
    expect((await check()).available).toBe(false);
    await f.db
      .updateTable('dns_hostname_reservations')
      .set({ release_after: new Date((f.options.now?.() ?? new Date()).getTime() + 60_000) })
      .where('hostname', '=', hostname)
      .execute();
    expect((await check()).available).toBe(false);
    await f.db
      .updateTable('dns_hostname_reservations')
      .set({ release_after: new Date(0) })
      .where('hostname', '=', hostname)
      .execute();
    expect((await check()).available).toBe(true);
    const attempts = await Promise.allSettled(
      [f.context, f.other].map((context) =>
        reserveGameConnection(f.db, context, f.gameId, { subdomain }, f.options),
      ),
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = attempts.find((r) => r.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toMatchObject({ code: 'conflict' });
    expect(provider).not.toHaveBeenCalled();
  });
  it('checks custom labels remotely even when they contain three words', async () => {
    const f = await ready();
    f.options.env = { ...f.options.env, NH_CLOUDFLARE_API_TOKEN: randomUUID() };
    await getGameConnectionAvailability(
      f.db,
      f.context,
      f.gameId,
      { subdomain: 'my-custom-server' },
      f.options,
    );
    expect(f.dnsCalls).toEqual(['GET', 'GET']);
    f.options.env = {
      ...f.options.env,
      NH_DNS_BLOCKED_TERMS: '[{"value":"panda","match":"word"}]',
    };
    await expect(
      reserveGameConnection(f.db, f.context, f.gameId, { subdomain: 'cute-panda-bag' }, f.options),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(f.dnsCalls).toEqual(['GET', 'GET']);
  });
  it('skips prohibited names locally and rejects invalid domains and unauthorized suggestions before provider reads', async () => {
    const f = await ready();
    f.options.env = {
      ...f.options.env,
      NH_DNS_BLOCKED_TERMS: JSON.stringify(dnsNameWords.map((value) => ({ value, match: 'word' }))),
    };
    await expect(
      suggestGameConnection(f.db, f.context, f.gameId, {}, f.options),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      suggestGameConnection(f.db, f.context, f.gameId, { domainId: 'foreign' }, f.options),
    ).rejects.toMatchObject({ code: 'configuration_invalid' });
    await expect(
      suggestGameConnection(
        f.db,
        { ...f.context, sessionType: 'support' },
        f.gameId,
        {},
        f.options,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'private-testing', allowlist: [] })
      .where('integration_id', '=', f.gameId)
      .execute();
    await expect(
      suggestGameConnection(f.db, f.context, f.gameId, {}, f.options),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.dnsCalls).toEqual([]);
    expect(await f.db.selectFrom('dns_hostname_reservations').selectAll().execute()).toEqual([]);
  });
  it('leaves static and fixed shared-host modes unchanged', async () => {
    const f = await ready();
    for (const connection of [
      { mode: 'static-host-port', hostnameSettingKey: 'staticGameHostname', showPort: true },
      { mode: 'shared-host', defaultLabel: 'shared', allowCustomSubdomain: false },
    ]) {
      await sql`update game_integrations set manifest=jsonb_set(manifest,'{connection}',${JSON.stringify(connection)}::jsonb) where id=${f.gameId}`.execute(
        f.db,
      );
      await expect(
        suggestGameConnection(f.db, f.context, f.gameId, {}, f.options),
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(f.dnsCalls).toEqual([]);
  });
  it('checks exact hostname and SRV once, caches provider reads but never local claims', async () => {
    const f = await ready();
    const check = (subdomain: string, context = f.context) =>
      getGameConnectionAvailability(f.db, context, f.gameId, { subdomain }, f.options);
    const results = await Promise.all([check('available'), check('available')]);
    expect(results).toEqual([
      { available: true, hostname: 'available.example.test' },
      { available: true, hostname: 'available.example.test' },
    ]);
    expect(f.dnsCalls).toEqual(['GET', 'GET']);
    const hold = await reserveGameConnection(
      f.db,
      f.context,
      f.gameId,
      { subdomain: 'available' },
      f.options,
    );
    expect((await check('available')).available).toBe(true);
    expect((await check('available', f.other)).available).toBe(false);
    expect(f.dnsCalls).toHaveLength(2);
    f.records.set('foreign', {
      id: 'foreign',
      name: '_fixture._tcp.occupied.example.test',
      type: 'TXT',
      content: 'foreign',
    });
    expect((await check('occupied')).available).toBe(false);
    await f.db
      .updateTable('game_rollouts')
      .set({ state: 'private-testing', allowlist: [] })
      .where('integration_id', '=', f.gameId)
      .execute();
    await expect(check('hidden')).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.dnsCalls).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(hold.reservationId).toEqual(expect.any(String));
  });
  it('atomically holds names across accounts, caps holds and preserves the prior choice on conflict', async () => {
    const f = await ready();
    const reserve = (subdomain: string, context = f.context, previousReservationId?: string) =>
      reserveDnsWizardHostname(f.db, context, f.gameId, {
        domainId: 'legacy',
        subdomain,
        hostname: `${subdomain}.example.test`,
        previousReservationId,
      });
    const attempts = await Promise.allSettled([reserve('same'), reserve('same', f.other)]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const previous = await reserve('original');
    // Use a guaranteed foreign claim for rollback regardless of race winner.
    await reserve('foreign', f.other);
    await expect(reserve('foreign', f.context, previous.reservationId)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(
      await f.db
        .selectFrom('dns_hostname_reservations')
        .select('owner_id')
        .where('owner_id', '=', previous.reservationId)
        .executeTakeFirst(),
    ).toBeDefined();
    const replacement = await reserve('replacement', f.context, previous.reservationId);
    expect(
      await f.db
        .selectFrom('dns_hostname_reservations')
        .select('owner_id')
        .where('owner_id', '=', previous.reservationId)
        .executeTakeFirst(),
    ).toBeUndefined();
    for (let n = 0; n < 5; n++) {
      const count = await f.db
        .selectFrom('dns_hostname_reservations')
        .select(f.db.fn.countAll<string>().as('count'))
        .where('wizard_user_id', '=', f.context.subjectUserId)
        .executeTakeFirstOrThrow();
      if (Number(count.count) < 5) await reserve(`hold-${n}`);
    }
    await expect(reserve('sixth')).rejects.toMatchObject({ code: 'rate_limited' });
    await f.db
      .updateTable('dns_hostname_reservations')
      .set({ release_after: new Date(0) })
      .where('owner_id', '=', replacement.reservationId)
      .execute();
    await reserve('replacement', f.other);
    expect(f.dnsCalls).toEqual([]);
  });
  it('returns a domain conflict when unreserved creation races a wizard hold', async () => {
    const f = await ready();
    for (let n = 0; n < 3; n++) {
      const subdomain = `race-${n}`;
      const attempts = await Promise.allSettled([
        f.db
          .transaction()
          .execute((tx) =>
            consumeDnsWizardReservation(
              tx,
              f.context,
              f.gameId,
              f.serverId,
              { subdomain },
              f.options.env,
            ),
          ),
        reserveDnsWizardHostname(f.db, f.other, f.gameId, {
          domainId: 'legacy',
          subdomain,
          hostname: `${subdomain}.example.test`,
        }),
      ]);
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failure = attempts.find((r) => r.status === 'rejected');
      expect(failure?.status === 'rejected' && failure.reason).toMatchObject({ code: 'conflict' });
    }
  });
  it('transfers a consumed hold through automatic DNS and releases a deleted pre-intent claim', async () => {
    const f = await ready();
    const held = await reserveGameConnection(
      f.db,
      f.context,
      f.gameId,
      { subdomain: 'transfer' },
      f.options,
    );
    await f.db
      .transaction()
      .execute((tx) =>
        consumeDnsWizardReservation(
          tx,
          f.context,
          f.gameId,
          f.serverId,
          { subdomain: 'transfer', reservationId: held.reservationId },
          f.options.env,
        ),
      );
    await f.db
      .insertInto('server_dns_preferences')
      .values({ server_id: f.serverId, enabled: true, domain_id: 'legacy', subdomain: 'transfer' })
      .execute();
    await reconcileExternalServices(f.db, f.options);
    const assigned = await f.db
      .selectFrom('dns_assignments')
      .selectAll()
      .where('id', '=', f.serverId)
      .executeTakeFirstOrThrow();
    expect(assigned.state).toBe('active');
    expect(
      (
        await f.db
          .selectFrom('dns_hostname_reservations')
          .selectAll()
          .where('hostname', '=', held.hostname)
          .executeTakeFirstOrThrow()
      ).owner_id,
    ).toBe(f.serverId);
    const g = await ready();
    const pending = await reserveGameConnection(
      g.db,
      g.context,
      g.gameId,
      { subdomain: 'pending' },
      g.options,
    );
    await g.db
      .transaction()
      .execute((tx) =>
        consumeDnsWizardReservation(
          tx,
          g.context,
          g.gameId,
          g.serverId,
          { subdomain: 'pending', reservationId: pending.reservationId },
          g.options.env,
        ),
      );
    await cleanupServerExternalServices(g.db, g.serverId, g.options);
    expect(
      (
        await g.db
          .selectFrom('dns_hostname_reservations')
          .select('release_after')
          .where('hostname', '=', pending.hostname)
          .executeTakeFirstOrThrow()
      ).release_after,
    ).not.toBeNull();
  });
});
