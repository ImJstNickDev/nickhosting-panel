import { randomBytes } from 'node:crypto';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../../packages/auth/src/test-fixtures.js';
import { managementFixture } from '../../../packages/server-management/src/test-fixtures.js';
import { createApp } from './app.js';

describe('M5 additive platform HTTP contracts with actual identity/session handlers', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let f: Awaited<ReturnType<typeof managementFixture>>;
  let app: ReturnType<typeof createApp>;
  let owner: AuthClient, user: AuthClient, peer: AuthClient;
  let peerId: string;
  const origin = 'http://localhost:3999',
    password = 'Isolated-platform-password-639!';
  const mails: IdentityMail[] = [];
  async function request(
    client: AuthClient | null,
    path: string,
    data?: unknown,
    method?: string,
    extra: Record<string, string> = {},
  ) {
    const headers = client?.headers(extra) ?? new Headers({ origin, ...extra });
    if (data !== undefined) headers.set('content-type', 'application/json');
    const response = await app.request(
      `${origin}${path}`,
      {
        method: method ?? (data === undefined ? 'GET' : 'POST'),
        headers,
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      },
      {
        incoming: {
          socket: {
            remoteAddress: client?.headers().get('x-nh-client-ip') ?? '192.0.2.254',
            remotePort: 51000,
            remoteFamily: 'IPv4',
          },
        },
      },
    );
    client?.absorb(response);
    return response;
  }
  async function verify(client: AuthClient, email: string) {
    const mail = mails.findLast((m) => m.to === email && m.template === 'verify-email');
    if (!mail) throw new Error('Missing isolated verification mail');
    const url = new URL(mail.url);
    expect((await request(client, `${url.pathname}${url.search}`)).status).toBe(302);
    const response = await request(client, '/api/auth/sign-in/email', { email, password });
    expect(response.status).toBe(200);
    return (await response.json()).user.id as string;
  }
  async function invited(client: AuthClient, email: string) {
    const invite = await request(owner, '/v1/owner/invitations', { email });
    expect(invite.status).toBe(201);
    const token = (await invite.json()).token as string;
    expect(
      (
        await request(
          client,
          '/api/auth/sign-up/email',
          { name: 'Isolated member', email, password },
          'POST',
          { 'x-invitation-token': token },
        )
      ).status,
    ).toBe(200);
    return verify(client, email);
  }
  beforeAll(async () => {
    database = await createTestDatabase();
    f = await managementFixture(database.db);
    await f.db.deleteFrom('user').where('id', '=', f.owner.actorUserId).execute();
    const bootstrapToken = randomBytes(32).toString('base64url');
    const identity = createIdentity({
      pool: database.pool,
      baseURL: origin,
      authSecret: randomBytes(32).toString('base64url'),
      bootstrapToken,
      mail: async (m) => {
        mails.push(m);
      },
      completeSetup: async () => {},
    });
    owner = new AuthClient(identity);
    user = new AuthClient(identity);
    peer = new AuthClient(identity);
    app = createApp({
      database,
      identity: async () => identity,
      codec: new SecretCodec({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
      origins: [origin],
      log: () => {},
    });
    const claim = await request(owner, '/v1/setup/owner', {
      token: bootstrapToken,
      name: 'Owner',
      email: 'platform-owner@example.test',
      password,
    });
    expect(claim.status, await claim.text()).toBe(201);
    const ownerId = await verify(owner, 'platform-owner@example.test');
    f.owner.actorUserId = ownerId;
    f.owner.subjectUserId = ownerId;
    const userId = await invited(user, 'platform-user@example.test');
    f.context.actorUserId = userId;
    f.context.subjectUserId = userId;
    peerId = await invited(peer, 'platform-peer@example.test');
  });
  afterAll(async () => {
    await database?.destroy();
  });
  it('requires verified session and Owner role, rejects forged origin, preserves existing list shape', async () => {
    for (const path of [
      '/v1/platform/servers',
      '/v1/platform/quotas',
      '/v1/platform/activity',
      '/v1/platform/owner/users',
    ])
      expect((await request(null, path)).status).toBe(401);
    expect((await request(user, '/v1/platform/owner/users')).status).toBe(403);
    expect((await request(owner, '/v1/platform/owner/users?limit=1')).status).toBe(200);
    const id = await f.server();
    expect(
      (
        await request(user, `/v1/platform/servers/${id}`, { name: 'Forged' }, 'PATCH', {
          origin: 'https://attacker.example.test',
        })
      ).status,
    ).toBe(403);
    expect(Array.isArray(await (await request(user, '/v1/servers')).json())).toBe(true);
    const response = await request(user, '/v1/platform/servers?limit=1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ items: [{ id }], nextCursor: null });
    expect((await request(user, '/v1/platform/servers?limit=0')).status).toBe(400);
  });
  it('completes project sharing, rename, regroup and group-only deletion through actual handlers', async () => {
    const response = await request(user, '/v1/projects', { name: 'Browser project' });
    expect(response.status).toBe(201);
    const project = await response.json();
    const id = await f.server({ projectId: project.id });
    expect((await request(peer, `/v1/platform/servers/${id}`)).status).toBe(404);
    const lookup = await request(user, `/v1/platform/projects/${project.id}/collaborator`, {
      email: 'platform-peer@example.test',
    });
    expect(await lookup.json()).toMatchObject({ user: { id: peerId } });
    expect(
      (
        await request(
          user,
          `/v1/projects/${project.id}/members`,
          { userId: peerId, role: 'manager' },
          'PUT',
        )
      ).status,
    ).toBe(204);
    expect(
      (await request(peer, `/v1/platform/servers/${id}`, { name: 'Shared server' }, 'PATCH'))
        .status,
    ).toBe(200);
    expect(
      (await request(peer, `/v1/platform/servers/${id}`, { projectId: null }, 'PATCH')).status,
    ).toBe(403);
    expect(
      (
        await request(
          user,
          `/v1/platform/projects/${project.id}`,
          { name: 'Renamed project' },
          'PATCH',
        )
      ).status,
    ).toBe(200);
    expect(await (await request(peer, `/v1/platform/projects/${project.id}`)).json()).toMatchObject(
      { canManage: false, name: 'Renamed project' },
    );
    expect(
      (await request(user, `/v1/platform/projects/${project.id}`, { confirm: true }, 'DELETE'))
        .status,
    ).toBe(200);
    expect((await request(peer, `/v1/platform/servers/${id}`)).status).toBe(404);
    expect(await (await request(user, `/v1/platform/servers/${id}`)).json()).toMatchObject({
      name: 'Shared server',
      projectId: null,
    });
  });
  it('exposes quota, state and safe network/transfer descriptors without private provider data', async () => {
    const id = await f.server();
    for (const suffix of ['connections', 'transfers', 'sleep-policy', 'metrics']) {
      const response = await request(user, `/v1/platform/servers/${id}/${suffix}`);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(
        /10\.0\.0\.2|pterodactyl_uuid|external_id|provider_ref|token|password/,
      );
    }
    const quotas = await request(user, '/v1/platform/quotas');
    expect(await quotas.json()).toMatchObject({
      limits: { serverCount: null },
      committed: { memoryMiB: 0 },
      measured: [],
    });
  });
  it('serves project-scoped job details and denies unrelated requests and unsafe retries', async () => {
    const project = await (await request(user, '/v1/projects', { name: 'Job sharing' })).json();
    const id = await f.server({ projectId: project.id });
    const operation = await f.db
      .selectFrom('server_operations')
      .select('job_id')
      .where('server_id', '=', id)
      .executeTakeFirstOrThrow();
    expect((await request(peer, `/v1/platform/jobs/${operation.job_id}`)).status).toBe(404);
    expect(
      (
        await request(
          user,
          `/v1/projects/${project.id}/members`,
          { userId: peerId, role: 'viewer' },
          'PUT',
        )
      ).status,
    ).toBe(204);
    const detail = await request(peer, `/v1/platform/jobs/${operation.job_id}`);
    expect(await detail.json()).toMatchObject({
      serverId: id,
      state: 'succeeded',
      retry: { allowed: false },
    });
    expect(
      await (await request(peer, `/v1/platform/activity?serverId=${id}`)).json(),
    ).toMatchObject({ items: [{ serverId: id }] });
    expect(
      (
        await request(
          user,
          `/v1/projects/${project.id}/members`,
          { userId: peerId, role: null },
          'PUT',
        )
      ).status,
    ).toBe(204);
    expect((await request(peer, `/v1/platform/jobs/${operation.job_id}`)).status).toBe(404);
  });
  it('reflects stored Owner rollout and attributable audit while rejecting unprivileged discovery', async () => {
    expect((await request(user, '/v1/platform/owner/games')).status).toBe(403);
    expect((await request(user, '/v1/owner/game-modules')).status).toBe(403);
    expect(await (await request(owner, '/v1/owner/game-modules')).json()).toEqual([
      expect.objectContaining({ id: 'minecraft-java' }),
    ]);
    expect((await request(owner, '/v1/platform/owner/games')).status).toBe(200);
    const auditedProject = await (
      await request(user, '/v1/projects', { name: 'Audit fixture' })
    ).json();
    expect(
      (
        await request(
          user,
          `/v1/platform/projects/${auditedProject.id}`,
          { confirm: true },
          'DELETE',
        )
      ).status,
    ).toBe(200);
    const audit = await request(owner, '/v1/platform/owner/audit?action=project.deleted&limit=1');
    expect(await audit.json()).toMatchObject({ items: [{ action: 'project.deleted' }] });
    expect((await request(peer, '/v1/platform/owner/audit')).status).toBe(403);
    const userDetail = await request(owner, `/v1/platform/owner/users/${f.context.subjectUserId}`);
    expect(await userDetail.json()).toMatchObject({
      id: f.context.subjectUserId,
      quota: { userId: f.context.subjectUserId },
    });
  });
});
