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
import { listUnifiedActivity } from './activity.js';
import { checkedObservation, type DB, type Environment, lockResources } from './admission.js';
import { resolveHostOverride } from './configuration.js';
import { trustedGameModules } from './game-modules.js';
import {
  type GatewayPolicy,
  gatewayPolicySchema,
  getGatewayState,
} from './gateway-orchestration.js';
import { currentInteractiveContext } from './interactive-context.js';
import { backupSchemaAvailable, providerBackupEventsEnabled } from './provider-backup-events.js';
import {
  authorizeServer,
  enqueueServerOperation,
  ownerOnly,
  parse,
  publicServer,
} from './registry.js';
import { publicIdleTimeout, resolveIdleTimeout } from './sleep-policy.js';
import { hasStopProcessBaseline, stopEscalation } from './stop-escalation.js';
import { serverStorageLimitBytes } from './storage-capacity.js';
import { effectiveUploadPolicy } from './upload-policy.js';

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(1024).optional(),
});
const serverOwnerIdSchema = z.string().min(1).max(128);
const serverQuerySchema = pageSchema
  .extend({
    page: z.coerce.number().int().min(1).max(1_000_000).optional(),
    scope: z.enum(['mine', 'others']).optional(),
    runtimeId: z.string().min(1).max(64).optional(),
    version: z.string().min(1).max(128).optional(),
    q: z.string().trim().max(100).optional(),
    projectId: z.union([z.uuid(), z.literal('none')]).optional(),
    gameId: z.string().max(64).optional(),
    state: z.enum(['offline', 'starting', 'running', 'stopping', 'unknown']).optional(),
    ownerId: serverOwnerIdSchema.optional(),
    ownerIds: z
      .array(serverOwnerIdSchema)
      .min(1)
      .max(100)
      .transform((ids) => [...new Set(ids)])
      .optional(),
  })
  .strict()
  .refine((value) => !(value.page !== undefined && value.cursor !== undefined))
  .refine((value) => !(value.ownerId !== undefined && value.ownerIds !== undefined));
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

// Installed release metadata is authoritative; manifest compatibility ranges and
// integration versions are not the version installed in an individual server.
const installedServerVersion = sql<string | null>`(
  select nullif(combination.combination->>'release', '')
  from minecraft_server_profiles as profile
  join minecraft_combinations as combination on combination.id = profile.combination_id
  join runtime_egg_mappings as version_mapping on version_mapping.id = combination.mapping_id
  where profile.server_id = managed_servers.id and profile.installed = true
    and combination.mapping_id = managed_servers.mapping_id
    and version_mapping.game_id = 'minecraft'
)`;

export async function listPlatformServers(
  db: DB,
  context: AuthContext,
  input: unknown = {},
  env: Environment = {},
) {
  const value = parse(serverQuerySchema, input),
    after = cursor(value.cursor, true);
  if (value.scope === 'others') ownerOnly(context);
  let inventory = visibleServers(db, context);
  if (value.scope === 'mine') inventory = inventory.where('owner_id', '=', context.subjectUserId);
  if (value.scope === 'others')
    inventory = inventory.where('owner_id', '!=', context.subjectUserId);
  let query = inventory;
  if (value.q) query = query.where(sql<boolean>`strpos(lower(name), lower(${value.q})) > 0`);
  if (value.projectId)
    query =
      value.projectId === 'none'
        ? query.where('project_id', 'is', null)
        : query.where('project_id', '=', value.projectId);
  if (value.state) query = query.where('runtime_state', '=', value.state);
  if (value.ownerId) query = query.where('owner_id', '=', value.ownerId);
  if (value.ownerIds) query = query.where('owner_id', 'in', value.ownerIds);
  if (value.gameId || value.runtimeId) {
    let mappings = db.selectFrom('runtime_egg_mappings').select('id');
    if (value.gameId) mappings = mappings.where('game_id', '=', value.gameId);
    if (value.runtimeId) mappings = mappings.where('runtime_id', '=', value.runtimeId);
    query = query.where('mapping_id', 'in', mappings);
  }
  if (value.version) query = query.where(installedServerVersion, '=', value.version);
  const [count, facets, gatewayEnabled] = await Promise.all([
    query.clearSelect().select(sql<string>`count(*)`.as('total')).executeTakeFirstOrThrow(),
    db
      .selectFrom(
        inventory
          .clearSelect()
          .select(['id', 'mapping_id', 'project_id', 'owner_id'])
          .select(installedServerVersion.as('version'))
          .as('inventory'),
      )
      .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'inventory.mapping_id')
      .innerJoin('game_integrations as game', 'game.id', 'mapping.game_id')
      .leftJoin('projects as project', 'project.id', 'inventory.project_id')
      .innerJoin('user as account', 'account.id', 'inventory.owner_id')
      .select([
        'mapping.game_id',
        'mapping.runtime_id',
        'inventory.version',
        'project.id as project_id',
        'project.name as project_name',
        'account.id as owner_id',
        'account.name as owner_name',
      ])
      .select(sql<string | null>`game.manifest->>'nameKey'`.as('game_name_key'))
      .distinct()
      .execute(),
    configuredGatewayWake(db, env),
  ]);
  const total = Number(count.total);
  const totalPages = Math.max(1, Math.ceil(total / value.limit));
  const pageNumber = Math.min(value.page ?? 1, totalPages);
  if (after)
    query = query.where(
      sql<boolean>`(date_trunc('milliseconds',created_at),id) < (${new Date(after.at)},${after.id})`,
    );
  if (value.page !== undefined) query = query.offset((pageNumber - 1) * value.limit);
  const rows = await query
    .orderBy(sql`date_trunc('milliseconds',created_at)`, 'desc')
    .orderBy('id', 'desc')
    .limit(value.limit + 1)
    .execute();
  const result = page(rows, value.limit, (r) => ({ at: r.created_at, id: r.id }));
  const games = new Map<string, { id: string; nameKey: string | null }>();
  const runtimes = new Set<string>();
  const versions = new Set<string>();
  const projects = new Map<string, { id: string; name: string }>();
  const owners = new Map<string, { id: string; name: string }>();
  for (const facet of facets) {
    games.set(facet.game_id, { id: facet.game_id, nameKey: facet.game_name_key });
    if (!value.gameId || facet.game_id === value.gameId) {
      runtimes.add(facet.runtime_id);
      if ((!value.runtimeId || facet.runtime_id === value.runtimeId) && facet.version)
        versions.add(facet.version);
    }
    if (facet.project_id && facet.project_name !== null)
      projects.set(facet.project_id, { id: facet.project_id, name: facet.project_name });
    if (value.scope === 'others' && owner(context))
      owners.set(facet.owner_id, { id: facet.owner_id, name: facet.owner_name });
  }
  return {
    ...result,
    total,
    page: pageNumber,
    totalPages,
    filterOptions: {
      games: [...games.values()].sort((a, b) => a.id.localeCompare(b.id)),
      runtimes: [...runtimes].sort(),
      versions: [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
      projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
      owners: [...owners.values()].sort((a, b) => a.name.localeCompare(b.name)),
    },
    items: await Promise.all(
      result.items.map((row) => describeServer(db, context, row, gatewayEnabled)),
    ),
  };
}

async function configuredGatewayWake(db: DB, env: Environment) {
  const { values } = await getSettings(db, env);
  return Boolean(values.gatewayEnabled && values.gatewayId && values.gatewayPhysicalHostId);
}

async function describeServer(
  db: DB,
  context: AuthContext,
  row: Awaited<ReturnType<typeof authorizeServer>>,
  gatewayEnabled = false,
) {
  const [mapping, member, policy, initialDenied, upload, reservation, activeStop] =
    await Promise.all([
      db
        .selectFrom('runtime_egg_mappings as mapping')
        .innerJoin('game_integrations as game', 'game.id', 'mapping.game_id')
        .select([
          'mapping.game_id',
          'mapping.runtime_id',
          'mapping.feature_limits',
          'game.manifest',
        ])
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
      row.active_operation_id
        ? db
            .selectFrom('server_operations as operation')
            .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
            .select([
              'operation.action',
              'operation.phase',
              'operation.effect_started_at',
              'operation.plan',
              'job.policy_snapshot',
            ])
            .where('job.id', '=', row.active_operation_id)
            .executeTakeFirst()
        : undefined,
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
        // Message handlers use the installed module; older persisted manifests
        // may predate this optional capability.
        gatewayMessages: !!trustedGameModules.get(mapping.game_id)?.manifest.gatewayMessages,
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
    // Enabled policies already validate their installed protocol binding on write.
    // Base manifests may declare manual wake; this is configuration, not live readiness.
    wakeEnabled: Boolean(
      gatewayEnabled &&
        policy?.enabled &&
        row.connection_mode === 'gateway' &&
        capabilities !== null &&
        capabilities.wake !== 'unsupported' &&
        !row.automatic_starts_paused &&
        !['manually_stopped', 'maintenance'].includes(row.intent),
    ),
    capabilities,
    backupPolicy: trustedGameModules.get(mapping.game_id)?.manifest.backupPolicy ?? {
      offline: 'required' as const,
    },
    backupLimit: mapping.feature_limits.backups,
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
      stop: operate && idle && configured && installed && row.runtime_state !== 'offline',
      kill:
        operate &&
        configured &&
        installed &&
        activeStop?.action === 'stop' &&
        activeStop.phase === 'power' &&
        hasStopProcessBaseline(activeStop.plan) &&
        !!activeStop.effect_started_at &&
        (!stopEscalation(activeStop.policy_snapshot) ||
          stopEscalation(activeStop.policy_snapshot)?.state === 'rejected'),
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
export async function getPlatformServer(
  db: DB,
  context: AuthContext,
  serverId: string,
  env: Environment = {},
) {
  const server = await scopedServer(db, context, serverId);
  return describeServer(db, context, server, await configuredGatewayWake(db, env));
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
  return getPlatformServer(db, context, serverId, env);
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

/** Reuse the worker's filesystem samples; nodes on one host share one disk reading. */
async function sharedStorageAvailableBytes(db: DB, env: Environment): Promise<number | null> {
  const hosts = await db
    .selectFrom('physical_hosts as h')
    .selectAll('h')
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('managed_nodes as n')
          .select('n.id')
          .whereRef('n.physical_host_id', '=', 'h.id')
          .where('n.enabled', '=', true),
      ),
    )
    .execute();
  const activeHosts = hosts.filter((host) => resolveHostOverride(host, env).enabled);
  if (!activeHosts.length) return null;
  const samples = await Promise.all(
    activeHosts.map(async ({ id }) => {
      try {
        const { snapshot } = await checkedObservation(db, id, env);
        return Math.floor(snapshot.availableDiskMiB * 1048576);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'resources_unavailable') return null;
        throw error;
      }
    }),
  );
  if (samples.some((bytes) => bytes === null)) return null;
  const total = samples.reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0);
  return Number.isSafeInteger(total) ? total : null;
}

export async function getPlatformQuota(
  db: DB,
  context: AuthContext,
  userId = context.subjectUserId,
  env: Environment = {},
) {
  assertAuthContext(context);
  if (userId !== context.subjectUserId) ownerOnly(context);
  const [settings, override, reservations, servers, metrics, storageOverride] = await Promise.all([
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
    db
      .selectFrom('storage_user_budgets')
      .select('storage_mib')
      .where('user_id', '=', userId)
      .executeTakeFirst(),
  ]);
  const { values } = settings,
    effective =
      override && (!override.expires_at || override.expires_at > new Date()) ? override : null;
  const storageBudgetMiB = Number(
    storageOverride
      ? (storageOverride.storage_mib ?? values.defaultUserStorageMiB)
      : (effective?.storage_mib ?? values.defaultUserStorageMiB),
  );
  const limits = {
    memoryMiB: effective?.memory_mib ?? values.defaultUserMemoryMiB,
    cpuPercent: effective?.cpu_percent ?? values.defaultUserCpuPercent,
    storageMiB:
      values.storagePolicy === 'PER_USER_BUDGET' && storageBudgetMiB > 0 ? storageBudgetMiB : null,
    serverCount: values.maxServersPerUser,
  };
  const committed = {
    memoryMiB: reservations.reduce((n, r) => n + r.memory_mib, 0),
    cpuPercent: reservations.reduce((n, r) => n + r.cpu_percent, 0),
    storageMiB: servers.reduce(
      (n, r) =>
        n +
        (r.limits.disk ||
          Math.ceil(Number(metrics.find((m) => m.server_id === r.id)?.disk_bytes ?? 0) / 1048576)) *
          (1 + r.feature_limits.backups),
      0,
    ),
    serverCount: servers.length,
  };
  // Home telemetry has the same 30-second display lifetime as server cards.
  // Admission and measured.stale retain their separate, stricter safety lifetime.
  const displayNow = Date.now();
  const displayLifetimeMs = 30_000;
  const samples = new Map(metrics.map((metric) => [metric.server_id, metric]));
  let usageBytes = 0;
  let oldestObservation: number | null = null;
  let completeUsage = true;
  for (const server of servers) {
    const metric = samples.get(server.id);
    const bytes = Number(metric?.disk_bytes);
    const at = metric?.observed_at.getTime();
    if (
      !metric ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      at === undefined ||
      !Number.isFinite(at) ||
      at > displayNow ||
      displayNow - at >= displayLifetimeMs ||
      !Number.isSafeInteger(usageBytes + bytes)
    ) {
      completeUsage = false;
      break;
    }
    usageBytes += bytes;
    oldestObservation = oldestObservation === null ? at : Math.min(oldestObservation, at);
  }
  const storageUsage = {
    bytes: completeUsage ? usageBytes : null,
    expiresAt:
      completeUsage && oldestObservation !== null
        ? new Date(oldestObservation + displayLifetimeMs).toISOString()
        : null,
  };
  return {
    userId,
    storageBudgetMiB,
    storagePolicy: values.storagePolicy,
    sharedStorageAvailableBytes:
      limits.storageMiB === null ? await sharedStorageAvailableBytes(db, env) : null,
    creationStorage: {
      mode: limits.storageMiB === null ? 'shared' : 'limited',
      defaultDiskMiB: limits.storageMiB === null ? 0 : values.defaultServerStorageMiB,
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
    storageBudgetOverrideMiB:
      storageOverride?.storage_mib === null || !storageOverride
        ? null
        : Number(storageOverride.storage_mib),
    storageUsage,
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
  return listUnifiedActivity(db, context, input);
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
const publicFileTransferSchema = z
  .object({
    completedFiles: z.number().int().nonnegative(),
    totalFiles: z.number().int().positive(),
    completedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  })
  .refine(
    (value) => value.completedFiles <= value.totalFiles && value.completedBytes <= value.totalBytes,
  );

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
  const operation = job.serverId
    ? await db
        .selectFrom('server_operations')
        .select('plan')
        .where('job_id', '=', jobId)
        .executeTakeFirst()
    : undefined;
  const backupPlan = ['backup', 'restore'].includes(job.action ?? '') ? operation?.plan : undefined;
  // Only confirmed counters are public; staging identities, source paths and
  // integrity digests stay in the protected operation plan.
  const fileTransfer = publicFileTransferSchema.safeParse(operation?.plan.fileTransfer);
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
    ...(fileTransfer.success ? { fileTransfer: fileTransfer.data } : {}),
    backupResult: backupPlan
      ? {
          state:
            backupPlan.backupComplete === true
              ? 'succeeded'
              : backupPlan.backupFailed === true
                ? 'failed'
                : 'pending',
          resume: ['pending', 'succeeded', 'failed', 'suppressed'].includes(
            String(backupPlan.backupResumeOutcome),
          )
            ? String(backupPlan.backupResumeOutcome)
            : null,
          cleanupFailed:
            typeof backupPlan.backupCleanupError === 'string' &&
            backupPlan.backupCleanupComplete !== true,
          retentionFailed: typeof backupPlan.backupRetentionError === 'string',
        }
      : null,
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
  const [settings, mapping, allocations, routes, assignments, preference] = await Promise.all([
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
      .select(['id', 'hostname', 'state', 'plan'])
      .where('server_id', '=', serverId)
      .where('state', '!=', 'deleted')
      .orderBy('updated_at', 'desc')
      .execute(),
    db
      .selectFrom('server_dns_preferences')
      .select(['assignment_id', 'enabled'])
      .where('server_id', '=', serverId)
      .executeTakeFirst(),
  ]);
  const manifest = gameManifestSchema.safeParse(mapping.manifest),
    connection = manifest.success ? manifest.data.connection : null;
  const assignment =
    assignments.find((a) => a.id === preference?.assignment_id) ??
    assignments.find((a) => a.state === 'active') ??
    assignments[0];
  const intent = assignment?.plan as
    | {
        connection?: {
          hostname: string;
          port: number;
          displayAddress: string;
          records: Array<{ type: string; data?: { port: number } }>;
        };
        confirmedConnection?: {
          hostname: string;
          port: number;
          displayAddress: string;
          records: Array<{ type: string; data?: { port: number } }>;
        };
      }
    | undefined;
  const confirmed =
    assignment?.state === 'active' ? intent?.connection : intent?.confirmedConnection;
  const dnsAddress = connection?.mode === 'custom-subdomain' || connection?.mode === 'shared-host';
  const primaryAllocation = allocations.find((allocation) => allocation.is_primary);
  const primaryTransport =
    (connection?.mode === 'custom-subdomain' ? connection.srv?.proto : undefined) ??
    primaryAllocation?.protocols[0];
  const primaryPublicHost =
    server.connection_mode === 'direct'
      ? primaryAllocation?.direct_endpoint?.hostname
      : routes.find(
          (route) =>
            route.allocation_id === primaryAllocation?.id &&
            route.transport === primaryTransport &&
            (!confirmed || route.public_port === confirmed.port),
        )?.public_address;
  const confirmedHostFor = (publicHost: string | undefined) =>
    publicHost && publicHost === primaryPublicHost ? (confirmed?.hostname ?? null) : null;
  const hostname =
    confirmed?.hostname ??
    (dnsAddress
      ? undefined
      : server.connection_mode === 'direct'
        ? allocations.find((a) => a.is_primary)?.direct_endpoint?.hostname
        : connection?.mode === 'static-host-port'
          ? (settings.values as unknown as Record<string, string>)[connection.hostnameSettingKey]
          : undefined);
  const display = (
    host: string | null,
    port: number | null,
    primary: boolean,
    transport: string,
  ) => {
    if (!host || !port) return null;
    const srv = connection?.mode === 'custom-subdomain' ? connection.srv : undefined;
    return primary &&
      confirmed?.hostname === host &&
      confirmed.port === port &&
      srv?.proto === transport &&
      confirmed.records.some((r) => r.type === 'SRV' && r.data?.port === port)
      ? host
      : `${host.includes(':') ? `[${host}]` : host}:${port}`;
  };
  return {
    mode: connection?.mode ?? null,
    connectionMode: server.connection_mode,
    addressState: assignment?.state ?? (preference?.enabled ? 'pending' : 'unconfigured'),
    primaryDnsAssignmentId: assignment?.id ?? null,
    reachability: server.connection_mode === 'direct' ? ('unverified' as const) : null,
    hostname: hostname ?? null,
    srv: connection?.mode === 'custom-subdomain' ? (connection.srv ?? null) : null,
    dns: assignments.map(({ id, state, plan }) => ({
      id,
      state,
      hostname: (plan as { connection?: { hostname?: string } }).connection?.hostname ?? null,
    })),
    ports: allocations.flatMap((allocation) =>
      allocation.protocols.map((transport) => {
        if (server.connection_mode === 'direct') {
          const endpoint = allocation.direct_endpoint;
          const publicHostname = dnsAddress
            ? confirmedHostFor(endpoint?.hostname)
            : allocation.is_primary
              ? (hostname ?? endpoint?.hostname ?? null)
              : (endpoint?.hostname ?? null);
          return {
            role: allocation.role,
            primary: allocation.is_primary,
            transport,
            port: endpoint?.port ?? null,
            hostname: publicHostname,
            displayAddress: display(
              publicHostname,
              endpoint?.port ?? null,
              allocation.is_primary,
              transport,
            ),
            status: endpoint ? ('configured' as const) : ('unconfigured' as const),
          };
        }
        const route = routes.find(
          (r) => r.allocation_id === allocation.id && r.transport === transport,
        );
        const publicHostname = !route
          ? null
          : dnsAddress
            ? confirmedHostFor(route.public_address)
            : allocation.is_primary
              ? (hostname ?? route.public_address)
              : route.public_address;
        return {
          role: allocation.role,
          primary: allocation.is_primary,
          transport,
          port: route?.public_port ?? null,
          hostname: publicHostname,
          displayAddress: display(
            publicHostname,
            route?.public_port ?? null,
            allocation.is_primary,
            transport,
          ),
          status: !route
            ? ('unconfigured' as const)
            : !route.enabled
              ? ('disabled' as const)
              : !route.lease_expires_at || route.lease_expires_at <= new Date()
                ? ('unavailable' as const)
                : // A snapshot lease is issued before the Gateway's live bind checks.
                  // It proves configuration delivery, not a listening/reachable endpoint.
                  ('configured' as const),
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
  const [host, settings, secrets, info, pending, providerAccount] = await Promise.all([
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
    db
      .selectFrom('provider_accounts as account')
      .innerJoin('provider_change_feeds as feed', 'feed.instance_id', 'account.instance_id')
      .select(['account.status', 'account.provider_id', 'account.provider_url'])
      .where('feed.enabled', '=', true)
      .whereRef('feed.provider_url', '=', 'account.provider_url')
      .where('account.user_id', '=', server.owner_id)
      .executeTakeFirst(),
  ]);
  const policy = effectiveUploadPolicy(host, env),
    configured =
      providerAccount?.status === 'ready' &&
      providerAccount.provider_id === server.provider_user_id &&
      providerAccount.provider_url === settings.values.pterodactylBaseUrl?.replace(/\/$/, '');
  const reason = !info.permissions.manage
    ? 'forbidden'
    : server.active_operation_id || pending
      ? 'conflict'
      : !configured
        ? 'provider_account_unavailable'
        : !policy
          ? 'upload_policy_missing'
          : host.observer_id !== env.NH_OBSERVER_ID
            ? 'upload_observer_unavailable'
            : !info.availableActions.files
              ? 'integration_unavailable'
              : null;
  return {
    files: info.capabilities?.files === true,
    textEditMaxCharacters: 1048576,
    textEditMaxBytes: 1048576,
    upload: {
      available: reason === null,
      reason,
      providerMaxFileBytes: policy?.providerMaxFileBytes ?? null,
      serverDiskBytes: serverStorageLimitBytes(server.limits.disk),
      concurrency: settings.values.uploadConcurrency,
      batchMaxFiles: 500,
      batchMaxBytes: policy
        ? Math.max(
            0,
            Math.min(
              serverStorageLimitBytes(server.limits.disk) ?? Number.MAX_SAFE_INTEGER,
              Math.floor(
                (policy.temporaryDiskBudgetBytes - 65536 * settings.values.uploadConcurrency) / 2,
              ),
            ),
          )
        : null,
      streaming: true,
    },
    download: {
      available: configured && info.availableActions.files,
      streaming: true,
      totalSizeLimitBytes: null,
    },
    sftp: {
      auxiliaryLimit: settings.values.sftpAuxiliaryLimit,
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
      limit: info.backupLimit,
      policy: info.backupPolicy,
      events: await providerBackupEventsEnabled(db, serverId),
      canCreate: info.availableActions.backup && (await backupSchemaAvailable(db)),
      canRestore:
        info.permissions.manage &&
        (await backupSchemaAvailable(db)) &&
        !server.active_operation_id &&
        server.runtime_state === 'offline',
    },
  };
}

export async function getPlatformSleepPolicy(
  db: DB,
  context: AuthContext,
  serverId: string,
  env: Environment = {},
) {
  const server = await scopedServer(db, context, serverId),
    state = await db
      .selectFrom('gateway_server_states')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
  const unavailable = {
    policy: null,
    state: null,
    proposedPolicy: null,
    idleTimeout: null,
    policyControlsEditable: false,
  };
  if (server.connection_mode === 'direct') return unavailable;
  if (!state) {
    if (
      !server.pterodactyl_uuid ||
      !server.pterodactyl_id ||
      server.installation_state !== 'installed' ||
      server.active_operation_id
    )
      return unavailable;
    const mapping = await db
      .selectFrom('runtime_egg_mappings')
      .select(['game_id'])
      .where('id', '=', server.mapping_id)
      .executeTakeFirstOrThrow();
    const module = trustedGameModules.get(mapping.game_id);
    if (!module?.manifest.capabilities.readiness) return unavailable;
    const binding = await module.gatewayPolicyBinding?.(db, server, env);
    if (!binding) return unavailable;
    const proposedPolicy: GatewayPolicy = gatewayPolicySchema.parse({
      ...binding,
      enabled: false,
      idleTimeoutSeconds: null,
      idleTimeoutInherited: true,
      readinessTimeoutSeconds: 600,
      readinessMaxAgeSeconds: 30,
      estimateMaxAgeSeconds: 604800,
      wakeRetrySeconds: 10,
      mode: server.intent === 'maintenance' ? 'maintenance' : 'manually_stopped',
    });
    const idleTimeout = await publicIdleTimeout(db, serverId, null, context, env);
    if (idleTimeout === null) {
      delete proposedPolicy.idleTimeoutSeconds;
      delete proposedPolicy.idleTimeoutInherited;
    }
    return { ...unavailable, proposedPolicy, idleTimeout };
  }
  const idleTimeout = await publicIdleTimeout(db, serverId, state, context, env);
  const effectiveIdle = await resolveIdleTimeout(db, serverId, state, env);
  return {
    policy: {
      enabled: state.enabled,
      protocolId: state.protocol_id,
      gameVersion: state.game_version,
      ...(idleTimeout === null
        ? {}
        : {
            idleTimeoutSeconds:
              context.role === 'owner' && context.sessionType === 'regular'
                ? state.owner_idle_timeout_seconds === -1
                  ? null
                  : state.owner_idle_timeout_seconds
                : state.idle_timeout_seconds,
            idleTimeoutInherited:
              context.role === 'owner' && context.sessionType === 'regular'
                ? state.owner_idle_timeout_seconds === null
                : state.idle_timeout_inherited,
          }),
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
    idleTimeout,
    policyControlsEditable:
      (context.role === 'owner' && context.sessionType === 'regular') ||
      effectiveIdle.ownerBaselineSeconds === -1 ||
      effectiveIdle.userAccess === 'editable',
    state: await getGatewayState(db, serverId, { env }),
    proposedPolicy: null,
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
