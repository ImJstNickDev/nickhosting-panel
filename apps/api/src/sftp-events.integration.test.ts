import { randomBytes, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createApp } from './app.js';
import { SFTP_EVENTS_PATH, type SftpEvent, sftpEventAuditId } from './sftp-events.js';

describe('SFTPGo machine events', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: ReturnType<typeof createApp>;
  let serverId: string;
  let actorId: string;
  let primaryUsername: string;
  let auxiliaryUsername: string;
  const instanceId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  const identity = vi.fn(async (): Promise<never> => {
    throw new Error('No browser identity');
  });
  beforeAll(async () => {
    database = await createTestDatabase();
    const fixture = await managementFixture(database.db);
    serverId = await fixture.server();
    actorId = fixture.context.actorUserId;
    const server = await database.db
      .selectFrom('managed_servers')
      .select('pterodactyl_uuid')
      .where('id', '=', serverId)
      .executeTakeFirstOrThrow();
    await database.db
      .updateTable('platform_settings')
      .set({ value: { sftpgoInstanceId: instanceId } })
      .where('key', '=', 'platform')
      .execute();
    await database.db
      .insertInto('encrypted_secrets')
      .values({ name: 'sftpgoEventSecret', envelope: codec.encrypt(secret, 'sftpgoEventSecret') })
      .execute();
    for (const kind of ['primary', 'auxiliary'] as const) {
      const id = randomUUID();
      const username = kind === 'primary' ? 'player_abcd' : `nh_${id.replaceAll('-', '')}`;
      if (kind === 'primary') primaryUsername = username;
      else auxiliaryUsername = username;
      await database.db
        .insertInto('external_sftp_credentials')
        .values({
          id,
          server_id: serverId,
          actor_id: actorId,
          kind,
          primary_username: kind === 'primary' ? username : null,
          envelope: JSON.stringify({}),
          state: 'active',
          expires_at: kind === 'primary' ? null : new Date(Date.now() + 3600_000),
          provider_ref: JSON.stringify({
            instanceId,
            serverId,
            externalServerUuid: server.pterodactyl_uuid,
            credentialId: id,
            username,
            externalUserId: 123,
            expiresAt: 0,
            quotaBytes: 0,
          }),
        })
        .execute();
    }
    app = createApp({ database, identity, codec, origins: ['https://app.example.test'] });
  });
  afterAll(async () => {
    await database?.destroy();
  });
  const event = (patch: Partial<SftpEvent> = {}): SftpEvent => ({
    schemaVersion: 1,
    instanceId,
    eventId: randomUUID(),
    timestamp: `${BigInt(Date.now()) * 1_000_000n}`,
    username: primaryUsername,
    event: 'upload',
    status: 1,
    virtualPath: '/world/a.dat',
    virtualTargetPath: '',
    fileSize: 12,
    protocol: 'SFTP',
    ...patch,
  });
  const send = (value: unknown, headers: Record<string, string> = {}) =>
    app.request(SFTP_EVENTS_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        ...headers,
      },
      body: JSON.stringify(value),
    });
  const audits = () =>
    database.db
      .selectFrom('audit_events')
      .selectAll()
      .where('action', 'like', 'server.sftp.file.%')
      .execute();
  it('authenticates machine-only, attributes the persisted actor, and deduplicates concurrent retries', async () => {
    const value = event();
    expect((await Promise.all([send(value), send(value)])).map((r) => r.status)).toEqual([
      200, 200,
    ]);
    const rows = (await audits()).filter((r) => r.id === sftpEventAuditId(value));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: actorId,
      subject_user_id: actorId,
      action: 'server.sftp.file.upload',
      metadata: {
        serverId,
        outcome: 'succeeded',
        path: '/world/a.dat',
        bytes: 12,
        credentialUsername: primaryUsername,
        source: 'sftp',
      },
    });
    expect(identity).not.toHaveBeenCalled();
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
  it('keeps auxiliary username as details and the same real panel actor for failures', async () => {
    const value = event({
      username: auxiliaryUsername,
      event: 'rename',
      status: 2,
      virtualTargetPath: '/world/b.dat',
    });
    expect((await send(value)).status).toBe(200);
    expect((await audits()).find((r) => r.id === sftpEventAuditId(value))).toMatchObject({
      actor_user_id: actorId,
      metadata: {
        credentialUsername: auxiliaryUsername,
        outcome: 'failed',
        target: '/world/b.dat',
      },
    });
  });
  it('audits a retained transport event after its auxiliary credential expires', async () => {
    const credential = await database.db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('server_id', '=', serverId)
      .where('kind', '=', 'auxiliary')
      .executeTakeFirstOrThrow();
    const expiredAt = new Date(Date.now() - 1000);
    await database.db
      .updateTable('external_sftp_credentials')
      .set({ expires_at: expiredAt })
      .where('id', '=', credential.id)
      .execute();
    try {
      const value = event({ username: auxiliaryUsername });
      expect(BigInt(value.timestamp)).toBeGreaterThan(BigInt(expiredAt.getTime()) * 1_000_000n);
      const response = await send(value);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true, ignored: false });
      expect((await audits()).find((row) => row.id === sftpEventAuditId(value))).toMatchObject({
        actor_user_id: actorId,
        subject_user_id: actorId,
        metadata: { serverId, credentialUsername: auxiliaryUsername, outcome: 'succeeded' },
      });
      expect(
        (
          await database.db
            .selectFrom('external_sftp_credentials')
            .select('expires_at')
            .where('id', '=', credential.id)
            .executeTakeFirstOrThrow()
        ).expires_at,
      ).toEqual(expiredAt);
    } finally {
      await database.db
        .updateTable('external_sftp_credentials')
        .set({ expires_at: credential.expires_at })
        .where('id', '=', credential.id)
        .execute();
    }
  });
  it('ignores an ambiguous instance and username shared by valid bindings for different actors and servers', async () => {
    const other = await managementFixture(database.db);
    const otherServerId = await other.server();
    const server = await database.db
      .selectFrom('managed_servers')
      .select('pterodactyl_uuid')
      .where('id', '=', otherServerId)
      .executeTakeFirstOrThrow();
    const id = randomUUID();
    await database.db
      .insertInto('external_sftp_credentials')
      .values({
        id,
        server_id: otherServerId,
        actor_id: other.context.actorUserId,
        kind: 'auxiliary',
        primary_username: null,
        envelope: JSON.stringify({}),
        state: 'active',
        expires_at: new Date(Date.now() + 3600_000),
        created_at: new Date(Date.now() - 1000),
        provider_ref: JSON.stringify({
          instanceId,
          serverId: otherServerId,
          externalServerUuid: server.pterodactyl_uuid,
          credentialId: id,
          username: auxiliaryUsername,
          externalUserId: 456,
          expiresAt: 0,
          quotaBytes: 0,
        }),
      })
      .execute();
    const value = event({ username: auxiliaryUsername });
    const before = (await audits()).length;
    try {
      expect(other.context.actorUserId).not.toBe(actorId);
      expect(otherServerId).not.toBe(serverId);
      const response = await send(value);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true, ignored: true });
      expect(await audits()).toHaveLength(before);
    } finally {
      await database.db.deleteFrom('external_sftp_credentials').where('id', '=', id).execute();
    }
    // Ignoring ambiguity must not reserve the event ID or block a later attributable delivery.
    expect(await (await send(value)).json()).toEqual({ received: true, ignored: false });
    expect((await audits()).find((row) => row.id === sftpEventAuditId(value))).toMatchObject({
      actor_user_id: actorId,
      metadata: { serverId, credentialUsername: auxiliaryUsername },
    });
  });
  it('does not let retries rewrite a successful operation into a delivery failure', async () => {
    const value = event();
    await send(value);
    await send({ ...value, status: 2 });
    expect((await audits()).find((r) => r.id === sftpEventAuditId(value))?.metadata.outcome).toBe(
      'succeeded',
    );
  });
  it.each(['download', 'delete', 'mkdir', 'rmdir', 'copy'] as const)(
    'records supported %s outcomes',
    async (action) => {
      const value = event({
        event: action,
        virtualTargetPath: action === 'copy' ? '/world/c.dat' : '',
      });
      expect((await send(value)).status).toBe(200);
      expect((await audits()).find((r) => r.id === sftpEventAuditId(value))?.action).toBe(
        `server.sftp.file.${action}`,
      );
    },
  );
  it('attributes primary regrants and events during rotation', async () => {
    const original = await database.db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('kind', '=', 'primary')
      .executeTakeFirstOrThrow();
    const id = randomUUID();
    await database.db
      .updateTable('external_sftp_credentials')
      .set({ state: 'revoked' })
      .where('id', '=', original.id)
      .execute();
    try {
      await database.db
        .insertInto('external_sftp_credentials')
        .values({
          ...original,
          envelope: JSON.stringify(original.envelope),
          id,
          state: 'pending',
          provider_ref: JSON.stringify({
            ...(original.provider_ref as Record<string, unknown>),
            credentialId: id,
          }),
          created_at: new Date(Date.now() - 1000),
          expires_at: null,
        })
        .execute();
      const value = event();
      expect((await send(value)).status).toBe(200);
      expect((await audits()).find((row) => row.id === sftpEventAuditId(value))).toMatchObject({
        actor_user_id: actorId,
        metadata: { credentialUsername: primaryUsername },
      });
    } finally {
      await database.db.deleteFrom('external_sftp_credentials').where('id', '=', id).execute();
      await database.db
        .updateTable('external_sftp_credentials')
        .set({ state: 'active' })
        .where('id', '=', original.id)
        .execute();
    }
  });
  it('rejects absent/wrong auth even with cookie and Origin', async () => {
    for (const authorization of ['', 'Bearer wrong'])
      expect(
        (
          await send(event(), {
            authorization,
            origin: 'https://app.example.test',
            cookie: 'session=forged',
          })
        ).status,
      ).toBe(403);
  });
  it('ignores unknown and technical viewer accounts without importing anything', async () => {
    const before = (await audits()).length;
    for (const username of ['unknown_person', `nhv_${randomUUID().replaceAll('-', '')}`]) {
      const response = await send(event({ username }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true, ignored: true });
    }
    expect(await audits()).toHaveLength(before);
  });
  it('rejects mismatched instance and persisted provider ownership', async () => {
    expect((await send(event({ instanceId: randomUUID() }))).status).toBe(403);
    const row = await database.db
      .selectFrom('external_sftp_credentials')
      .selectAll()
      .where('primary_username', '=', primaryUsername)
      .executeTakeFirstOrThrow();
    await database.db
      .updateTable('external_sftp_credentials')
      .set({
        provider_ref: JSON.stringify({ ...(row.provider_ref as object), serverId: randomUUID() }),
      })
      .where('id', '=', row.id)
      .execute();
    try {
      expect(await (await send(event())).json()).toEqual({ received: true, ignored: true });
    } finally {
      await database.db
        .updateTable('external_sftp_credentials')
        .set({ provider_ref: JSON.stringify(row.provider_ref) })
        .where('id', '=', row.id)
        .execute();
    }
  });
  it.each([
    { virtualPath: '/../private' },
    { virtualPath: '/a//b' },
    { virtualPath: '/a\\b' },
    { virtualPath: '/a\nsecret' },
    { fsPath: '/private/host/root' },
    { timestamp: 1790000000000000000 },
    { timestamp: '99999999999999999999' },
    { fileSize: -1 },
    { status: 0 },
    { event: 'pre-upload' },
    { protocol: 'HTTP' },
    { event: 'rename' },
  ])('rejects malformed or unsafe event %j', async (patch) => {
    expect((await send({ ...event(), ...patch })).status).toBe(400);
  });
  it('bounds body and requires JSON', async () => {
    expect(
      (
        await app.request(SFTP_EVENTS_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: ' '.repeat(65537),
        })
      ).status,
    ).toBe(413);
    expect((await app.request(SFTP_EVENTS_PATH, { method: 'POST', body: '{}' })).status).toBe(400);
  });
  it('is disabled without a dedicated secret', async () => {
    await database.db
      .deleteFrom('encrypted_secrets')
      .where('name', '=', 'sftpgoEventSecret')
      .execute();
    try {
      expect((await send(event())).status).toBe(503);
    } finally {
      await database.db
        .insertInto('encrypted_secrets')
        .values({ name: 'sftpgoEventSecret', envelope: codec.encrypt(secret, 'sftpgoEventSecret') })
        .execute();
    }
  });
  it('keeps normal mutation Origin enforcement', async () => {
    expect(
      (
        await app.request('/v1/owner/settings', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });
});
