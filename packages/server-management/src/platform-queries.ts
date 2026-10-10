import {
  type AuthContext,
  assertAuthContext,
  assertPermission,
  DomainError,
  hasPermission,
} from '@nickhosting/core';
import { type Database, getSettings, recordAudit, secretStatus } from '@nickhosting/database';
import { gameManifestSchema } from '@nickhosting/game-sdk';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { type DB, type Environment, lockResources } from './admission.js';
import { getGatewayState } from './gateway-orchestration.js';
import { currentInteractiveContext } from './interactive-context.js';
import {
  authorizeServer,
  enqueueServerOperation,
  ownerOnly,
  parse,
  publicServer,
} from './registry.js';
import { effectiveUploadPolicy } from './upload-policy.js';

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(1024).optional(),
});
const serverQuerySchema = pageSchema
  .extend({
    q: z.string().trim().max(100).optional(),
    projectId: z.union([z.uuid(), z.literal('none')]).optional(),
    gameId: z.string().max(64).optional(),
    state: z.enum(['offline', 'starting', 'running', 'stopping', 'unknown']).optional(),
    ownerId: z.string().min(1).max(128).optional(),
  })
  .strict();
const cursorSchema = z.object({ at: z.iso.datetime(), id: z.string().min(1).max(128) }).strict();
function cursor(value: string | undefined, uuid = false) {
  if (!value) return null;
  try {
    const parsed = parse(
      cursorSchema,
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (uuid) parse(z.uuid(), parsed.id);
    return parsed;
  } catch {
    throw new DomainError('validation_failed');
  }
}
function page<T>(rows: T[], limit: number, key: (row: T) => { at: Date; id: string }) {
  const items = rows.slice(0, limit),
    last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ ...key(last), at: key(last).at.toISOString() })).toString(
            'base64url',
          )
        : null,
  };
}
function owner(context: AuthContext) {
  return context.role === 'owner' && context.sessionType === 'regular';
}
function visibleServers(db: DB, context: AuthContext) {
  assertAuthContext(context);
  let query = db.selectFrom('managed_servers').selectAll().where('deleted_at', 'is', null);
  if (!owner(context))
    query = query.where((e) =>
      e.or([
        e('owner_id', '=', context.subjectUserId),
        e.exists(
          e
            .selectFrom('project_members')
            .select('project_id')
            .whereRef('project_members.project_id', '=', 'managed_servers.project_id')
            .where('project_members.user_id', '=', context.subjectUserId),
        ),
      ]),
    );
  return query;
}
async function scopedServer(db: DB, context: AuthContext, serverId: string) {
  parse(z.uuid(), serverId);
  const row = await visibleServers(db, context).where('id', '=', serverId).executeTakeFirst();
  if (!row) throw new DomainError('not_found');
  return row;
}

export async function listPlatformServers(db: DB, context: AuthContext, input: unknown = {}) {
  const value = parse(serverQuerySchema, input),
    after = cursor(value.cursor, true);
  let query = visibleServers(db, context);
  if (value.q) query = query.where(sql<boolean>`strpos(lower(name), lower(${value.q})) > 0`);
  if (value.projectId)
    query =
      value.projectId === 'none'
        ? query.where('project_id', 'is', null)
        : query.where('project_id', '=', value.projectId);
  if (value.state) query = query.where('runtime_state', '=', value.state);
  if (value.ownerId) query = query.where('owner_id', '=', value.ownerId);
  if (value.gameId)
    query = query.where(
      'mapping_id',
      'in',
      db.selectFrom('runtime_egg_mappings').select('id').where('game_id', '=', value.gameId),
    );
  if (after)
    query = query.where(
      sql<boolean>`(date_trunc('milliseconds',created_at),id) < (${new Date(after.at)},${after.id})`,
    );
  const rows = await query
    .orderBy(sql`date_trunc('milliseconds',created_at)`, 'desc')
    .orderBy('id', 'desc')
    .limit(value.limit + 1)
    .execute();
  const result = page(rows, value.limit, (r) => ({ at: r.created_at, id: r.id }));
  return {
    ...result,
    items: await Promise.all(result.items.map((row) => describeServer(db, context, row))),
  };
}

async function describeServer(
  db: DB,
  context: AuthContext,
  row: Awaited<ReturnType<typeof authorizeServer>>,
) {
  const [mapping, member, policy, initialDenied, upload, reservation] = await Promise.all([
    db
      .selectFrom('runtime_egg_mappings as mapping')
      .innerJoin('game_integrations as game', 'game.id', 'mapping.game_id')
      .select(['mapping.game_id', 'mapping.runtime_id', 'game.manifest'])
      .where('mapping.id', '=', row.mapping_id)
      .executeTakeFirstOrThrow(),
    row.project_id
      ? db
          .selectFrom('project_members')
          .select('role')
          .where('project_id', '=', row.project_id)
          .where('user_id', '=', context.subjectUserId)
          .executeTakeFirst()
      : undefined,
    db
      .selectFrom('gateway_server_states')
      .select(['state', 'enabled'])
      .where('server_id', '=', row.id)
      .executeTakeFirst(),
    db
      .selectFrom('server_events')
      .select(['id', 'created_at', 'message_key'])
      .where('server_id', '=', row.id)
      .where('message_key', '=', 'servers.operation.initial_start_denied')
      .orderBy('id', 'desc')
      .executeTakeFirst(),
    db
      .selectFrom('upload_ingestion_claims')
      .select('id')
      .where('server_id', '=', row.id)
      .executeTakeFirst(),
    db
      .selectFrom('resource_reservations')
      .select('state')
      .where('server_id', '=', row.id)
      .executeTakeFirst(),
  ]);
  const manifest = gameManifestSchema.safeParse(mapping.manifest);
  const scope = { ownerUserId: row.owner_id, memberRole: member?.role };
  const manage = hasPermission(context, 'server:manage', scope),
    operate = hasPermission(context, 'server:operate', scope);
  const idle = !row.active_operation_id && !upload;
  const configured = row.pterodactyl_id !== null && row.pterodactyl_identifier !== null;
  const installed = row.installation_state === 'installed';
  const capabilities = manifest.success
    ? {
        ...manifest.data.capabilities,
        ...(row.connection_mode === 'direct'
          ? { idleDetection: false, readiness: false, wake: 'unsupported' as const }
          : {}),
      }
    : null;
  // Permission is separate from transient availability. These hints never replace
  // the live handler's locks, provider identity, admission or runtime proof.
  return {
    ...publicServer(row),
    gameId: mapping.game_id,
    runtimeId: mapping.runtime_id,
    gameNameKey: manifest.success ? manifest.data.nameKey : null,
    connectionMode: row.connection_mode,
    readiness: capabilities?.readiness === false ? ('unknown' as const) : row.readiness,
    sleepState: row.connection_mode === 'direct' ? null : (policy?.state ?? null),
    capabilities,
    permissions: {
      read: true,
      operate,
      manage,
      sharing: owner(context) || row.owner_id === context.subjectUserId,
    },
    availableActions: {
      start:
        operate &&
        idle &&
        configured &&
        installed &&
        row.runtime_state === 'offline' &&
        !reservation,
      stop: operate && idle && configured && installed,
      restart: operate && idle && configured && installed && row.runtime_state === 'running',
      backup: operate && idle && configured && installed && capabilities?.backups === true,
      configure: manage && idle && row.runtime_state === 'offline' && !reservation,
      metadata: manage,
      delete: manage && idle && row.runtime_state === 'offline' && !reservation,
      files: configured && capabilities?.files === true,
      console: configured && capabilities?.console === true,
    },
    firstStart: initialDenied
      ? {
          outcome: 'denied' as const,
          messageKey: initialDenied.message_key,
          occurredAt: initialDenied.created_at,
        }
      : null,
  };
}
export async function getPlatformServer(db: DB, context: AuthContext, serverId: string) {
  return describeServer(db, context, await scopedServer(db, context, serverId));
}

export async function updatePlatformServer(
  db: Kysely<Database>,
  context: AuthContext,
  serverId: string,
  input: unknown,
  env: Environment = {},
) {
  const value = parse(
    z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        projectId: z.uuid().nullable().optional(),
      })
      .strict()
      .refine((v) => v.name !== undefined || v.projectId !== undefined),
    input,
  );
  parse(z.uuid(), serverId);
  await db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, context, env);
    const server = await scopedServer(tx, current, serverId);
    await authorizeServer(tx, current, serverId, 'server:manage');
    // Moving a server changes its sharing boundary. Project managers may rename,
    // but only the resource owner/regular Owner may grant a different audience.
    if (value.projectId !== undefined && value.projectId !== server.project_id) {
      if (!owner(current) && server.owner_id !== current.subjectUserId)
        throw new DomainError('forbidden');
      if (value.projectId) {
        const project = await tx
          .selectFrom('projects')
          .selectAll()
          .where('id', '=', value.projectId)
          .forUpdate()
          .executeTakeFirst();
        if (!project) throw new DomainError('not_found');
        if (project.owner_id !== server.owner_id) throw new DomainError('forbidden');
      }
    }
    await tx
      .updateTable('managed_servers')
      .set({
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.projectId === undefined ? {} : { project_id: value.projectId }),
        updated_at: new Date(),
      })
      .where('id', '=', serverId)
      .execute();
    await recordAudit(tx, current, 'server.metadata.updated', {
      serverId,
      fields: Object.keys(value),
      previousProjectId: server.project_id,
      projectId: value.projectId === undefined ? server.project_id : value.projectId,
    });
  });
  return getPlatformServer(db, context, serverId);
}

async function projectAccess(db: DB, context: AuthContext, projectId: string, manage = false) {
  assertAuthContext(context);
  const project = await db
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', parse(z.uuid(), projectId))
    .executeTakeFirst();
  if (!project) throw new DomainError('not_found');
  const isOwner = owner(context) || project.owner_id === context.subjectUserId;
  const member = await db
    .selectFrom('project_members')
    .select('role')
    .where('project_id', '=', projectId)
    .where('user_id', '=', context.subjectUserId)
    .executeTakeFirst();
  if (!isOwner && (manage || !member)) throw new DomainError('forbidden');
  return {
    ...project,
    canManage: isOwner,
    memberRole: isOwner ? ('owner' as const) : (member?.role ?? null),
  };
}
export async function listPlatformProjects(db: DB, context: AuthContext, input: unknown = {}) {
  const value = parse(
      pageSchema.extend({ q: z.string().trim().max(100).optional() }).strict(),
      input,
    ),
    after = cursor(value.cursor, true);
  assertAuthContext(context);
  let query = db.selectFrom('projects').selectAll();
  if (!owner(context))
    query = query.where((e) =>
      e.or([
        e('owner_id', '=', context.subjectUserId),
        e.exists(
          e
            .selectFrom('project_members')
            .select('project_id')
            .whereRef('project_members.project_id', '=', 'projects.id')
            .where('user_id', '=', context.subjectUserId),
        ),
      ]),
    );
  if (value.q) query = query.where(sql<boolean>`strpos(lower(name),lower(${value.q})) > 0`);
  if (after)
    query = query.where(
      sql<boolean>`(date_trunc('milliseconds',created_at),id) < (${new Date(after.at)},${after.id})`,
    );
  const rows = await query
    .orderBy(sql`date_trunc('milliseconds',created_at)`, 'desc')
    .orderBy('id', 'desc')
    .limit(value.limit + 1)
    .execute();
  return page(rows, value.limit, (r) => ({ at: r.created_at, id: r.id }));
}
export async function getPlatformProject(db: DB, context: AuthContext, projectId: string) {
  const project = await projectAccess(db, context, projectId);
  const members = await db
    .selectFrom('project_members as member')
    .innerJoin('user', 'user.id', 'member.user_id')
    .select(['user.id', 'user.name', 'member.role'])
    .where('member.project_id', '=', projectId)
    .orderBy('user.name')
    .orderBy('user.id')
    .execute();
  const projectOwner = await db
    .selectFrom('user')
    .select(['id', 'name'])
    .where('id', '=', project.owner_id)
    .executeTakeFirstOrThrow();
  return { ...project, owner: projectOwner, members };
}
export async function lookupProjectCollaborator(
  db: DB,
  context: AuthContext,
  projectId: string,
  input: unknown,
) {
  await projectAccess(db, context, projectId, true);
  const value = parse(z.object({ email: z.email().max(320) }).strict(), input);
  // Exact verified-email match only. No global ordinary-user directory/autocomplete.
  const user = await db
    .selectFrom('user')
    .select(['id', 'name'])
    .where(sql<boolean>`lower(email) = lower(${value.email.trim()})`)
    .where('emailVerified', '=', true)
    .executeTakeFirst();
  return { user: user ?? null };
}
export async function updatePlatformProject(
  db: Kysely<Database>,
  context: AuthContext,
  projectId: string,
  input: unknown,
  env: Environment = {},
) {
  const value = parse(z.object({ name: z.string().trim().min(1).max(100) }).strict(), input);
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, context, env);
    await projectAccess(tx, current, projectId, true);
    const result = await tx
      .updateTable('projects')
      .set({ name: value.name })
      .where('id', '=', projectId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await recordAudit(tx, current, 'project.renamed', { projectId });
    return result;
  });
}
export async function deletePlatformProject(
  db: Kysely<Database>,
  context: AuthContext,
  projectId: string,
  input: unknown,
  env: Environment = {},
) {
  parse(z.object({ confirm: z.literal(true) }).strict(), input);
  return db.transaction().execute(async (tx) => {
    await lockResources(tx);
    const current = await currentInteractiveContext(tx, context, env);
    await projectAccess(tx, current, projectId, true);
    const result = await tx
      .updateTable('managed_servers')
      .set({ project_id: null, updated_at: new Date() })
      .where('project_id', '=', projectId)
      .returning('id')
      .execute();
    await tx.deleteFrom('project_members').where('project_id', '=', projectId).execute();
    await tx.deleteFrom('projects').where('id', '=', projectId).execute();
    await recordAudit(tx, current, 'project.deleted', {
      projectId,
      detachedServers: result.length,
    });
    return { detachedServers: result.length };
  });
}

export async function getPlatformQuota(
  db: DB,
  context: AuthContext,
  userId = context.subjectUserId,
  env: Environment = {},
) {
  assertAuthContext(context);
  if (userId !== context.subjectUserId) ownerOnly(context);
  const [settings, override, reservations, servers, metrics] = await Promise.all([
    getSettings(db, env),
    db
      .selectFrom('resource_user_limits')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db.selectFrom('resource_reservations').selectAll().where('owner_id', '=', userId).execute(),
    db
      .selectFrom('managed_servers as s')
      .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
      .select(['s.id', 's.limits', 'm.feature_limits'])
      .where('s.owner_id', '=', userId)
      .where('s.deleted_at', 'is', null)
      .execute(),
    db
      .selectFrom('server_metrics as m')
      .innerJoin('managed_servers as s', 's.id', 'm.server_id')
      .select(['m.server_id', 'm.memory_bytes', 'm.cpu_percent', 'm.disk_bytes', 'm.observed_at'])
      .where('s.owner_id', '=', userId)
      .where('s.deleted_at', 'is', null)
      .distinctOn('m.server_id')
      .orderBy('m.server_id')
      .orderBy('m.observed_at', 'desc')
      .execute(),
  ]);
  const { values } = settings,
    effective =
      override && (!override.expires_at || override.expires_at > new Date()) ? override : null;
  const limits = {
    memoryMiB: effective?.memory_mib ?? values.defaultUserMemoryMiB,
    cpuPercent: effective?.cpu_percent ?? values.defaultUserCpuPercent,
    storageMiB:
      values.storagePolicy === 'PER_USER_BUDGET'
        ? Number(effective?.storage_mib ?? values.defaultUserStorageMiB)
        : null,
    serverCount: values.maxServersPerUser,
  };
  const committed = {
    memoryMiB: reservations.reduce((n, r) => n + r.memory_mib, 0),
    cpuPercent: reservations.reduce((n, r) => n + r.cpu_percent, 0),
    storageMiB: servers.reduce((n, r) => n + r.limits.disk * (1 + r.feature_limits.backups), 0),
    serverCount: servers.length,
  };
  return {
    userId,
    storagePolicy: values.storagePolicy,
    creationStorage: {
      mode: values.storagePolicy === 'GLOBAL_POOL' ? 'shared' : 'limited',
      defaultDiskMiB: values.defaultServerStorageMiB,
    },
    limits,
    committed,
    remaining: {
      memoryMiB: Math.max(0, limits.memoryMiB - committed.memoryMiB),
      cpuPercent: Math.max(0, limits.cpuPercent - committed.cpuPercent),
      storageMiB:
        limits.storageMiB === null ? null : Math.max(0, limits.storageMiB - committed.storageMiB),
      serverCount:
        limits.serverCount === null
          ? null
          : Math.max(0, limits.serverCount - committed.serverCount),
    },
    override: override
      ? {
          memoryMiB: override.memory_mib,
          cpuPercent: override.cpu_percent,
          storageMiB: Number(override.storage_mib),
          expiresAt: override.expires_at,
          active: effective !== null,
          updatedAt: override.updated_at,
        }
      : null,
    measured: metrics.map((m) => ({
      serverId: m.server_id,
      memoryBytes: m.memory_bytes,
      cpuPercent: m.cpu_percent,
      diskBytes: m.disk_bytes,
      observedAt: m.observed_at,
      stale: Date.now() - m.observed_at.getTime() > values.observationMaxAgeSeconds * 1000,
    })),
    missingMeasurements: servers
      .filter((s) => !metrics.some((m) => m.server_id === s.id))
      .map((s) => s.id),
    observedAt: new Date(),
  };
}

export async function listPlatformUsers(db: DB, context: AuthContext, input: unknown = {}) {
  ownerOnly(context);
  const value = parse(
      pageSchema
        .extend({
          q: z.string().trim().max(100).optional(),
          role: z.enum(['owner', 'operator', 'user']).optional(),
        })
        .strict(),
      input,
    ),
    after = cursor(value.cursor);
  let query = db
    .selectFrom('user')
    .select(['id', 'name', 'email', 'emailVerified', 'role', 'locale', 'createdAt']);
  if (value.q)
    query = query.where(
      sql<boolean>`strpos(lower(name),lower(${value.q})) > 0 or strpos(lower(email),lower(${value.q})) > 0`,
    );
  if (value.role) query = query.where('role', '=', value.role);
  if (after)
    query = query.where(
      sql<boolean>`(date_trunc('milliseconds',"createdAt"),id) < (${new Date(after.at)},${after.id})`,
    );
  return page(
    await query
      .orderBy(sql`date_trunc('milliseconds',"createdAt")`, 'desc')
      .orderBy('id', 'desc')
      .limit(value.limit + 1)
      .execute(),
    value.limit,
    (r) => ({ at: r.createdAt, id: r.id }),
  );
}
export async function getPlatformUser(
  db: DB,
  context: AuthContext,
  userId: string,
  env: Environment = {},
) {
  ownerOnly(context);
  const user = await db
    .selectFrom('user')
    .select(['id', 'name', 'email', 'emailVerified', 'role', 'locale', 'createdAt', 'updatedAt'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw new DomainError('not_found');
  return { ...user, quota: await getPlatformQuota(db, context, userId, env) };
}

const activitySchema = pageSchema
  .extend({
    serverId: z.uuid().optional(),
    state: z.enum(['queued', 'running', 'succeeded', 'failed']).optional(),
    action: z.string().max(100).optional(),
  })
  .strict();
function activityQuery(db: DB, context: AuthContext) {
  assertAuthContext(context);
  let query = db
    .selectFrom('operation_jobs as job')
    .leftJoin('server_operations as operation', 'operation.job_id', 'job.id')
    .leftJoin('managed_servers as server', 'server.id', 'operation.server_id');
  if (!owner(context))
    query = query.where((e) =>
      e.or([
        e.and([
          e('operation.server_id', 'is', null),
          e('job.resource_owner_id', '=', context.subjectUserId),
        ]),
        e('server.owner_id', '=', context.subjectUserId),
        e.exists(
          e
            .selectFrom('project_members')
            .select('project_id')
            .whereRef('project_members.project_id', '=', 'server.project_id')
            .where('project_members.user_id', '=', context.subjectUserId),
        ),
      ]),
    );
  return query.select([
    'job.id',
    'job.state',
    'job.actor_id as actorId',
    'job.subject_id as subjectId',
    'job.resource_owner_id as resourceOwnerId',
    'job.attempts',
    'job.max_attempts as maxAttempts',
    'job.error_code as errorCode',
    'job.created_at as createdAt',
    'job.updated_at as updatedAt',
    'job.completed_at as completedAt',
    'operation.server_id as serverId',
    'operation.action',
    'operation.phase',
    'operation.effect_state as effectState',
    'server.name as serverName',
  ]);
}
export async function listPlatformActivity(db: DB, context: AuthContext, input: unknown = {}) {
  const value = parse(activitySchema, input),
    after = cursor(value.cursor, true);
  let query = activityQuery(db, context);
  if (value.serverId) {
    await scopedServer(db, context, value.serverId);
    query = query.where('operation.server_id', '=', value.serverId);
  }
  if (value.state) query = query.where('job.state', '=', value.state);
  if (value.action) query = query.where(sql<boolean>`operation.action = ${value.action}`);
  if (after)
    query = query.where(
      sql<boolean>`(date_trunc('milliseconds',job.created_at),job.id) < (${new Date(after.at)},${after.id})`,
    );
  const result = page(
    await query
      .orderBy(sql`date_trunc('milliseconds',job.created_at)`, 'desc')
      .orderBy('job.id', 'desc')
      .limit(value.limit + 1)
      .execute(),
    value.limit,
    (r) => ({ at: r.createdAt, id: r.id }),
  );
  return { ...result, items: result.items.map((r) => ({ ...r, messageKey: `jobs.${r.state}` })) };
}
async function retryEligibility(db: DB, jobId: string) {
  const row = await db
    .selectFrom('server_operations as op')
    .innerJoin('operation_jobs as job', 'job.id', 'op.job_id')
    .select(['op.action', 'op.effect_state', 'op.effect_started_at', 'op.phase', 'job.state'])
    .where('job.id', '=', jobId)
    .executeTakeFirst();
  // Only failures before ANY recorded effect are replay-safe. Unknown provider
  // outcomes and acknowledged/Owner-resolved effects require investigation.
  return row?.state === 'failed' &&
    row.effect_state === 'none' &&
    row.effect_started_at === null &&
    row.phase !== 'owner_resolved_failed' &&
    ['start', 'stop', 'restart', 'backup'].includes(row.action)
    ? (row.action as 'start' | 'stop' | 'restart' | 'backup')
    : null;
}
export async function getPlatformJob(db: DB, context: AuthContext, jobId: string) {
  parse(z.uuid(), jobId);
  const job = await activityQuery(db, context).where('job.id', '=', jobId).executeTakeFirst();
  if (!job) throw new DomainError('not_found');
  let retryAction = await retryEligibility(db, jobId);
  if (retryAction && job.serverId) {
    try {
      await authorizeServer(db, context, job.serverId, 'server:operate');
    } catch {
      retryAction = null;
    }
  }
  let ownerRecovery: { available: boolean; availableAt: Date } | null = null;
  if (owner(context) && job.serverId && ['queued', 'running'].includes(job.state)) {
    const recovery = await db
      .selectFrom('server_operations as operation')
      .innerJoin('managed_servers as server', 'server.id', 'operation.server_id')
      .select([
        'operation.effect_started_at',
        'server.active_operation_id',
        'server.pterodactyl_id',
      ])
      .where('operation.job_id', '=', jobId)
      .where('server.deleted_at', 'is', null)
      .executeTakeFirst();
    if (
      recovery?.effect_started_at &&
      recovery.active_operation_id === jobId &&
      recovery.pterodactyl_id &&
      ['prepared', 'uncertain'].includes(job.effectState ?? '') &&
      !['start', 'stop', 'restart'].includes(job.action ?? '') &&
      job.phase !== 'initial_start'
    ) {
      const availableAt = new Date(recovery.effect_started_at.getTime() + 120_000);
      ownerRecovery = { available: availableAt <= new Date(), availableAt };
    }
  }
  return {
    ...job,
    // This is only permission/timing eligibility. Resolution still corroborates
    // provider identity and installed/offline state under the server lock.
    ownerRecovery,
    messageKey: `jobs.${job.state}`,
    retry: {
      allowed: retryAction !== null,
      action: retryAction,
      reason: retryAction
        ? null
        : job.effectState === 'uncertain' || job.effectState === 'prepared'
          ? 'operation_uncertain'
          : 'not_retryable',
    },
    events: job.serverId
      ? await db
          .selectFrom('server_events')
          .select(['id', 'message_key', 'created_at', 'data'])
          .where('job_id', '=', jobId)
          .orderBy('id', 'desc')
          .limit(200)
          .execute()
      : [],
  };
}
export async function retryPlatformJob(
  db: Kysely<Database>,
  context: AuthContext,
  jobId: string,
  input: unknown,
  env: Environment = {},
) {
  const value = parse(
    z.object({ idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }).strict(),
    input,
  );
  const current = await currentInteractiveContext(db, context, env),
    job = await getPlatformJob(db, current, jobId);
  if (!job.serverId || !job.retry.allowed || !job.retry.action)
    throw new DomainError('operation_uncertain');
  const result = await enqueueServerOperation(
    db,
    current,
    job.serverId,
    { action: job.retry.action, idempotencyKey: value.idempotencyKey },
    env,
  );
  await recordAudit(db, current, 'operation.retry.requested', {
    previousJobId: jobId,
    jobId: result.jobId,
    serverId: job.serverId,
  });
  return result;
}

export async function listPlatformAudit(db: DB, context: AuthContext, input: unknown = {}) {
  assertPermission(context, 'audit:read');
  if (context.sessionType !== 'regular') throw new DomainError('forbidden');
  const value = parse(
      pageSchema
        .extend({
          action: z.string().max(100).optional(),
          actorId: z.string().max(128).optional(),
          subjectId: z.string().max(128).optional(),
          userId: z.string().max(128).optional(),
        })
        .strict(),
      input,
    ),
    after = cursor(value.cursor);
  let query = db.selectFrom('audit_events').selectAll();
  if (value.action) query = query.where('action', '=', value.action);
  if (value.actorId) query = query.where('actor_user_id', '=', value.actorId);
  if (value.subjectId) query = query.where('subject_user_id', '=', value.subjectId);
  if (value.userId) query = query.where(sql<boolean>`metadata->>'userId' = ${value.userId}`);
  if (after)
    query = query.where(
      sql<boolean>`(date_trunc('milliseconds',created_at),id) < (${new Date(after.at)},${after.id})`,
    );
  return page(
    await query
      .orderBy(sql`date_trunc('milliseconds',created_at)`, 'desc')
      .orderBy('id', 'desc')
      .limit(value.limit + 1)
      .execute(),
    value.limit,
    (r) => ({ at: r.created_at, id: r.id }),
  );
}
export async function listPlatformGames(db: DB, context: AuthContext) {
  ownerOnly(context);
  return db
    .selectFrom('game_integrations as game')
    .leftJoin('game_rollouts as rollout', 'rollout.integration_id', 'game.id')
    .select([
      'game.id',
      'game.version',
      'game.manifest',
      'game.updated_at as updatedAt',
      'rollout.state',
      'rollout.allowlist',
      'rollout.updated_at as rolloutUpdatedAt',
    ])
    .orderBy('game.id')
    .execute();
}

export async function getPlatformConnections(
  db: DB,
  context: AuthContext,
  serverId: string,
  env: Environment = {},
) {
  const server = await scopedServer(db, context, serverId);
  const [settings, mapping, allocations, routes, assignments] = await Promise.all([
    getSettings(db, env),
    db
      .selectFrom('runtime_egg_mappings as m')
      .innerJoin('game_integrations as g', 'g.id', 'm.game_id')
      .select('g.manifest')
      .where('m.id', '=', server.mapping_id)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('server_allocations')
      .select(['id', 'role', 'port', 'protocols', 'is_primary', 'direct_endpoint'])
      .where('server_id', '=', serverId)
      .orderBy('role')
      .execute(),
    db
      .selectFrom('gateway_routes')
      .select([
        'allocation_id',
        'public_address',
        'public_port',
        'transport',
        'enabled',
        'lease_expires_at',
      ])
      .where('server_id', '=', serverId)
      .execute(),
    db
      .selectFrom('dns_assignments')
      .select(['hostname', 'state'])
      .where('server_id', '=', serverId)
      .where('state', '!=', 'deleted')
      .execute(),
  ]);
  const manifest = gameManifestSchema.safeParse(mapping.manifest),
    connection = manifest.success ? manifest.data.connection : null;
  const hostname =
    server.connection_mode === 'direct'
      ? allocations.find((entry) => entry.is_primary)?.direct_endpoint?.hostname
      : connection?.mode === 'static-host-port'
        ? settings.values.staticGameHostname
        : assignments.find((a) => a.state === 'active')?.hostname;
  return {
    mode: connection?.mode ?? null,
    connectionMode: server.connection_mode,
    reachability: server.connection_mode === 'direct' ? ('unverified' as const) : null,
    hostname: hostname ?? null,
    srv: connection?.mode === 'custom-subdomain' ? (connection.srv ?? null) : null,
    dns: assignments,
    ports: allocations.flatMap((allocation) =>
      allocation.protocols.map((transport) => {
        if (server.connection_mode === 'direct') {
          const endpoint = allocation.direct_endpoint;
          return {
            role: allocation.role,
            primary: allocation.is_primary,
            transport,
            port: endpoint?.port ?? null,
            hostname: endpoint?.hostname ?? null,
            status: endpoint ? ('configured' as const) : ('unconfigured' as const),
          };
        }
        const route = routes.find(
          (r) => r.allocation_id === allocation.id && r.transport === transport,
        );
        return {
          role: allocation.role,
          primary: allocation.is_primary,
          transport,
          port: route?.public_port ?? null,
          hostname: route ? (hostname ?? route.public_address) : null,
          status: !route
            ? ('unconfigured' as const)
            : !route.enabled
              ? ('disabled' as const)
              : !route.lease_expires_at || route.lease_expires_at <= new Date()
                ? ('unavailable' as const)
                : ('available' as const),
        };
      }),
    ),
  };
}

export async function getPlatformTransfers(
  db: DB,
  context: AuthContext,
  serverId: string,
  env: Environment = {},
) {
  const server = await scopedServer(db, context, serverId);
  const [host, settings, secrets, info, pending] = await Promise.all([
    db
      .selectFrom('managed_nodes as node')
      .innerJoin('physical_hosts as host', 'host.id', 'node.physical_host_id')
      .selectAll('host')
      .where('node.id', '=', server.node_id)
      .executeTakeFirstOrThrow(),
    getSettings(db, env),
    secretStatus(db, env),
    describeServer(db, context, server),
    db
      .selectFrom('upload_ingestion_claims')
      .select('id')
      .where('server_id', '=', serverId)
      .executeTakeFirst(),
  ]);
  const policy = effectiveUploadPolicy(host, env),
    configured =
      secrets.some((s) => s.name === 'pterodactylClientKey' && s.configured) &&
      !!settings.values.pterodactylBaseUrl;
  const reason = !info.permissions.manage
    ? 'forbidden'
    : server.active_operation_id || pending
      ? 'conflict'
      : !configured || !policy || host.observer_id !== env.NH_OBSERVER_ID
        ? 'configuration_invalid'
        : !info.availableActions.files
          ? 'integration_unavailable'
          : null;
  return {
    files: info.capabilities?.files === true,
    textEditMaxCharacters: 60000,
    upload: {
      available: reason === null,
      reason,
      providerMaxFileBytes: policy?.providerMaxFileBytes ?? null,
      serverDiskBytes: server.limits.disk * 1048576,
      streaming: true,
    },
    download: {
      available: configured && info.availableActions.files,
      streaming: true,
      totalSizeLimitBytes: null,
    },
    sftp: {
      configured:
        !!settings.values.sftpgoBaseUrl &&
        !!settings.values.sftpgoDataRoot &&
        !!settings.values.sftpgoInstanceId &&
        secrets.some((s) => s.name === 'sftpgoApiKey' && s.configured),
      endpoint:
        settings.values.sftpPublicHostname && settings.values.sftpPublicPort
          ? { hostname: settings.values.sftpPublicHostname, port: settings.values.sftpPublicPort }
          : null,
      canIssue:
        info.permissions.manage &&
        context.sessionType === 'regular' &&
        !!settings.values.sftpPublicHostname &&
        !!settings.values.sftpPublicPort,
      retainedTransportRevocationLimited: true,
    },
    backups: {
      supported: info.capabilities?.backups === true,
      canCreate: info.availableActions.backup,
      canRestore:
        info.permissions.manage &&
        !server.active_operation_id &&
        server.runtime_state === 'offline',
    },
  };
}

export async function getPlatformSleepPolicy(db: DB, context: AuthContext, serverId: string) {
  const server = await scopedServer(db, context, serverId),
    state = await db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
  if (!state || server.connection_mode === 'direct') return { policy: null, state: null };
  return {
    policy: {
      enabled: state.enabled,
      protocolId: state.protocol_id,
      gameVersion: state.game_version,
      idleTimeoutSeconds: state.idle_timeout_seconds,
      readinessTimeoutSeconds: state.readiness_timeout_seconds,
      readinessMaxAgeSeconds: state.readiness_max_age_seconds,
      estimateMaxAgeSeconds: state.estimate_max_age_seconds,
      wakeRetrySeconds: state.wake_retry_seconds,
      mode:
        server.intent === 'maintenance'
          ? 'maintenance'
          : server.intent === 'manually_stopped'
            ? 'manually_stopped'
            : 'auto',
    },
    state: await getGatewayState(db, serverId),
  };
}
export async function listPlatformMetrics(
  db: DB,
  context: AuthContext,
  serverId: string,
  input: unknown = {},
) {
  await scopedServer(db, context, serverId);
  const value = parse(
    z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.iso.datetime().optional(),
        from: z.iso.datetime().optional(),
        to: z.iso.datetime().optional(),
      })
      .strict(),
    input,
  );
  if (value.from && value.to && value.from > value.to) throw new DomainError('validation_failed');
  let query = db.selectFrom('server_metrics').selectAll().where('server_id', '=', serverId);
  if (value.before) query = query.where('observed_at', '<', new Date(value.before));
  if (value.from) query = query.where('observed_at', '>=', new Date(value.from));
  if (value.to) query = query.where('observed_at', '<=', new Date(value.to));
  const rows = await query
      .orderBy('observed_at', 'desc')
      .limit(value.limit + 1)
      .execute(),
    items = rows.slice(0, value.limit);
  return {
    items,
    nextBefore:
      rows.length > value.limit ? (items.at(-1)?.observed_at.toISOString() ?? null) : null,
  };
}
