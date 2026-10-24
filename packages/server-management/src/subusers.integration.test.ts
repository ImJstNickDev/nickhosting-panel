import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@nickhosting/database/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lockResources } from './admission.js';
import {
  deletePlatformProject,
  getPlatformServer,
  listPlatformServers,
  updatePlatformServer,
} from './platform-queries.js';
import { authorizeServer, createProject, setProjectMember } from './registry.js';
import {
  deleteServerSubuser,
  listServerSubusers,
  lookupServerCollaborator,
  setServerSubuser,
} from './subusers.js';
import { managementFixture } from './test-fixtures.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let f: Awaited<ReturnType<typeof managementFixture>>;
let peer: Awaited<ReturnType<typeof managementFixture>>;
let serverId: string;
beforeAll(async () => {
  database = await createTestDatabase();
});
beforeEach(async () => {
  f = await managementFixture(database.db, { interactive: true });
  peer = await managementFixture(database.db, { interactive: true });
  serverId = await f.server();
});
afterAll(async () => {
  await database?.destroy();
});
const grant = (keys: string[]) =>
  setServerSubuser(f.db, f.context, serverId, peer.context.subjectUserId, { permissionKeys: keys });

describe('direct server Subusers', () => {
  it('provides project-independent visibility and granular access without legacy manage escalation', async () => {
    await expect(authorizeServer(f.db, peer.context, serverId)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await grant(['files.read']);
    expect(
      (await listPlatformServers(f.db, peer.context)).items.some(
        (server) => server.id === serverId,
      ),
    ).toBe(true);
    const server = await getPlatformServer(f.db, peer.context, serverId);
    expect(server.permissionKeys).toEqual(['files.read']);
    expect(server.permissions.manage).toBe(false);
    await expect(
      authorizeServer(f.db, peer.context, serverId, 'files.read'),
    ).resolves.toMatchObject({ id: serverId });
    for (const permission of [
      'server:manage',
      'server:operate',
      'files.write',
      'console.read',
      'subusers.read',
    ])
      await expect(authorizeServer(f.db, peer.context, serverId, permission)).rejects.toMatchObject(
        { code: 'forbidden' },
      );
    await deleteServerSubuser(f.db, f.context, serverId, peer.context.subjectUserId);
    await expect(authorizeServer(f.db, peer.context, serverId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('retains inherited access when a direct grant is deleted and preserves role powers', async () => {
    const project = await createProject(f.db, f.context, { name: 'Project' });
    await f.db
      .updateTable('managed_servers')
      .set({ project_id: project.id })
      .where('id', '=', serverId)
      .execute();
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'viewer',
    });
    await grant(['console.read', 'console.power']);
    await expect(
      authorizeServer(f.db, peer.context, serverId, 'console.power'),
    ).resolves.toBeDefined();
    const result = await deleteServerSubuser(f.db, f.context, serverId, peer.context.subjectUserId);
    const item = result.items.find((entry) => entry.userId === peer.context.subjectUserId);
    expect(item?.directPermissionKeys).toEqual([]);
    expect(item?.inheritedPermissionKeys).toContain('files.read');
    expect(item?.project?.id).toBe(project.id);
    await expect(
      authorizeServer(f.db, peer.context, serverId, 'console.power'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      authorizeServer(f.db, peer.context, serverId, 'files.read'),
    ).resolves.toBeDefined();
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'manager',
    });
    await expect(
      authorizeServer(f.db, peer.context, serverId, 'server:manage'),
    ).resolves.toBeDefined();
    await expect(
      authorizeServer(f.db, peer.context, serverId, 'subusers.write'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('enforces bounded delegation, self protection and protection of higher memberships', async () => {
    const other = await managementFixture(f.db, { interactive: true });
    await grant(['subusers.read', 'subusers.write', 'subusers.delete', 'files.read']);
    const update = (target: string, keys: string[]) =>
      setServerSubuser(f.db, peer.context, serverId, target, { permissionKeys: keys });
    await expect(update(other.context.subjectUserId, ['files.read'])).resolves.toBeDefined();
    await expect(
      update(other.context.subjectUserId, ['files.read', 'files.write']),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(update(peer.context.subjectUserId, ['subusers.read'])).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(update(f.context.subjectUserId, ['files.read'])).rejects.toMatchObject({
      code: 'forbidden',
    });
    await setServerSubuser(f.db, f.context, serverId, other.context.subjectUserId, {
      permissionKeys: ['files.read', 'files.write'],
    });
    await expect(update(other.context.subjectUserId, ['files.read'])).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      deleteServerSubuser(f.db, peer.context, serverId, other.context.subjectUserId),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const member = (await listServerSubusers(f.db, peer.context, serverId)).items.find(
      (item) => item.userId === other.context.subjectUserId,
    );
    expect(member?.canEdit).toBe(false);
    expect(member?.canDelete).toBe(false);
  });

  it('validates grant dependencies and accepts only verified existing accounts', async () => {
    for (const keys of [
      [],
      ['files.write'],
      ['files.read', 'made.up'],
      ['files.read', 'files.read'],
    ])
      await expect(async () => grant(keys)).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      setServerSubuser(f.db, f.context, serverId, randomUUID(), { permissionKeys: ['files.read'] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await f.db
      .updateTable('user')
      .set({ emailVerified: false })
      .where('id', '=', peer.context.subjectUserId)
      .execute();
    await expect(grant(['files.read'])).rejects.toMatchObject({ code: 'not_found' });
    expect(
      (
        await lookupServerCollaborator(f.db, f.context, serverId, {
          identifier: `${peer.context.subjectUserId}@example.test`,
        })
      ).user,
    ).toBeNull();
    await f.db
      .updateTable('user')
      .set({ emailVerified: true })
      .where('id', '=', peer.context.subjectUserId)
      .execute();
    expect(
      (
        await lookupServerCollaborator(f.db, f.context, serverId, {
          identifier: `${peer.context.subjectUserId}@example.test`.toUpperCase(),
        })
      ).user?.userId,
    ).toBe(peer.context.subjectUserId);
    await expect(
      lookupServerCollaborator(f.db, peer.context, serverId, {
        identifier: `${peer.context.subjectUserId}@example.test`,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rechecks a delegated writer after waiting behind a revocation transaction', async () => {
    const other = await managementFixture(f.db, { interactive: true });
    await grant(['subusers.read', 'subusers.write', 'files.read']);
    let pending: Promise<unknown> | undefined;
    await f.db.transaction().execute(async (tx) => {
      await lockResources(tx);
      pending = setServerSubuser(f.db, peer.context, serverId, other.context.subjectUserId, {
        permissionKeys: ['files.read'],
      });
      // Attach the rejection handler before releasing the transaction lock.
      pending.catch(() => undefined);
      await tx
        .deleteFrom('server_subusers')
        .where('server_id', '=', serverId)
        .where('user_id', '=', peer.context.subjectUserId)
        .execute();
    });
    await expect(pending).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      await f.db
        .selectFrom('server_subusers')
        .select('user_id')
        .where('server_id', '=', serverId)
        .where('user_id', '=', other.context.subjectUserId)
        .execute(),
    ).toEqual([]);
  });

  it('preserves legacy access and denies direct access before the additive migration is available', async () => {
    await grant(['files.read']);
    await sql`alter table server_subusers rename to server_subusers_migration_pending`.execute(
      f.db,
    );
    try {
      await expect(authorizeServer(f.db, f.context, serverId, 'files.read')).resolves.toBeDefined();
      await expect(
        authorizeServer(f.db, peer.context, serverId, 'files.read'),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect(
        (await listPlatformServers(f.db, peer.context)).items.some(
          (server) => server.id === serverId,
        ),
      ).toBe(false);
      await expect(listServerSubusers(f.db, f.context, serverId)).rejects.toMatchObject({
        code: 'configuration_invalid',
      });
    } finally {
      await sql`alter table server_subusers_migration_pending rename to server_subusers`.execute(
        f.db,
      );
    }
  });

  it.each(['member', 'move', 'delete'] as const)(
    'marks inherited SFTP credentials revoking atomically when project %s removes access',
    async (action) => {
      const project = await createProject(f.db, f.context, { name: 'Inherited access' });
      await f.db
        .updateTable('managed_servers')
        .set({ project_id: project.id })
        .where('id', '=', serverId)
        .execute();
      await setProjectMember(f.db, f.context, project.id, {
        userId: peer.context.subjectUserId,
        role: 'manager',
      });
      const credentialId = randomUUID();
      await f.db
        .insertInto('external_sftp_credentials')
        .values({
          id: credentialId,
          kind: 'primary',
          primary_username: `test_${credentialId.replaceAll('-', '')}`,
          server_id: serverId,
          actor_id: peer.context.actorUserId,
          envelope: '{}',
          provider_ref: null,
          expires_at: null,
          state: 'active',
        })
        .execute();
      if (action === 'member')
        await setProjectMember(f.db, f.context, project.id, {
          userId: peer.context.subjectUserId,
          role: 'viewer',
        });
      else if (action === 'move')
        await updatePlatformServer(f.db, f.context, serverId, { projectId: null });
      else await deletePlatformProject(f.db, f.context, project.id, { confirm: true });
      expect(
        (
          await f.db
            .selectFrom('external_sftp_credentials')
            .select('state')
            .where('id', '=', credentialId)
            .executeTakeFirst()
        )?.state,
      ).toBe('revoking');
    },
  );

  it('preserves issued SFTP when a direct grant retains every inherited file permission', async () => {
    const project = await createProject(f.db, f.context, { name: 'Retained direct access' });
    await f.db
      .updateTable('managed_servers')
      .set({ project_id: project.id })
      .where('id', '=', serverId)
      .execute();
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: 'manager',
    });
    await grant(['files.read', 'files.write', 'files.delete', 'files.sftp']);
    const credentialId = randomUUID();
    await f.db
      .insertInto('external_sftp_credentials')
      .values({
        id: credentialId,
        kind: 'primary',
        primary_username: `test_${credentialId.replaceAll('-', '')}`,
        server_id: serverId,
        actor_id: peer.context.actorUserId,
        envelope: '{}',
        provider_ref: null,
        expires_at: null,
        state: 'active',
      })
      .execute();
    await setProjectMember(f.db, f.context, project.id, {
      userId: peer.context.subjectUserId,
      role: null,
    });
    expect(
      (
        await f.db
          .selectFrom('external_sftp_credentials')
          .select('state')
          .where('id', '=', credentialId)
          .executeTakeFirst()
      )?.state,
    ).toBe('active');
  });

  it('records permission changes without emails or secrets', async () => {
    await grant(['files.read']);
    await deleteServerSubuser(f.db, f.context, serverId, peer.context.subjectUserId);
    const events = await f.db
      .selectFrom('audit_events')
      .select('metadata')
      .where('action', '=', 'server.subuser.updated')
      .where('actor_user_id', '=', f.context.actorUserId)
      .execute();
    expect(events).toHaveLength(2);
    expect(events[1]?.metadata).toMatchObject({
      targetUserId: peer.context.subjectUserId,
      permissionKeys: [],
      inheritedAccessRetained: false,
    });
    expect(JSON.stringify(events)).not.toContain('@example.test');
  });
});
