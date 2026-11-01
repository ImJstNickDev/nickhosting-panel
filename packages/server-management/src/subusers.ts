import {
  type AuthContext,
  assertServerPermissionKeys,
  DomainError,
  legacyServerPermissionKeys,
} from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import { currentInteractiveContext } from './interactive-context.js';
import {
  authorizeServer,
  getServerPermissionDefinitions,
  getServerPermissionKeys,
  parse,
  serverSubusersAvailable,
} from './registry.js';

const userIdSchema = z.string().min(1).max(128);
function resourceOwner(context: AuthContext, ownerId: string) {
  return context.role === 'owner' || context.subjectUserId === ownerId;
}

export async function listServerSubusers(db: DB, context: AuthContext, serverId: string) {
  const server = await authorizeServer(db, context, serverId, 'subusers.read');
  if (!(await serverSubusersAvailable(db))) throw new DomainError('configuration_invalid');
  const definitions = await getServerPermissionDefinitions(db, server);
  const grantablePermissionKeys = await getServerPermissionKeys(db, context, server);
  const direct = await db
    .selectFrom('server_subusers')
    .selectAll()
    .where('server_id', '=', serverId)
    .execute();
  const project = server.project_id
    ? await db
        .selectFrom('projects')
        .select(['id', 'name'])
        .where('id', '=', server.project_id)
        .executeTakeFirst()
    : undefined;
  const inherited = server.project_id
    ? await db
        .selectFrom('project_members')
        .selectAll()
        .where('project_id', '=', server.project_id)
        .execute()
    : [];
  const users = await db
    .selectFrom('user')
    .select(['id', 'name', 'username', 'role'])
    .where('id', 'in', [
      ...new Set([
        server.owner_id,
        ...direct.map((member) => member.user_id),
        ...inherited.map((member) => member.user_id),
      ]),
    ])
    .execute();
  const fullControl = resourceOwner(context, server.owner_id);
  return {
    items: users
      .map((user) => {
        const membership = direct.find((entry) => entry.user_id === user.id);
        const projectMembership = inherited.find((entry) => entry.user_id === user.id);
        const owner = user.id === server.owner_id || user.role === 'owner';
        const directPermissionKeys = membership?.permission_keys ?? [];
        const inheritedPermissionKeys = legacyServerPermissionKeys(
          projectMembership?.role,
          definitions,
        );
        const effectivePermissionKeys = owner
          ? definitions.map(({ key }) => key)
          : [...new Set([...directPermissionKeys, ...inheritedPermissionKeys])];
        const protectedMember =
          owner ||
          (!fullControl &&
            (user.id === context.subjectUserId ||
              effectivePermissionKeys.some((key) => !grantablePermissionKeys.includes(key))));
        return {
          userId: user.id,
          name: user.name,
          username: user.username,
          directPermissionKeys,
          inheritedPermissionKeys,
          effectivePermissionKeys,
          project:
            project && projectMembership ? { ...project, role: projectMembership.role } : null,
          protected: protectedMember,
          canEdit: !protectedMember && grantablePermissionKeys.includes('subusers.write'),
          canDelete:
            !!membership && !protectedMember && grantablePermissionKeys.includes('subusers.delete'),
        };
      })
      .sort((a, b) => Number(b.protected) - Number(a.protected) || a.name.localeCompare(b.name)),
    permissionDefinitions: definitions,
    grantablePermissionKeys,
  };
}

/** Exact verified email only; no account directory or prefix search. */
export async function lookupServerCollaborator(
  db: DB,
  context: AuthContext,
  serverId: string,
  input: unknown,
) {
  await authorizeServer(db, context, serverId, 'subusers.write');
  const { identifier } = parse(z.object({ identifier: z.email().max(320) }).strict(), input);
  const user = await db
    .selectFrom('user')
    .select(['id as userId', 'name', 'username'])
    .where(sql<boolean>`lower(email) = lower(${identifier.trim()})`)
    .where('emailVerified', '=', true)
    .executeTakeFirst();
  return { user: user ?? null };
}

async function changeServerSubuser(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  targetUserId: string,
  permissionKeys: string[] | null,
  env: Environment,
) {
  parse(userIdSchema, targetUserId);
  await db.transaction().execute(async (tx) => {
    // Same lock as operations, project moves, and project membership updates:
    // re-resolve authority after waiting, then audit and commit atomically.
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, context, env);
    const server = await authorizeServer(
      tx,
      current,
      serverId,
      permissionKeys ? 'subusers.write' : 'subusers.delete',
    );
    if (!(await serverSubusersAvailable(tx))) throw new DomainError('configuration_invalid');
    const user = await tx
      .selectFrom('user')
      .select(['id', 'role', 'emailVerified', 'name', 'username'])
      .where('id', '=', targetUserId)
      .forUpdate()
      .executeTakeFirst();
    if (!user?.emailVerified) throw new DomainError('not_found');
    if (user.id === server.owner_id || user.role === 'owner') throw new DomainError('forbidden');
    const definitions = await getServerPermissionDefinitions(tx, server);
    if (permissionKeys) assertServerPermissionKeys(permissionKeys, definitions);
    const ownKeys = await getServerPermissionKeys(tx, current, server);
    const targetKeys = await getServerPermissionKeys(
      tx,
      {
        actorUserId: user.id,
        subjectUserId: user.id,
        role: user.role,
        sessionType: 'regular',
        ownerElevation: false,
      },
      server,
    );
    if (
      !resourceOwner(current, server.owner_id) &&
      (user.id === current.subjectUserId ||
        targetKeys.some((key) => !ownKeys.includes(key)) ||
        permissionKeys?.some((key) => !ownKeys.includes(key)))
    )
      throw new DomainError('forbidden');
    const previous = await tx
      .selectFrom('server_subusers')
      .select('permission_keys')
      .where('server_id', '=', serverId)
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (permissionKeys) {
      await tx
        .insertInto('server_subusers')
        .values({
          server_id: serverId,
          user_id: user.id,
          permission_keys: JSON.stringify(permissionKeys),
          created_by: current.actorUserId,
        })
        .onConflict((conflict) =>
          conflict.columns(['server_id', 'user_id']).doUpdateSet({
            permission_keys: JSON.stringify(permissionKeys),
            updated_at: new Date(),
          }),
        )
        .execute();
    } else {
      await tx
        .deleteFrom('server_subusers')
        .where('server_id', '=', serverId)
        .where('user_id', '=', user.id)
        .execute();
    }
    // Restrict previously issued external transports before the asynchronous
    // provider reconciliation; re-issuing will re-check the complete live grant.
    const effective = await getServerPermissionKeys(
      tx,
      {
        actorUserId: user.id,
        subjectUserId: user.id,
        role: user.role,
        sessionType: 'regular',
        ownerElevation: false,
      },
      server,
    );
    if (targetKeys.some((key) => key.startsWith('files.') && !effective.includes(key))) {
      await tx
        .updateTable('external_sftp_credentials')
        .set({ state: 'revoking' })
        .where('server_id', '=', serverId)
        .where('actor_id', '=', user.id)
        .where('state', 'in', ['pending', 'active', 'uncertain'])
        .execute();
    }
    await recordAudit(tx, current, 'server.subuser.updated', {
      serverId,
      targetUserId: user.id,
      memberName: user.name,
      memberUsername: user.username,
      previousPermissionKeys: previous?.permission_keys ?? [],
      permissionKeys: permissionKeys ?? [],
      inheritedAccessRetained: effective.length > 0,
      source: 'panel',
      outcome: 'succeeded',
    });
  });
  return listServerSubusers(db, context, serverId);
}

export function setServerSubuser(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  userId: string,
  input: unknown,
  env: Environment = {},
) {
  const { permissionKeys } = parse(
    z.object({ permissionKeys: z.array(z.string().min(1).max(160)).min(1).max(256) }).strict(),
    input,
  );
  return changeServerSubuser(db, context, serverId, userId, permissionKeys, env);
}
export function deleteServerSubuser(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  userId: string,
  env: Environment = {},
) {
  return changeServerSubuser(db, context, serverId, userId, null, env);
}
